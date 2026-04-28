export * from './types.js';
export { parseIntent } from './nlp.js';
export { detectConflicts, conflictSummary } from './conflict-detector.js';
export { buildPolicyMerkleTree, getPolicyProof, verifyLeaf } from './merkle.js';
export type { MerkleResult } from './merkle.js';

import { parseIntent } from './nlp.js';
import { detectConflicts } from './conflict-detector.js';
import { buildPolicyMerkleTree } from './merkle.js';
import { deriveTier } from './types.js';
import type { CompiledPolicy } from './types.js';

/**
 * Full pipeline: raw intent string → CompiledPolicy ready for on-chain deployment.
 *
 * 1. NLP compilation   — Kimi API (one call, setup only)
 * 2. Conflict detection — pure, deterministic
 * 3. Merkle tree build  — deterministic, OZ-compatible
 *
 * Throws if the Kimi API call fails or if the resulting constraints are
 * structurally invalid (e.g. no pools, invalid hour window).
 */
export async function compilePolicy(rawIntent: string): Promise<CompiledPolicy> {
  const parsed     = await parseIntent(rawIntent);
  const validation = detectConflicts(parsed.constraints);
  const merkle     = buildPolicyMerkleTree(parsed.constraints);

  return {
    parsed,
    validation,
    policyRoot:   merkle.policyRoot,
    merkleLeaves: merkle.leaves,
    leafLabels:   merkle.leafLabels,
    tier:         deriveTier(parsed.constraints.max_value_per_tx_usdc),
  };
}
