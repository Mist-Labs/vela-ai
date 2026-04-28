/**
 * Builds an OpenZeppelin-compatible Merkle tree from PolicyConstraints.
 *
 * Leaf encoding (matches OZ MerkleProof double-hash pattern):
 *   leaf = keccak256(keccak256(abi.encode(bytes32(fieldName), uint256(value))))
 *
 * The policyRoot is the value committed to PolicyRegistry.sol via registerAgent().
 */

import { AbiCoder, keccak256 as ethersKeccak256 } from 'ethers';
import { MerkleTree } from 'merkletreejs';
import type { PolicyConstraints } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const abiCoder = AbiCoder.defaultAbiCoder();

/** keccak256 wrapper that accepts/returns Buffer — used by MerkleTree internals */
function keccak256buf(data: Buffer): Buffer {
  const hash = ethersKeccak256(data);
  return Buffer.from(hash.slice(2), 'hex');
}

/**
 * Encode a single constraint leaf.
 * Double-hashed so that leaf preimages cannot collide with internal tree nodes.
 */
function encodeLeaf(fieldName: string, value: bigint): Buffer {
  const fieldKey = ethersKeccak256(Buffer.from(fieldName, 'utf8'));
  const encoded   = abiCoder.encode(['bytes32', 'uint256'], [fieldKey, value]);
  const firstHash = Buffer.from(ethersKeccak256(Buffer.from(encoded.slice(2), 'hex')).slice(2), 'hex');
  // Double hash
  return keccak256buf(firstHash);
}

/**
 * Deterministically encode a pool identifier as uint256.
 * keccak256(poolIdString) — same value PolicyRegistry can reconstruct off-chain.
 */
function poolIdToUint256(poolId: string): bigint {
  const hash = ethersKeccak256(Buffer.from(poolId, 'utf8'));
  return BigInt(hash);
}

// ─── Leaf definition type ─────────────────────────────────────────────────────

interface LeafDef {
  label: string;
  value: bigint;
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MerkleResult {
  /** bytes32 hex root — committed to PolicyRegistry.sol */
  policyRoot: `0x${string}`;
  /** Ordered array of raw leaf hex strings */
  leaves: `0x${string}`[];
  /** Human-readable label for each leaf (same order as leaves[]) */
  leafLabels: string[];
  /** MerkleTree instance — use for proof generation */
  tree: MerkleTree;
  /** Raw leaf buffers (for getPolicyProof) */
  leafBuffers: Buffer[];
}

// ─── Core builder ─────────────────────────────────────────────────────────────

export function buildPolicyMerkleTree(constraints: PolicyConstraints): MerkleResult {
  const leafDefs: LeafDef[] = [
    {
      label: 'max_allocation_per_pool_bps',
      value: BigInt(constraints.max_allocation_per_pool_bps),
    },
    {
      label: 'stop_loss_bps',
      value: BigInt(constraints.stop_loss_bps),
    },
    {
      label: 'active_hours_start_utc',
      value: BigInt(constraints.active_hours_start_utc),
    },
    {
      label: 'active_hours_end_utc',
      value: BigInt(constraints.active_hours_end_utc),
    },
    {
      label: 'max_value_per_tx_usdc',
      value: BigInt(constraints.max_value_per_tx_usdc),
    },
    // Encode each allowed pool as its own leaf so individual pool proofs are possible
    ...constraints.allowed_pools.map((pool, i) => ({
      label: `allowed_pool_${i}_${pool}`,
      value: poolIdToUint256(pool),
    })),
  ];

  const leafBuffers = leafDefs.map(({ label, value }) => encodeLeaf(label, value));

  const tree = new MerkleTree(leafBuffers, keccak256buf, { sortPairs: true });

  const root = tree.getHexRoot() as `0x${string}`;

  // Sanity check — tree.getHexRoot() returns '0x' for empty trees
  if (root === '0x' || root === '0x0000000000000000000000000000000000000000000000000000000000000000') {
    throw new Error('Merkle tree construction failed: empty root');
  }

  return {
    policyRoot:  root,
    leaves:      leafBuffers.map((b) => `0x${b.toString('hex')}` as `0x${string}`),
    leafLabels:  leafDefs.map((d) => d.label),
    tree,
    leafBuffers,
  };
}

// ─── Proof generation ─────────────────────────────────────────────────────────

/**
 * Generate a Merkle proof for a single leaf by index.
 * Used off-chain to prove individual constraint values if the contract requires it.
 */
export function getPolicyProof(
  result: MerkleResult,
  leafIndex: number,
): `0x${string}`[] {
  if (leafIndex < 0 || leafIndex >= result.leafBuffers.length) {
    throw new RangeError(`Leaf index ${leafIndex} out of bounds`);
  }
  const proof = result.tree.getHexProof(result.leafBuffers[leafIndex]);
  return proof as `0x${string}`[];
}

/**
 * Verify that a leaf is included in a previously built Merkle tree.
 * Useful for unit tests and off-chain validation.
 */
export function verifyLeaf(
  result: MerkleResult,
  leafIndex: number,
): boolean {
  const proof = result.tree.getHexProof(result.leafBuffers[leafIndex]);
  return result.tree.verify(
    proof,
    result.leafBuffers[leafIndex],
    Buffer.from(result.policyRoot.slice(2), 'hex'),
  );
}