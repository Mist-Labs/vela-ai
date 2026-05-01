/**
 * agent.ts
 *
 * VelaAgent — the full trading loop.
 *
 * Every iteration:
 *   1. fetchMarketData()          — read pool state from Uniswap v4
 *   2. callSealedInference()      — get TEE-attested decision from 0G Compute
 *   3. uploadDecisionRecord()     — store decision + attestation on 0G DA
 *   4. commitDecision()           — commit hash + CID on-chain (VelaVault)
 *   5. executeTrade()             — swap through VelaHook (Hook enforces policy)
 *   6. verifyAndSettle()          — verify enclave signature on-chain
 *
 * The Hook enforces policy at step 5. The attestation contract verifies
 * TEE integrity at step 6. The watchtower monitors 0G DA continuously
 * in the background and triggers circuit break on any integrity failure.
 */

import "dotenv/config";
import { ethers } from "ethers";
import { createZeroGStorageClient, type DecisionRecord } from "./zero-g.js";
import {
  createZeroGComputeClient,
  type MarketData,
  type PolicyConstraints,
  type ZeroGComputeClient,
} from "./zero-g-compute.js";

// ─────────────────────────────── ABI stubs ───────────────────────────────────

const VAULT_ABI = [
  "function commitDecision(bytes32 decisionHash, string calldata explanation, string calldata evidenceCID) external returns (uint256)",
  "function getDecisionHash(uint256 decisionId) external view returns (bytes32)",
  "function trustedHook() external view returns (address)",
  "function executeHookSwap((tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bool zeroForOne,uint256 amountIn,uint256 minAmountOut,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut)",
  "event DecisionCommitted(uint256 indexed id, bytes32 decisionHash, string explanation, string evidenceCID)",
  "event HookSwapExecuted(bytes32 indexed poolId, address indexed agent, bool zeroForOne, uint256 amountIn, uint256 amountOut, address hook)",
];

const ATTESTATION_ABI = [
  "function verifyAndSettle(address vault, uint256 decisionId, bytes32 contentHash, bytes calldata sig) external",
];

const POLICY_REGISTRY_ABI = [
  "function isActive(address agent) external view returns (bool)",
  "function getPolicy(address agent) external view returns (tuple(address owner, address operator, bytes32 policyRoot, string policyURI, uint8 tier, uint256 maxValuePerTxUsdc, uint8 activeHoursStartUtc, uint8 activeHoursEndUtc, uint256 totalDecisions, uint256 compliantDecisions, uint256 complianceScore, bool active, bool circuitBreaker))",
];

const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
];

// ─────────────────────────────── constants ───────────────────────────────────

/** Polling interval between agent loop iterations (ms). */
const LOOP_INTERVAL_MS = 30_000;

/** Minimum time between trades to avoid spamming (ms). */
const MIN_TRADE_INTERVAL_MS = 60_000;
const MIN_SQRT_PRICE_PLUS_ONE = 4_295_128_739n;
const MAX_SQRT_PRICE_MINUS_ONE =
  1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n;

// ─────────────────────────────── helpers ─────────────────────────────────────

/**
 * Convert Uniswap v4 sqrtPriceX96 to a human-readable USDC price per ETH.
 * Formula: price = (sqrtPriceX96 / 2^96)^2
 * Adjusts for token decimals: USDC=6, WETH=18.
 */
function sqrtPriceX96ToUsdc(sqrtPriceX96: bigint): number {
  const Q96 = 2n ** 96n;
  const price = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 12n) / (Q96 * Q96);
  return Number(price) / 1e6;
}

function envAddress(name: string): string {
  const value = process.env[name];
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${name} must be a valid address`);
  }
  return ethers.getAddress(value);
}

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function unitsFromNumber(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid positive amount: ${value}`);
  }
  return ethers.parseUnits(value.toFixed(decimals), decimals);
}

function computePoolId(config: HookPoolConfig): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint24", "int24", "address"],
    [
      config.currency0,
      config.currency1,
      config.fee,
      config.tickSpacing,
      config.hooks,
    ],
  );
  return ethers.keccak256(encoded);
}

type HookPoolConfig = {
  name: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  zeroForOne: boolean;
  token0Decimals: number;
  token1Decimals: number;
  poolId: string;
};

// ─────────────────────────────── VelaAgent ───────────────────────────────────

export class VelaAgent {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly signer: ethers.Wallet;
  private readonly vault: ethers.Contract;
  private readonly attestation: ethers.Contract;
  private readonly registry: ethers.Contract;
  private readonly stateView: ethers.Contract;

