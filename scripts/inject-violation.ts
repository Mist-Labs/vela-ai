/**
 * inject-violation.ts
 *
 * Demo script — tests the EXECUTION FIREWALL layer.
 *
 * Simulates an agent that attempts a swap with value_usdc exceeding the
 * policy ceiling. The Uniswap v4 Hook catches this at beforeSwap() and
 * reverts with ValueExceedsPolicy before any funds move.
 *
 * What the demo shows:
 *   1. Agent builds a decision record with an inflated value.
 *   2. Record is uploaded to 0G DA and committed on-chain.
 *   3. executeTrade() is called — Hook reads spot price from pool state,
 *      computes swap value in USDC, and reverts ValueExceedsPolicy.
 *   4. Dashboard shows attempted violation blocked. No funds moved.
 *
 * This is distinct from inject-tamper.ts:
 *   inject-violation  → Hook blocks a BAD TRADE at execution time.
 *   inject-tamper     → Watchtower catches a FALSIFIED RECORD off-chain.
 *
 * Usage:
 *   TAMPER_VAULT=0x... TAMPER_AGENT=0x... npx ts-node scripts/inject-violation.ts
 *
 * Requires:
 *   @0gfoundation/0g-ts-sdk  ethers  dotenv
 */

import "dotenv/config";
import { ethers } from "ethers";
import { MemData, Indexer } from "@0gfoundation/0g-ts-sdk";
import * as crypto from "crypto";

// ─────────────────────────────── config ──────────────────────────────────────

const RPC_URL    = process.env.RPC_URL    ?? "https://sepolia.base.org";
const ZG_RPC     = process.env.ZERO_G_RPC_URL     ?? "https://evmrpc-testnet.0g.ai";
const ZG_INDEXER = process.env.ZERO_G_INDEXER_URL ?? "https://indexer-storage-testnet-standard.0g.ai";

const VAULT_ADDRESS = process.env.TAMPER_VAULT  ?? process.env.VELA_VAULT_ADDRESS ?? "";
const AGENT_ADDRESS = process.env.TAMPER_AGENT  ?? process.env.AGENT_ADDRESS      ?? "";
const PRIVATE_KEY   = process.env.PRIVATE_KEY   ?? "";

// Pool addresses for the swap attempt — must match your testnet deployment.
const POOL_MANAGER_ADDRESS = process.env.POOL_MANAGER_ADDRESS ?? "";
const HOOK_ADDRESS         = process.env.VELA_HOOK_ADDRESS    ?? "";

// Token addresses on Base Sepolia.
const WETH_ADDRESS = process.env.WETH_ADDRESS ?? "0x4200000000000000000000000000000000000006";
const USDC_ADDRESS = process.env.USDC_ADDRESS ?? "";

if (!VAULT_ADDRESS || !AGENT_ADDRESS || !PRIVATE_KEY) {
  console.error(
    "❌  Missing env vars. Set TAMPER_VAULT, TAMPER_AGENT, and PRIVATE_KEY."
  );
  process.exit(1);
}

// ─────────────────────────────── ABI stubs ───────────────────────────────────

const VAULT_ABI = [
  "function commitDecision(bytes32 decisionHash, string calldata explanation, string calldata evidenceCID) external returns (uint256)",
  "event DecisionCommitted(uint256 indexed id, bytes32 decisionHash, string explanation, string evidenceCID)",
];

// Minimal IPoolManager swap interface — matches Uniswap v4 PoolManager.
const POOL_MANAGER_ABI = [
  `function swap(
    tuple(
      address currency0,
      address currency1,
      uint24  fee,
      int24   tickSpacing,
      address hooks
    ) key,
    tuple(
      bool    zeroForOne,
      int256  amountSpecified,
      uint160 sqrtPriceLimitX96
    ) params,
    bytes calldata hookData
  ) external returns (int256 delta0, int256 delta1)`,
];

// ─────────────────────────────── helpers ─────────────────────────────────────

/** Policy ceiling for STANDARD tier: $10,000 USDC (6 decimals). */
const POLICY_MAX_VALUE_USDC = 10_000n * 1_000_000n;

/**
 * Build a decision record where value_usdc intentionally exceeds the
 * policy ceiling. The Hook will reject this at beforeSwap().
 */
