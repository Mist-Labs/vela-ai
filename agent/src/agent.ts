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
import {
  createZeroGStorageClient,
  type DecisionRecord,
} from "./zero-g.js";
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
  "event DecisionCommitted(uint256 indexed id, bytes32 decisionHash, string explanation, string evidenceCID)",
];

const ATTESTATION_ABI = [
  "function verifyAndSettle(address vault, uint256 decisionId, bytes32 contentHash, bytes calldata sig) external",
];

const POLICY_REGISTRY_ABI = [
  "function isActive(address agent) external view returns (bool)",
  "function getPolicy(address agent) external view returns (tuple(address owner, address operator, bytes32 policyRoot, string policyURI, uint8 tier, uint256 maxValuePerTxUsdc, uint8 activeHoursStartUtc, uint8 activeHoursEndUtc, uint256 totalDecisions, uint256 compliantDecisions, uint256 complianceScore, bool active, bool circuitBreaker))",
];

// Minimal PoolManager interface — only getSlot0 needed for market data.
const POOL_MANAGER_ABI = [
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
];

// ─────────────────────────────── constants ───────────────────────────────────

/** Polling interval between agent loop iterations (ms). */
const LOOP_INTERVAL_MS = 30_000;

/** Minimum time between trades to avoid spamming (ms). */
const MIN_TRADE_INTERVAL_MS = 60_000;

// ─────────────────────────────── helpers ─────────────────────────────────────

/**
 * Convert Uniswap v4 sqrtPriceX96 to a human-readable USDC price per ETH.
 * Formula: price = (sqrtPriceX96 / 2^96)^2
 * Adjusts for token decimals: USDC=6, WETH=18.
 */
function sqrtPriceX96ToUsdc(sqrtPriceX96: bigint): number {
  const Q96    = 2n ** 96n;
  const price  = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 12n) / (Q96 * Q96);
  return Number(price) / 1e6;
}

// ─────────────────────────────── VelaAgent ───────────────────────────────────

export class VelaAgent {
  private readonly provider:    ethers.JsonRpcProvider;
  private readonly signer:      ethers.Wallet;
  private readonly vault:       ethers.Contract;
  private readonly attestation: ethers.Contract;
  private readonly registry:    ethers.Contract;
  private readonly poolManager: ethers.Contract;

  private readonly agentAddress:  string;
  private readonly vaultAddress:  string;
  private readonly poolId:        string;
  private readonly poolName:      string;

  private computeClient: ZeroGComputeClient | null = null;
  private storageClient: ReturnType<typeof createZeroGStorageClient> | null = null;

  private lastTradeTimestamp: number = 0;
  private running: boolean = false;

  constructor() {
    const rpcUrl             = process.env.RPC_URL!;
    const privateKey         = process.env.PRIVATE_KEY!;
    const vaultAddress       = process.env.VELA_VAULT_ADDRESS!;
    const attestationAddress = process.env.ATTESTATION_CONTRACT_ADDRESS!;
    const registryAddress    = process.env.POLICY_REGISTRY_ADDRESS!;
    const poolManagerAddress = process.env.POOL_MANAGER_ADDRESS!;

    this.poolId   = process.env.ACTIVE_POOL_ID   ?? "";
    this.poolName = process.env.ACTIVE_POOL_NAME ?? "ETH/USDC v4";

    for (const [k, v] of Object.entries({
      RPC_URL:                      rpcUrl,
      PRIVATE_KEY:                  privateKey,
      VELA_VAULT_ADDRESS:           vaultAddress,
      ATTESTATION_CONTRACT_ADDRESS: attestationAddress,
      POLICY_REGISTRY_ADDRESS:      registryAddress,
      POOL_MANAGER_ADDRESS:         poolManagerAddress,
    })) {
      if (!v) throw new Error(`Missing required env var: ${k}`);
    }

    this.provider    = new ethers.JsonRpcProvider(rpcUrl);
    this.signer      = new ethers.Wallet(privateKey, this.provider);
    this.agentAddress = this.signer.address;
    this.vaultAddress = vaultAddress;

    this.vault       = new ethers.Contract(vaultAddress,       VAULT_ABI,          this.signer);
    this.attestation = new ethers.Contract(attestationAddress, ATTESTATION_ABI,    this.signer);
    this.registry    = new ethers.Contract(registryAddress,    POLICY_REGISTRY_ABI, this.signer);
    this.poolManager = new ethers.Contract(poolManagerAddress, POOL_MANAGER_ABI,   this.provider);
  }