  private readonly agentAddress: string;
  private readonly vaultAddress: string;
  private readonly pool: HookPoolConfig;
  private readonly slippageBps: number;

  private computeClient: ZeroGComputeClient | null = null;
  private storageClient: ReturnType<typeof createZeroGStorageClient> | null =
    null;

  private lastTradeTimestamp: number = 0;
  private running: boolean = false;

  constructor() {
    const rpcUrl = process.env.RPC_URL!;
    const privateKey = process.env.PRIVATE_KEY!;
    const vaultAddress = process.env.VELA_VAULT_ADDRESS!;
    const attestationAddress = process.env.ATTESTATION_CONTRACT_ADDRESS!;
    const registryAddress = process.env.POLICY_REGISTRY_ADDRESS!;
    const stateViewAddress = process.env.STATE_VIEW_ADDRESS!;

    for (const [k, v] of Object.entries({
      RPC_URL: rpcUrl,
      PRIVATE_KEY: privateKey,
      VELA_VAULT_ADDRESS: vaultAddress,
      ATTESTATION_CONTRACT_ADDRESS: attestationAddress,
      POLICY_REGISTRY_ADDRESS: registryAddress,
      STATE_VIEW_ADDRESS: stateViewAddress,
    })) {
      if (!v) throw new Error(`Missing required env var: ${k}`);
    }

    const hookAddress = envAddress("VELA_HOOK_ADDRESS");
    this.pool = {
      name: process.env.ACTIVE_POOL_NAME ?? "ETH/USDC v4",
      currency0: envAddress("ACTIVE_POOL_CURRENCY0"),
      currency1: envAddress("ACTIVE_POOL_CURRENCY1"),
      fee: envInt("ACTIVE_POOL_FEE", 3000),
      tickSpacing: envInt("ACTIVE_POOL_TICK_SPACING", 60),
      hooks: hookAddress,
      zeroForOne:
        (process.env.ACTIVE_POOL_ZERO_FOR_ONE ?? "false").toLowerCase() ===
        "true",
      token0Decimals: envInt("ACTIVE_POOL_TOKEN0_DECIMALS", 18),
      token1Decimals: envInt("ACTIVE_POOL_TOKEN1_DECIMALS", 6),
      poolId: "",
    };
    this.pool.poolId = process.env.ACTIVE_POOL_ID || computePoolId(this.pool);
    this.slippageBps = envInt("TRADE_SLIPPAGE_BPS", 100);

    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.signer = new ethers.Wallet(privateKey, this.provider);
    this.agentAddress = this.signer.address;
    this.vaultAddress = vaultAddress;

    this.vault = new ethers.Contract(vaultAddress, VAULT_ABI, this.signer);
    this.attestation = new ethers.Contract(
      attestationAddress,
      ATTESTATION_ABI,
      this.signer,
    );
    this.registry = new ethers.Contract(
      registryAddress,
      POLICY_REGISTRY_ABI,
      this.signer,
    );
    this.stateView = new ethers.Contract(
      stateViewAddress,
      STATE_VIEW_ABI,
      this.provider,
    );
  }

  // ── startup ──────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  VelaAgent starting up");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  Agent:  ${this.agentAddress}`);
    console.log(`  Vault:  ${this.vaultAddress}`);
    console.log(`  Pool:   ${this.pool.name} (${this.pool.poolId})`);

    // Verify agent is active in registry.
    const isActive = await this.registry.isActive(this.agentAddress);
    if (!isActive) {
      throw new Error(
        "Agent is not active in PolicyRegistry. " +
          "Run PolicyRegistry.registerAgent() first.",
      );
    }
    console.log("  Policy: active ✓");

    const trustedHook = await this.vault.trustedHook();
    if (trustedHook.toLowerCase() !== this.pool.hooks.toLowerCase()) {
      throw new Error(
        `Vault trustedHook (${trustedHook}) does not match ACTIVE pool hook (${this.pool.hooks}). ` +
          "Set VelaVault.setTrustedHook(VELA_HOOK_ADDRESS) before starting the agent.",
      );
    }
    console.log("  VelaHook: trusted ✓");

    // Initialise 0G clients.
    this.storageClient = createZeroGStorageClient(this.signer);
    this.computeClient = await createZeroGComputeClient(this.signer);

