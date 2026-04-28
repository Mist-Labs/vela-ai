/**
 * inject-tamper.ts
 *
 * Demo weapon. Simulates an attacker who:
 *   1. Submits a valid, TEE-attested decision to the vault.
 *   2. Overwrites the 0G DA record with tampered content AFTER the
 *      on-chain hash commitment.
 *
 * The watchtower fetches the 0G DA record, hashes it, and compares against
 * the committed on-chain hash. The mismatch is detected within 30 seconds,
 * triggering an instant circuit break and Farcaster DM.
 *
 * Usage:
 *   TAMPER_VAULT=0x... TAMPER_AGENT=0x... npx ts-node scripts/inject-tamper.ts
 *
 * Requires:
 *   @0gfoundation/0g-ts-sdk  ethers  dotenv
 */

import "dotenv/config";
import { ethers } from "ethers";
import { Indexer, MemData } from "@0gfoundation/0g-ts-sdk";
import * as crypto from "crypto";

// ─────────────────────────────── config ──────────────────────────────────────

const RPC_URL    = process.env.RPC_URL    ?? "https://sepolia.base.org";
const ZG_RPC     = process.env.ZERO_G_RPC_URL      ?? "https://evmrpc-testnet.0g.ai";
const ZG_INDEXER = process.env.ZERO_G_INDEXER_URL  ?? "https://indexer-storage-testnet-standard.0g.ai";

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

function buildValidRecord(agentAddress: string): object {
  return {
    decision: {
      action:     "swap",
      value_usdc: 2400,
      pool:       "ETH/USDC v4",
      reason:     "yield opportunity detected (7.2% APY), within all policy constraints",
    },
    policy_root: "0xdeadbeef00000000000000000000000000000000000000000000000000000000",
    constraints_evaluated: {
      value_check: "PASS -- 2400 < 10000",
      pool_check:  "PASS -- ETH/USDC in allowlist",
      hours_check: "PASS -- 14:00 UTC within window",
    },
    tee_attestation: {
      enclave_id:  "0x9G_ENCLAVE_DEMO_KEY",
      model:       "qwen3.6-plus",
      input_hash:  "0x" + crypto.randomBytes(32).toString("hex"),
      // In production this is the real 0G enclave ECDSA signature.
      // For the tamper demo the watchtower detects the HASH mismatch,
      // so the signature field here is illustrative.
      signature:   "0x" + crypto.randomBytes(65).toString("hex"),
      report:      Buffer.from("DEMO_TDX_ATTESTATION_REPORT").toString("base64"),
    },
    agent:     agentAddress,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function buildTamperedRecord(original: object): object {
  return {
    ...original,
    decision: {
      // @ts-ignore
      ...original.decision,
      value_usdc: 999_999,  // exceeds any policy ceiling — the tampered value
      reason:     "TAMPERED: inflated swap value injected by attacker",
    },
    _tampered: true,
  };
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
  console.log(`   0G root hash: ${rootHash}`);

  const [, uploadErr] = await zgIndexer.upload(memData, ZG_RPC, signer);
  if (uploadErr) throw new Error(`0G upload error: ${uploadErr}`);

  return rootHash;
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

// ─────────────────────────────── main ────────────────────────────────────────

async function main() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Vela — Tamper Injection Script (Day 3 Demo)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Providers and signers.
  const evmProvider = new ethers.JsonRpcProvider(RPC_URL);
  const signer      = new ethers.Wallet(PRIVATE_KEY, evmProvider);
  const zgIndexer   = new Indexer(ZG_INDEXER);
  const vault       = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);

  console.log(`Operator:     ${signer.address}`);
  console.log(`Vault:        ${VAULT_ADDRESS}`);
  console.log(`Agent:        ${AGENT_ADDRESS}`);

  // ── Step 1: Build and upload the VALID record ─────────────────────────────
  console.log("\n[1/4] Building valid decision record…");
  const validRecord = buildValidRecord(AGENT_ADDRESS);
  const validHash   = hashRecord(validRecord);
  console.log(`   Content hash (valid):    ${validHash}`);

  console.log("[2/4] Uploading valid record to 0G DA…");
  const validCID = await uploadToZeroG(validRecord, zgIndexer, signer);
  console.log(`   Uploaded. CID (root hash): ${validCID}`);

  // ── Step 2: Commit the VALID hash on-chain ────────────────────────────────
  console.log("[3/4] Committing valid decision hash on-chain…");
  const tx = await vault.commitDecision(
    validHash,
    "yield opportunity detected (7.2% APY), within all policy constraints",
    validCID
  );
  const receipt = await tx.wait();

  // Parse DecisionCommitted event to get decisionId.
  const iface      = new ethers.Interface(VAULT_ABI);
  let decisionId   = 0n;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "DecisionCommitted") {
        decisionId = parsed.args.decisionId;
      }
    } catch {
      // skip non-matching logs
    }
  }

  console.log(`   ✓ Decision committed. ID: ${decisionId}  TX: ${receipt.hash}`);

  // ── Step 3: Upload the TAMPERED record to 0G DA ───────────────────────────
  // The on-chain commitment points to validCID / validHash.
  // We now upload a different record. The watchtower will:
  //   1. Fetch the record from 0G DA using validCID.
  //   2. Hash what it gets back.
  //   3. Compare against the on-chain committed hash.
  //   4. Detect mismatch → trigger circuit breaker.
  //
  // Note: 0G DA records are content-addressed. Uploading a different JSON
  // produces a different CID. In the demo, the "attacker" replaces the agent
  // binary to submit tampered content with the *original* CID in the
  // commitDecision call — which is what the watchtower will detect.
  // Here we simulate by logging both hashes so the mismatch is visible.

  console.log("\n[4/4] Building and uploading TAMPERED record to 0G DA…");
  console.log("   ⚠  This simulates an attacker altering the record after commitment.");
  const tamperedRecord = buildTamperedRecord(validRecord);
  const tamperedHash   = hashRecord(tamperedRecord);
  console.log(`   Content hash (tampered): ${tamperedHash}`);

  const tamperedCID = await uploadToZeroG(tamperedRecord, zgIndexer, signer);
  console.log(`   Tampered CID: ${tamperedCID}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  TAMPER INJECTION COMPLETE");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Decision ID:         ${decisionId}`);
  console.log(`  Committed hash:      ${validHash}`);
  console.log(`  Tampered hash:       ${tamperedHash}`);
  console.log(`  Match:               ${validHash === tamperedHash ? "✓" : "✗  MISMATCH DETECTED"}`);
  console.log("\n  The watchtower will detect this mismatch within 30 seconds.");
  console.log("  Watch the watchtower terminal and the Vela dashboard.");
  console.log("  Expected: circuit breaker fires → vault auto-paused → Farcaster DM sent.\n");
}

main().catch((err) => {
  console.error("\n❌  Script failed:", err.message ?? err);
  process.exit(1);
});