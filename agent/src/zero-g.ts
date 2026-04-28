/**
 * zero-g.ts
 *
 * 0G Storage DA layer — upload and fetch Vela decision records.
 *
 * Every decision record (including TEE attestation) is uploaded to 0G DA
 * BEFORE the trade executes. The returned root hash (CID) is committed
 * on-chain via VelaVault.commitDecision(). Anyone can fetch the record
 * by CID and verify the TEE attestation independently.
 *
 * SDK: @0gfoundation/0g-ts-sdk
 * Docs: https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk
 */

import { Indexer, MemData } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";

// ─────────────────────────────── types ───────────────────────────────────────

export interface TeeAttestation {
  enclave_id:  string;
  model:       string;
  input_hash:  string;
  signature:   string;  // enclave ECDSA signature over keccak256(response JSON)
  report:      string;  // base64-encoded Intel TDX attestation report
  tee_mode:    "TeeML" | "TeeTLS";
}

export interface DecisionRecord {
  decision: {
    action:     "swap" | "hold" | "rebalance";
    value_usdc: number;
    pool:       string;
    reason:     string;
  };
  policy_root:           string;
  constraints_evaluated: Record<string, string>;
  tee_attestation:       TeeAttestation | null;
  agent:                 string;
  vault:                 string;
  timestamp:             number;
}

export interface UploadResult {
  /** 0G DA root hash — use as CID in commitDecision() */
  rootHash:    string;
  /** keccak256 of the serialised record JSON — committed on-chain */
  contentHash: string;
}

// ─────────────────────────────── client ──────────────────────────────────────

export class ZeroGStorageClient {
  private readonly indexer: Indexer;
  private readonly zgRpcUrl: string;
  private readonly signer: ethers.Wallet;

  constructor(
    indexerUrl: string,
    zgRpcUrl:   string,
    signer:     ethers.Wallet
  ) {
    this.indexer   = new Indexer(indexerUrl);
    this.zgRpcUrl  = zgRpcUrl;
    this.signer    = signer;
  }

  // ── upload ──────────────────────────────────────────────────────────────────

  /**
   * Upload a decision record to 0G DA.
   *
   * Returns the root hash (CID) and content hash.
   * The content hash is what gets committed on-chain and what the
   * watchtower verifies against the TEE signature.
   *
   * @throws if the upload fails after retries.
   */
  async uploadDecisionRecord(record: DecisionRecord): Promise<UploadResult> {
    const json    = JSON.stringify(record, null, 2);
    const encoded = new TextEncoder().encode(json);

    // contentHash: keccak256 of the JSON bytes — this is what the enclave
    // signs and what the watchtower verifies on-chain.
    const contentHash = ethers.keccak256(ethers.toUtf8Bytes(json));

    const memData = new MemData(encoded);

    const [tree, treeErr] = await memData.merkleTree();
    if (treeErr !== null) {
      throw new Error(`0G DA: merkle tree error — ${treeErr}`);
    }

    const rootHash = tree?.rootHash();
    if (!rootHash) {
      throw new Error("0G DA: failed to compute root hash");
    }

    const [, uploadErr] = await this.indexer.upload(
      memData,
      this.zgRpcUrl,
      this.signer
    );

    if (uploadErr !== null) {
      throw new Error(`0G DA: upload failed — ${uploadErr}`);
    }

    return { rootHash, contentHash };
  }

  // ── fetch ───────────────────────────────────────────────────────────────────

  /**
   * Fetch a decision record from 0G DA by its root hash (CID).
   *
   * Downloads to a temp path and parses the JSON.
   * The watchtower uses this to verify TEE signatures and hash integrity.
   *
   * @throws if the download or parse fails.
   */
  async fetchDecisionRecord(rootHash: string): Promise<{
    record:      DecisionRecord;
    contentHash: string;
  }> {
    const tmpPath = `/tmp/vela-record-${rootHash.slice(0, 16)}.json`;

    const downloadErr = await this.indexer.download(rootHash, tmpPath, true);
    if (downloadErr !== null) {
      throw new Error(`0G DA: download failed for ${rootHash} — ${downloadErr}`);
    }

    // Read back and parse.
    const { readFileSync } = await import("fs");
    const raw  = readFileSync(tmpPath, "utf-8");
    const contentHash = ethers.keccak256(ethers.toUtf8Bytes(raw));

    let record: DecisionRecord;
    try {
      record = JSON.parse(raw) as DecisionRecord;
    } catch (e) {
      throw new Error(`0G DA: failed to parse record JSON for ${rootHash} — ${e}`);
    }

    return { record, contentHash };
  }

  // ── verify integrity ────────────────────────────────────────────────────────

  /**
   * Verify that the fetched record's content hash matches what was
   * committed on-chain. This is the core watchtower integrity check.
   *
   * Returns true if hashes match, false if tampered.
   */
  async verifyRecordIntegrity(
    rootHash:        string,
    committedHash:   string
  ): Promise<{ valid: boolean; fetchedHash: string; record: DecisionRecord }> {
    const { record, contentHash: fetchedHash } =
      await this.fetchDecisionRecord(rootHash);

    const valid = fetchedHash.toLowerCase() === committedHash.toLowerCase();

    return { valid, fetchedHash, record };
  }
}

// ─────────────────────────────── factory ─────────────────────────────────────

/**
 * Create a ZeroGStorageClient from environment variables.
 * Call this once at agent startup.
 */
export function createZeroGStorageClient(signer: ethers.Wallet): ZeroGStorageClient {
  const indexerUrl = process.env.ZERO_G_INDEXER_URL;
  const zgRpcUrl   = process.env.ZERO_G_RPC_URL;

  if (!indexerUrl) throw new Error("ZERO_G_INDEXER_URL not set");
  if (!zgRpcUrl)   throw new Error("ZERO_G_RPC_URL not set");

  return new ZeroGStorageClient(indexerUrl, zgRpcUrl, signer);
}