    console.log("  0G DA:      connected ✓");
    console.log("  0G Compute: connected ✓");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  }

  // ── main loop ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.running = true;
    console.log(
      `[Agent] Loop started — interval: ${LOOP_INTERVAL_MS / 1000}s\n`,
    );

    while (this.running) {
      try {
        await this._runIteration();
      } catch (err) {
        console.error("[Agent] Iteration error:", err);
        // Don't stop on error — log and continue.
      }

      await this._sleep(LOOP_INTERVAL_MS);
    }
  }

  stop(): void {
    this.running = false;
    console.log("[Agent] Loop stopped.");
  }

  // ── single iteration ─────────────────────────────────────────────────────────

  private async _runIteration(): Promise<void> {
    const iterationId = Date.now();
    console.log(`[Agent] ── iteration ${iterationId} ──`);

    // 1. Fetch on-chain policy constraints.
    const constraints = await this._fetchPolicyConstraints();

    // 2. Fetch market data from Uniswap v4.
    const market = await this._fetchMarketData();

    // 3. Request TEE-attested decision from 0G Sealed Inference.
    console.log("[Agent] [3/6] Requesting decision from 0G Sealed Inference…");
    const inferenceResult = await this.computeClient!.requestDecision(
      market,
      constraints,
    );

    console.log(
      `[Agent]       Decision: ${inferenceResult.decision.action.toUpperCase()} ` +
        `$${inferenceResult.decision.value_usdc.toLocaleString()} USDC — ` +
        inferenceResult.decision.reason,
    );

    // If hold, nothing to do this iteration.
    if (inferenceResult.decision.action === "hold") {
      console.log("[Agent]       Holding — no trade this iteration.\n");
      return;
    }

    // Rate-limit trades.
    const now = Date.now();
    if (now - this.lastTradeTimestamp < MIN_TRADE_INTERVAL_MS) {
      console.log("[Agent]       Trade rate-limited — skipping.\n");
      return;
    }

    // 4. Build and upload decision record to 0G DA.
    console.log("[Agent] [4/6] Uploading decision record to 0G DA…");
    const record: DecisionRecord = {
      signed_payload: inferenceResult.rawResponse,
      decision: inferenceResult.decision,
      policy_root: constraints.policyRoot,
      constraints_evaluated: {
        value_check: `${inferenceResult.decision.value_usdc <= constraints.maxValuePerTxUsdc ? "PASS" : "FAIL"} -- ${inferenceResult.decision.value_usdc} vs ${constraints.maxValuePerTxUsdc}`,
        pool_check: `${constraints.allowedPools.includes(inferenceResult.decision.pool) ? "PASS" : "FAIL"} -- ${inferenceResult.decision.pool}`,
        hours_check: this._checkActiveHours(constraints) ? "PASS" : "FAIL",
      },
      tee_attestation: inferenceResult.teeAttestation,
      agent: this.agentAddress,
      vault: this.vaultAddress,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const { rootHash, contentHash } =
      await this.storageClient!.uploadDecisionRecord(record);
    console.log(`[Agent]       0G DA CID:     ${rootHash}`);
    console.log(`[Agent]       Content hash:  ${contentHash}`);

    // 5. Commit decision on-chain.
    console.log("[Agent] [5/6] Committing decision on-chain…");
    const commitTx = await this.vault.commitDecision(
      contentHash,
      inferenceResult.decision.reason,
      rootHash,
    );
    const commitReceipt = await commitTx.wait();
    const decisionId = this._parseDecisionId(commitReceipt);
    console.log(
      `[Agent]       Decision ID: ${decisionId}  TX: ${commitReceipt.hash}`,
    );

    // 6. Execute trade through VelaHook.
    // Hook enforces policy at beforeSwap() — reverts if any constraint violated.
    console.log("[Agent] [6/6] Executing trade through Uniswap v4 Hook…");
    await this._executeTrade(inferenceResult.decision, constraints);
    this.lastTradeTimestamp = Date.now();
    console.log("[Agent]       Trade executed ✓");

    // 7. Verify and settle TEE attestation on-chain (background — non-blocking).
    this._settleAsync(
      decisionId,
      contentHash,
      inferenceResult.teeAttestation.signature,
    );

    console.log(`[Agent] ── iteration complete ──\n`);
  }

  // ── step implementations ─────────────────────────────────────────────────────

  private async _fetchPolicyConstraints(): Promise<
    PolicyConstraints & { policyRoot: string }
  > {
    console.log("[Agent] [1/6] Fetching policy constraints…");
    const policy = await this.registry.getPolicy(this.agentAddress);

    let maxAllocationPerPool = 10_000;
    let stopLossBps = 1_500;
    let allowedPools: string[] = [this.pool.name];

    // Decode stored constraints from policyURI (0G DA CID or HTTP URL)
    const policyUri: string = policy.policyURI ?? "";
    if (policyUri) {
      try {
        let raw: Uint8Array;
        if (
          policyUri.startsWith("http://") ||
          policyUri.startsWith("https://")
        ) {
          const res = await fetch(policyUri);
          raw = new Uint8Array(await res.arrayBuffer());
        } else if (this.storageClient) {
          raw = await this.storageClient.fetchRaw(policyUri);
        } else {
          throw new Error("no storage client for non-HTTP policyURI");
        }
        const decoded = JSON.parse(new TextDecoder().decode(raw)) as {
          constraints?: {
            max_allocation_per_pool_bps?: number;
            stop_loss_bps?: number;
            allowed_pools?: string[];
          };
        };
        const c = decoded.constraints;
        if (c) {
          if (typeof c.max_allocation_per_pool_bps === "number") {
            maxAllocationPerPool = c.max_allocation_per_pool_bps;
          }
          if (typeof c.stop_loss_bps === "number") {
            stopLossBps = c.stop_loss_bps;
          }
          if (Array.isArray(c.allowed_pools) && c.allowed_pools.length > 0) {
            allowedPools = c.allowed_pools;
          }
        }
        console.log("[Agent]       Constraints decoded from policyURI ✓");
      } catch (err) {
        console.warn(
          "[Agent]       Failed to decode policyURI constraints, using safe defaults:",
          err,
        );
      }
    }

    return {
      policyRoot: policy.policyRoot,
      maxValuePerTxUsdc: Number(policy.maxValuePerTxUsdc),
      maxAllocationPerPool,
      stopLossBps,
      activeHoursStartUtc: Number(policy.activeHoursStartUtc),
      activeHoursEndUtc: Number(policy.activeHoursEndUtc),
      allowedPools,
    };
  }

  private async _fetchMarketData(): Promise<MarketData> {
    console.log("[Agent] [2/6] Fetching market data from Uniswap v4…");

    const [sqrtPriceX96] = await this.stateView.getSlot0(this.pool.poolId);
    const priceUsdc = sqrtPriceX96ToUsdc(sqrtPriceX96);

    let currentApy = 0;
    let tvlUsdc = 0;
    let volume24hUsdc = 0;

    const subgraphUrl = process.env.UNISWAP_V4_SUBGRAPH_URL;
    if (subgraphUrl) {
      try {
        const poolIdHex = this.pool.poolId.toLowerCase();
        const query = `{
        pool(id: "${poolIdHex}") {
          totalValueLockedUSD
          volumeUSD
          feesUSD
          poolDayData(first: 1, orderBy: date, orderDirection: desc) {
            volumeUSD
            feesUSD
            tvlUSD
          }
        }
      }`;
        const res = await fetch(subgraphUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        });
        const json = (await res.json()) as {
          data?: {
            pool?: {
              totalValueLockedUSD?: string;
              poolDayData?: Array<{
                volumeUSD?: string;
                feesUSD?: string;
                tvlUSD?: string;
              }>;
            };
          };
        };
        const pool = json.data?.pool;
        if (pool) {
          tvlUsdc = parseFloat(pool.totalValueLockedUSD ?? "0");
          const day = pool.poolDayData?.[0];
          if (day) {
            volume24hUsdc = parseFloat(day.volumeUSD ?? "0");
            const feesDay = parseFloat(day.feesUSD ?? "0");
            const tvlDay = parseFloat(day.tvlUSD ?? "0");
            // Annualise: APY ≈ (daily fees / TVL) * 365 * 100
            if (tvlDay > 0) {
              currentApy = (feesDay / tvlDay) * 365 * 100;
            }
          }
        }
        console.log(
          `[Agent]       Market: price=$${priceUsdc.toFixed(2)} tvl=$${tvlUsdc.toLocaleString()} vol24h=$${volume24hUsdc.toLocaleString()} apy=${currentApy.toFixed(2)}%`,
        );
      } catch (err) {
        console.warn(
          "[Agent]       Subgraph fetch failed, using on-chain price only:",
          err,
        );
      }
    } else {
      console.warn(
        "[Agent]       UNISWAP_V4_SUBGRAPH_URL not set — APY/TVL/volume will be 0",
      );
    }

    return {
      poolId: this.pool.poolId,
      poolName: this.pool.name,
      currentApy,
      sqrtPriceX96: sqrtPriceX96.toString(),
      priceUsdc,
      tvlUsdc,
      volume24hUsdc,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  private async _executeTrade(
    decision: { action: string; value_usdc: number; pool: string },
    _constraints: PolicyConstraints,
  ): Promise<void> {
    if (decision.pool !== this.pool.name) {
      throw new Error(
        `Decision requested ${decision.pool}; only ${this.pool.name} is configured.`,
      );
    }
    if (decision.action !== "swap" && decision.action !== "rebalance") {
      throw new Error(`Unsupported executable action: ${decision.action}`);
    }

    const [sqrtPriceX96] = await this.stateView.getSlot0(this.pool.poolId);
    const priceUsdc = sqrtPriceX96ToUsdc(sqrtPriceX96);
    const amountIn = this._decisionValueToAmountIn(
      decision.value_usdc,
      priceUsdc,
    );
    const minAmountOut = this._estimateMinAmountOut(
      decision.value_usdc,
      priceUsdc,
    );
    const sqrtPriceLimitX96 = this.pool.zeroForOne
      ? MIN_SQRT_PRICE_PLUS_ONE
      : MAX_SQRT_PRICE_MINUS_ONE;

    console.log(
      `[Agent]       Executing ${decision.action} through VelaHook only: ` +
        `${amountIn.toString()} input units, minOut ${minAmountOut.toString()}`,
    );

    const tx = await this.vault.executeHookSwap({
      key: {
        currency0: this.pool.currency0,
        currency1: this.pool.currency1,
        fee: this.pool.fee,
        tickSpacing: this.pool.tickSpacing,
        hooks: this.pool.hooks,
      },
      zeroForOne: this.pool.zeroForOne,
      amountIn,
      minAmountOut,
      sqrtPriceLimitX96,
    });
    const receipt = await tx.wait();
    console.log(`[Agent]       Hook swap TX: ${receipt.hash}`);
  }

  /**
   * Submit TEE attestation verification in the background.
   * Non-blocking — does not delay the trade loop.
   */
  private _settleAsync(
    decisionId: bigint,
    contentHash: string,
    enclaveSignature: string,
  ): void {
    (async () => {
      try {
        const tx = await this.attestation.verifyAndSettle(
          this.vaultAddress,
          decisionId,
          contentHash,
          enclaveSignature,
        );
        await tx.wait();
        console.log(
          `[Agent] [Settle] Decision ${decisionId} attested on-chain ✓`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[Agent] [Settle] Attestation pending for decision ${decisionId}: ${msg}`,
        );
      }
    })();
  }

  // ── utilities ────────────────────────────────────────────────────────────────

  private _checkActiveHours(constraints: PolicyConstraints): boolean {
    const hourUtc = new Date().getUTCHours();
    return (
      hourUtc >= constraints.activeHoursStartUtc &&
      hourUtc < constraints.activeHoursEndUtc
    );
  }

  private _parseDecisionId(receipt: ethers.TransactionReceipt): bigint {
    const iface = new ethers.Interface(VAULT_ABI);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "DecisionCommitted") {
          return parsed.args.id as bigint;
        }
      } catch {
        // skip
      }
    }
    throw new Error("DecisionCommitted event not found in receipt");
  }

  private _decisionValueToAmountIn(
    valueUsdc: number,
    priceUsdc: number,
  ): bigint {
    if (this.pool.zeroForOne) {
      const token0Amount = valueUsdc / priceUsdc;
      return unitsFromNumber(token0Amount, this.pool.token0Decimals);
    }
    return unitsFromNumber(valueUsdc, this.pool.token1Decimals);
  }

  private _estimateMinAmountOut(valueUsdc: number, priceUsdc: number): bigint {
    const keepBps = 10_000 - this.slippageBps;
    if (this.pool.zeroForOne) {
      const rawOut = unitsFromNumber(valueUsdc, this.pool.token1Decimals);
      return (rawOut * BigInt(keepBps)) / 10_000n;
    }
    const token0Amount = valueUsdc / priceUsdc;
    const rawOut = unitsFromNumber(token0Amount, this.pool.token0Decimals);
    return (rawOut * BigInt(keepBps)) / 10_000n;
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─────────────────────────────── entrypoint ──────────────────────────────────

async function main() {
  const agent = new VelaAgent();
  await agent.init();

  // Graceful shutdown.
  process.on("SIGINT", () => {
    agent.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    agent.stop();
    process.exit(0);
  });

  await agent.start();
}

main().catch((err) => {
  console.error("[Agent] Fatal error:", err);
  process.exit(1);
});
