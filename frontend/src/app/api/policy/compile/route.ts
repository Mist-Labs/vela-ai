import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { compilePolicy } from "../../../../../../policy-engine";

// ─── 0G DA upload ─────────────────────────────────────────────────────────────

async function uploadPolicyToDA(
  blob: string,
  signer: ethers.Wallet,
): Promise<{ rootHash: string; contentHash: string }> {
const { Indexer, MemData } = await import("@0gfoundation/0g-storage-ts-sdk");

  const indexerUrl = process.env.ZERO_G_INDEXER_URL!;
  const zgRpcUrl   = process.env.ZERO_G_RPC_URL ?? "https://evmrpc-testnet.0g.ai";

  const indexer = new Indexer(indexerUrl);
  const encoded = new TextEncoder().encode(blob);
  const memData = new MemData(encoded);

  const [tree, treeErr] = await memData.merkleTree();
  if (treeErr !== null) throw new Error(`0G DA merkle tree: ${treeErr}`);

  const rootHash = tree?.rootHash();
  if (!rootHash) throw new Error("0G DA: failed to compute root hash");

  const [, uploadErr] = await indexer.upload(memData, zgRpcUrl, signer as never);
  if (uploadErr !== null) throw new Error(`0G DA upload: ${uploadErr}`);

  return {
    rootHash,
    contentHash: ethers.keccak256(ethers.toUtf8Bytes(blob)),
  };
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { intent } = await req.json() as { intent?: string };
    if (!intent?.trim()) {
      return NextResponse.json({ error: "Intent is empty" }, { status: 400 });
    }

    // Step 1: NLP → constraints → Merkle tree
    const compiled = await compilePolicy(intent.trim());

    // compiled shape (from policy-engine/index.ts):
    // {
    //   parsed:       { constraints: PolicyConstraints, ... }
    //   validation:   { conflicts, warnings }
    //   policyRoot:   `0x${string}`   ← Merkle root
    //   merkleLeaves: string[]
    //   leafLabels:   string[]
    //   tier:         number
    // }

    const constraints = compiled.parsed.constraints;

    // Step 2: upload to 0G DA (skip if env not configured)
    const privateKey = process.env.AGENT_PRIVATE_KEY;
    const indexerUrl = process.env.ZERO_G_INDEXER_URL;

    let policyURI  = "";
    let daUploaded = false;

    if (privateKey && indexerUrl) {
      const zgRpc  = process.env.ZERO_G_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
      const signer = new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(zgRpc));

      // Blob format: what agent.ts decodes via fetchRaw() → JSON.parse → .constraints
      const blob = JSON.stringify({ constraints }, null, 2);

      const { rootHash } = await uploadPolicyToDA(blob, signer);
      policyURI  = rootHash;
      daUploaded = true;

      console.log(`[policy/compile] 0G DA CID: ${rootHash}`);
      console.log(`[policy/compile] Merkle root: ${compiled.policyRoot}`);
    } else {
      console.warn("[policy/compile] AGENT_PRIVATE_KEY or ZERO_G_INDEXER_URL not set — DA upload skipped");
    }

    return NextResponse.json({
      ...compiled,
      policyRoot: compiled.policyRoot,  // bytes32 Merkle root → registerAgentWithPolicy arg 1
      policyURI,                        // 0G DA CID → registerAgentWithPolicy arg 2
      daUploaded,
      // Flat convenience fields for IntentInput.tsx → registerPolicy call
      activeHoursStartUtc: constraints.active_hours_start_utc ?? 0,
      activeHoursEndUtc:   constraints.active_hours_end_utc   ?? 24,
      maxValuePerTxUsdc:   constraints.max_value_per_tx_usdc  ?? 10_000,
      tier:                compiled.tier,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Policy compilation failed";
    console.error("[policy/compile]", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}