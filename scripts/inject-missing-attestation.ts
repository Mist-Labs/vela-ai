/**
 * inject-missing-attestation.ts
 *
 * secondary demo script. Simulates an agent that:
 *   1. Uploads a decision record to 0G DA.
 *   2. Commits the decision hash on-chain.
 *   3. Never calls verifyAndSettle() — attestation never arrives.
 *
 * The watchtower detects the missing attestation after a configurable
 * timeout window (ATTESTATION_TIMEOUT_SECONDS) and triggers an auto-pause.
 *
 * Usage:
 *   TAMPER_VAULT=0x... TAMPER_AGENT=0x... npx ts-node scripts/inject-missing-attestation.ts
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

if (!VAULT_ADDRESS || !AGENT_ADDRESS || !PRIVATE_KEY) {
  console.error(
    "❌  Missing env vars. Set TAMPER_VAULT, TAMPER_AGENT, and PRIVATE_KEY."
  );
  process.exit(1);
}

// ─────────────────────────────── ABI stubs ───────────────────────────────────

const VAULT_ABI = [
  "function commitDecision(bytes32 decisionHash, string calldata explanation, string calldata evidenceCID) external returns (uint256)",
  "event DecisionCommitted(uint256 indexed decisionId, bytes32 decisionHash, string evidenceCID)",
];

// ─────────────────────────────── helpers ─────────────────────────────────────

function buildDecisionRecord(agentAddress: string): object {
  return {
    decision: {
      action:     "swap",
      value_usdc: 1800,
      pool:       "ETH/USDC v4",
      reason:     "rebalance opportunity detected, within policy constraints",
    },
    policy_root: "0xdeadbeef00000000000000000000000000000000000000000000000000000000",
    constraints_evaluated: {
      value_check: "PASS -- 1800 < 10000",
      pool_check:  "PASS -- ETH/USDC in allowlist",
      hours_check: "PASS -- 10:00 UTC within window",
    },
    // NOTE: tee_attestation is intentionally missing / incomplete here.
    // This simulates an agent that ran the decision but the TEE attestation
    // pipeline failed — the record made it to 0G DA but verifyAndSettle()
    // is never called on-chain.
    tee_attestation: null,
    agent:     agentAddress,
    timestamp: Math.floor(Date.now() / 1000),
    _missing_attestation: true,
  };
}

function hashRecord(record: object): string {
  return (
    "0x" +
    crypto
      .createHash("sha256")
      .update(JSON.stringify(record))
      .digest("hex")
  );
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

// ─────────────────────────────── main ────────────────────────────────────────

async function main() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Vela — Missing Attestation Injection Script (Day 3)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const evmProvider = new ethers.JsonRpcProvider(RPC_URL);
  const signer      = new ethers.Wallet(PRIVATE_KEY, evmProvider);
  const zgIndexer   = new Indexer(ZG_INDEXER);
  const vault       = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);

  console.log(`Operator:  ${signer.address}`);
  console.log(`Vault:     ${VAULT_ADDRESS}`);
  console.log(`Agent:     ${AGENT_ADDRESS}`);

  // ── Step 1: Build record (no TEE attestation) ─────────────────────────────
  console.log("\n[1/3] Building decision record with missing TEE attestation…");
  const record      = buildDecisionRecord(AGENT_ADDRESS);
  const contentHash = hashRecord(record);
  console.log(`   Content hash: ${contentHash}`);

  // ── Step 2: Upload to 0G DA ───────────────────────────────────────────────
  console.log("[2/3] Uploading record to 0G DA…");
  const cid = await uploadToZeroG(record, zgIndexer, signer);
  console.log(`   CID (root hash): ${cid}`);

  // ── Step 3: Commit on-chain — intentionally never settle ─────────────────
  console.log("[3/3] Committing decision on-chain (verifyAndSettle will NOT be called)…");
  const tx = await vault.commitDecision(
    contentHash,
    "rebalance opportunity detected, within policy constraints",
    cid
  );
  const receipt = await tx.wait();

  const iface    = new ethers.Interface(VAULT_ABI);
  let decisionId = 0n;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "DecisionCommitted") {
        decisionId = parsed.args.decisionId;
      }
    } catch {
      // skip
    }
  }

  console.log(`   ✓ Decision committed. ID: ${decisionId}  TX: ${receipt.hash}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  MISSING ATTESTATION INJECTION COMPLETE");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Decision ID:   ${decisionId}`);
  console.log(`  Content hash:  ${contentHash}`);
  console.log(`  0G DA CID:     ${cid}`);
  console.log("\n  verifyAndSettle() has NOT been called — intentionally.");
  console.log("  The watchtower will detect the missing attestation after its");
  console.log("  configured timeout window and auto-pause the vault.");
  console.log("  Expected: circuit breaker fires → vault auto-paused → Farcaster DM sent.\n");
}

main().catch((err) => {
  console.error("\n❌  Script failed:", err.message ?? err);
  process.exit(1);
});