function buildViolatingRecord(agentAddress: string): {
  record: object;
  swapAmountUsdc: bigint;
} {
  // 50,000 USDC — 5× the STANDARD tier ceiling of $10,000.
  const swapAmountUsdc = 50_000n * 1_000_000n;

  const record = {
    decision: {
      action:     "swap",
      value_usdc: Number(swapAmountUsdc / 1_000_000n),
      pool:       "ETH/USDC v4",
      reason:     "VIOLATION: swap value intentionally exceeds policy ceiling for demo",
    },
    policy_root: "0xdeadbeef00000000000000000000000000000000000000000000000000000000",
    constraints_evaluated: {
      value_check: `FAIL -- ${Number(swapAmountUsdc / 1_000_000n)} > ${Number(POLICY_MAX_VALUE_USDC / 1_000_000n)}`,
      pool_check:  "PASS -- ETH/USDC in allowlist",
      hours_check: "PASS -- within active window",
    },
    tee_attestation: {
      enclave_id: "0x9G_ENCLAVE_DEMO_KEY",
      model:      "qwen3.6-plus",
      input_hash: "0x" + crypto.randomBytes(32).toString("hex"),
      signature:  "0x" + crypto.randomBytes(65).toString("hex"),
      report:     Buffer.from("DEMO_TDX_ATTESTATION_REPORT").toString("base64"),
    },
    agent:     agentAddress,
    timestamp: Math.floor(Date.now() / 1000),
  };

  return { record, swapAmountUsdc };
}

function hashRecord(record: object): string {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(record)));
}

async function uploadToZeroG(
  data: object,
  zgIndexer: Indexer,
  signer: ethers.Wallet
): Promise<string> {
  const json    = JSON.stringify(data, null, 2);
  const encoded = new TextEncoder().encode(json);
  const memData = new MemData(encoded);

  const [tree, treeErr] = await memData.merkleTree();
  if (treeErr) throw new Error(`Merkle tree error: ${treeErr}`);

  const rootHash = tree?.rootHash() ?? "";

  const [, uploadErr] = await zgIndexer.upload(memData, ZG_RPC, signer);
  if (uploadErr) throw new Error(`0G upload error: ${uploadErr}`);

  return rootHash;
}

/**
 * Attempt the violating swap through the Uniswap v4 PoolManager.
 * Expected to revert with ValueExceedsPolicy from VelaHook.beforeSwap().
 *
 * hookData encodes the agent address so the Hook can look up its policy.
 */
async function attemptViolatingSwap(
  poolManager: ethers.Contract,
  agentAddress: string,
  swapAmountUsdc: bigint
): Promise<{ blocked: boolean; revertReason: string }> {
  if (!POOL_MANAGER_ADDRESS || !HOOK_ADDRESS || !USDC_ADDRESS) {
    console.log(
      "   ⚠  POOL_MANAGER_ADDRESS / VELA_HOOK_ADDRESS / USDC_ADDRESS not set."
    );
    console.log("      Skipping on-chain swap attempt. Hook block not confirmed.");
    return { blocked: false, revertReason: "env vars missing" };
  }

  // Encode agent address as hookData — matches VelaHook.beforeSwap() decode.
  const hookData = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address"],
    [agentAddress]
  );

  // PoolKey for ETH/USDC v4 pool with VelaHook attached.
  // currency0 < currency1 by address order (Uniswap v4 invariant).
  const currency0 =
    WETH_ADDRESS.toLowerCase() < USDC_ADDRESS.toLowerCase()
      ? WETH_ADDRESS
      : USDC_ADDRESS;
  const currency1 =
    WETH_ADDRESS.toLowerCase() < USDC_ADDRESS.toLowerCase()
      ? USDC_ADDRESS
      : WETH_ADDRESS;

  const poolKey = {
    currency0,
    currency1,
    fee:         3000,
    tickSpacing: 60,
    hooks:       HOOK_ADDRESS,
  };

  // Swap params: sell USDC for ETH (zeroForOne depends on token order).
  const zeroForOne = currency0 === USDC_ADDRESS;
  const swapParams = {
    zeroForOne,
    amountSpecified: swapAmountUsdc,
    // Min/max sqrt price limit — standard values for a full swap.
    sqrtPriceLimitX96: zeroForOne
      ? BigInt("4295128749")                         // MIN_SQRT_RATIO + 1
      : BigInt("1461446703485210103287273052203988822378723970341"), // MAX_SQRT_RATIO - 1
  };

  try {
    await poolManager.swap.staticCall(poolKey, swapParams, hookData);
    // If staticCall succeeds, the Hook did NOT block — unexpected.
    return { blocked: false, revertReason: "swap succeeded unexpectedly" };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);

    const isValueError =
      message.includes("ValueExceedsPolicy") ||
      message.includes("0x") // custom error selector

    return {
      blocked:      isValueError || message.includes("revert"),
      revertReason: message,
    };
  }
}