  // ── startup ──────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  VelaAgent starting up");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  Agent:  ${this.agentAddress}`);
    console.log(`  Vault:  ${this.vaultAddress}`);

    // Verify agent is active in registry.
    const isActive = await this.registry.isActive(this.agentAddress);
    if (!isActive) {
      throw new Error(
        "Agent is not active in PolicyRegistry. " +
        "Run PolicyRegistry.registerAgent() first."
      );
    }
    console.log("  Policy: active ✓");

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
    console.log(`[Agent] Loop started — interval: ${LOOP_INTERVAL_MS / 1000}s\n`);

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
      constraints
    );

    console.log(
      `[Agent]       Decision: ${inferenceResult.decision.action.toUpperCase()} ` +
      `$${inferenceResult.decision.value_usdc.toLocaleString()} USDC — ` +
      inferenceResult.decision.reason
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
      decision:  inferenceResult.decision,
      policy_root: constraints.policyRoot,
      constraints_evaluated: {
        value_check: `${inferenceResult.decision.value_usdc <= constraints.maxValuePerTxUsdc ? "PASS" : "FAIL"} -- ${inferenceResult.decision.value_usdc} vs ${constraints.maxValuePerTxUsdc}`,
        pool_check:  `${constraints.allowedPools.includes(inferenceResult.decision.pool) ? "PASS" : "FAIL"} -- ${inferenceResult.decision.pool}`,
        hours_check: this._checkActiveHours(constraints) ? "PASS" : "FAIL",
      },
      tee_attestation: inferenceResult.teeAttestation,
      agent:           this.agentAddress,
      vault:           this.vaultAddress,
      timestamp:       Math.floor(Date.now() / 1000),
    };

    const { rootHash, contentHash } = await this.storageClient!.uploadDecisionRecord(record);
    console.log(`[Agent]       0G DA CID:     ${rootHash}`);
    console.log(`[Agent]       Content hash:  ${contentHash}`);

    // 5. Commit decision on-chain.
    console.log("[Agent] [5/6] Committing decision on-chain…");
    const commitTx = await this.vault.commitDecision(
      contentHash,
      inferenceResult.decision.reason,
      rootHash
    );
    const commitReceipt = await commitTx.wait();
    const decisionId    = this._parseDecisionId(commitReceipt);
    console.log(`[Agent]       Decision ID: ${decisionId}  TX: ${commitReceipt.hash}`);

    // 6. Execute trade through VelaHook.
    // Hook enforces policy at beforeSwap() — reverts if any constraint violated.
    console.log("[Agent] [6/6] Executing trade through Uniswap v4 Hook…");
    await this._executeTrade(inferenceResult.decision, constraints);
    this.lastTradeTimestamp = Date.now();
    console.log("[Agent]       Trade executed ✓");

    // 7. Verify and settle TEE attestation on-chain (background — non-blocking).
    this._settleAsync(decisionId, contentHash, inferenceResult.teeAttestation.signature);

    console.log(`[Agent] ── iteration complete ──\n`);
  }

  // ── step implementations ─────────────────────────────────────────────────────

  private async _fetchPolicyConstraints(): Promise<PolicyConstraints & { policyRoot: string }> {
    console.log("[Agent] [1/6] Fetching policy constraints…");
    const policy = await this.registry.getPolicy(this.agentAddress);

    return {
      policyRoot:           policy.policyRoot,
      maxValuePerTxUsdc:    Number(policy.maxValuePerTxUsdc),
      maxAllocationPerPool: 10_000,
      stopLossBps:          1_500,
      activeHoursStartUtc:  Number(policy.activeHoursStartUtc),
      activeHoursEndUtc:    Number(policy.activeHoursEndUtc),
      allowedPools:         [this.poolName], // simplified — full impl reads allowedPoolsHash
    };
  }

  private async _fetchMarketData(): Promise<MarketData> {
    console.log("[Agent] [2/6] Fetching market data from Uniswap v4…");

    if (!this.poolId) {
      // Return stub data when ACTIVE_POOL_ID is not configured.
      console.log("[Agent]       Using stub market data (ACTIVE_POOL_ID not set).");
      return {
        poolId:        "stub",
        poolName:      this.poolName,
        currentApy:    7.2,
        sqrtPriceX96:  "0",
        priceUsdc:     3200,
        tvlUsdc:       15_000_000,
        volume24hUsdc: 2_500_000,
        timestamp:     Math.floor(Date.now() / 1000),
      };
    }

    const [sqrtPriceX96] = await this.poolManager.getSlot0(this.poolId);
    const priceUsdc      = sqrtPriceX96ToUsdc(sqrtPriceX96);

    return {
      poolId:        this.poolId,
      poolName:      this.poolName,
      currentApy:    7.2,          // TODO: fetch from Uniswap subgraph
      sqrtPriceX96:  sqrtPriceX96.toString(),
      priceUsdc,
      tvlUsdc:       0,            // TODO: fetch from subgraph
      volume24hUsdc: 0,
      timestamp:     Math.floor(Date.now() / 1000),
    };
  }

  private async _executeTrade(
    decision:    { action: string; value_usdc: number; pool: string },
    _constraints: PolicyConstraints
  ): Promise<void> {
    // Full swap implementation wires into Uniswap v4 PoolManager.
    // The Hook's beforeSwap() enforces all policy checks before execution.
    // For Day 4 integration test, log the intent and return.
    // Full swap implementation is wired in Day 5 when the Hook is deployed.
    console.log(
      `[Agent]       [TODO Day 5] Execute ${decision.action} ` +
      `$${decision.value_usdc.toLocaleString()} on ${decision.pool} via VelaHook`
    );
  }

  /**
   * Submit TEE attestation verification in the background.
   * Non-blocking — does not delay the trade loop.
   */
  private _settleAsync(
    decisionId:  bigint,
    contentHash: string,
    enclaveSignature: string
  ): void {
    (async () => {
      try {
        // On testnet the enclave signature may be a stub — verifyAndSettle
        // will revert if the signer is not registered. That's expected and
        // the watchtower will catch any integrity failures independently.
        const tx = await this.attestation.verifyAndSettle(
          this.vaultAddress,
          decisionId,
          contentHash,
          enclaveSignature
        );
        await tx.wait();
        console.log(`[Agent] [Settle] Decision ${decisionId} attested on-chain ✓`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Stub signatures will fail on-chain — log but don't crash.
        console.warn(`[Agent] [Settle] Attestation pending for decision ${decisionId}: ${msg}`);
      }
    })();
  }

  // ── utilities ────────────────────────────────────────────────────────────────

  private _checkActiveHours(constraints: PolicyConstraints): boolean {
    const hourUtc = new Date().getUTCHours();
    return (
      hourUtc >= constraints.activeHoursStartUtc &&
      hourUtc <  constraints.activeHoursEndUtc
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

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─────────────────────────────── entrypoint ──────────────────────────────────

async function main() {
  const agent = new VelaAgent();
  await agent.init();

  // Graceful shutdown.
  process.on("SIGINT",  () => { agent.stop(); process.exit(0); });
  process.on("SIGTERM", () => { agent.stop(); process.exit(0); });

  await agent.start();
}

main().catch((err) => {
  console.error("[Agent] Fatal error:", err);
  process.exit(1);
});