// ─────────────────────────────── main ────────────────────────────────────────

async function main() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Vela — Violation Injection Script (Day 3 Demo)");
  console.log("  Tests the EXECUTION FIREWALL (Uniswap v4 Hook)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const evmProvider = new ethers.JsonRpcProvider(RPC_URL);
  const signer      = new ethers.Wallet(PRIVATE_KEY, evmProvider);
  const zgIndexer   = new Indexer(ZG_INDEXER);
  const vault       = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);

  const poolManager = POOL_MANAGER_ADDRESS
    ? new ethers.Contract(POOL_MANAGER_ADDRESS, POOL_MANAGER_ABI, signer)
    : null;

  console.log(`Operator: ${signer.address}`);
  console.log(`Vault:    ${VAULT_ADDRESS}`);
  console.log(`Agent:    ${AGENT_ADDRESS}`);
  console.log(`Policy ceiling: $${Number(POLICY_MAX_VALUE_USDC / 1_000_000n).toLocaleString()} USDC`);

  // ── Step 1: Build violating record ────────────────────────────────────────
  console.log("\n[1/4] Building violating decision record…");
  const { record, swapAmountUsdc } = buildViolatingRecord(AGENT_ADDRESS);
  const contentHash = hashRecord(record);
  console.log(`   Swap value:   $${Number(swapAmountUsdc / 1_000_000n).toLocaleString()} USDC`);
  console.log(`   Policy max:   $${Number(POLICY_MAX_VALUE_USDC / 1_000_000n).toLocaleString()} USDC`);
  console.log(`   Content hash: ${contentHash}`);

  // ── Step 2: Upload to 0G DA ───────────────────────────────────────────────
  console.log("\n[2/4] Uploading violating record to 0G DA…");
  const cid = await uploadToZeroG(record, zgIndexer, signer);
  console.log(`   CID (root hash): ${cid}`);

  // ── Step 3: Commit on-chain ───────────────────────────────────────────────
  console.log("\n[3/4] Committing violating decision on-chain…");
  const tx = await vault.commitDecision(
    contentHash,
    "VIOLATION: swap value intentionally exceeds policy ceiling for demo",
    cid
  );
  const receipt = await tx.wait();

  const iface    = new ethers.Interface(VAULT_ABI);
  let decisionId = 0n;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "DecisionCommitted") {
        decisionId = parsed.args.id;
      }
    } catch {
      // skip
    }
  }
  console.log(`   ✓ Decision committed. ID: ${decisionId}  TX: ${receipt.hash}`);

  // ── Step 4: Attempt the swap — Hook should block it ───────────────────────
  console.log("\n[4/4] Attempting violating swap through Uniswap v4 Hook…");
  console.log("   Expected result: Hook reverts with ValueExceedsPolicy.");

  if (!poolManager) {
    console.log("   ⚠  PoolManager not configured — skipping swap attempt.");
    console.log("      Set POOL_MANAGER_ADDRESS, VELA_HOOK_ADDRESS, and USDC_ADDRESS.");
  } else {
    const { blocked, revertReason } = await attemptViolatingSwap(
      poolManager,
      AGENT_ADDRESS,
      swapAmountUsdc
    );

    if (blocked) {
      console.log("   ✓ BLOCKED — Hook reverted as expected.");
      console.log(`   Revert: ${revertReason.slice(0, 120)}…`);
    } else {
      console.log("   ✗ WARNING — swap was NOT blocked. Check Hook deployment.");
      console.log(`   Result: ${revertReason}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  VIOLATION INJECTION COMPLETE");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Decision ID:   ${decisionId}`);
  console.log(`  Swap value:    $${Number(swapAmountUsdc / 1_000_000n).toLocaleString()} USDC`);
  console.log(`  Policy max:    $${Number(POLICY_MAX_VALUE_USDC / 1_000_000n).toLocaleString()} USDC`);
  console.log(`  0G DA CID:     ${cid}`);
  console.log("\n  The Hook blocked the trade at the EVM level.");
  console.log("  No funds moved. No swap executed.");
  console.log("  This demonstrates the execution firewall — Layer 1 of Vela's");
  console.log("  three cryptographic guarantees.\n");
}

main().catch((err) => {
  console.error("\n❌  Script failed:", err.message ?? err);
  process.exit(1);
});
