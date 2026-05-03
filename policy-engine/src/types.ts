// ─── Pool Registry ───────────────────────────────────────────────────────────

export const POOL_IDS = {
  MOCK_USDC_USDT_V4: "MOCK_USDC_USDT_V4",
} as const;

export type PoolIdentifier = keyof typeof POOL_IDS | (string & {});

// ─── Tier config (matches PolicyRegistry.sol) ────────────────────────────────

export const TIERS = {
  MICRO: 0,
  STANDARD: 1,
  PRO: 2,
} as const;

export type Tier = (typeof TIERS)[keyof typeof TIERS];

export const TIER_MAX_VALUE_USDC: Record<Tier, number> = {
  [TIERS.MICRO]: 1_000,
  [TIERS.STANDARD]: 10_000,
  [TIERS.PRO]: 100_000,
};

export function deriveTier(maxValuePerTxUsdc: number): Tier {
  if (maxValuePerTxUsdc <= TIER_MAX_VALUE_USDC[TIERS.MICRO]) return TIERS.MICRO;
  if (maxValuePerTxUsdc <= TIER_MAX_VALUE_USDC[TIERS.STANDARD])
    return TIERS.STANDARD;
  return TIERS.PRO;
}

// ─── Core constraint model ────────────────────────────────────────────────────

export type RiskProfile = "conservative" | "moderate" | "aggressive";

export interface PolicyConstraints {
  /** Maximum portfolio allocation per pool in basis points. 2500 = 25%. */
  max_allocation_per_pool_bps: number;
  /** Stop-loss threshold in basis points. Trading halts if drawdown exceeds this. */
  stop_loss_bps: number;
  /** UTC hour (0–23) when trading may begin. */
  active_hours_start_utc: number;
  /** UTC hour (1–24) when trading must stop. 24 = midnight. */
  active_hours_end_utc: number;
  /** Pools the agent is permitted to trade. */
  allowed_pools: PoolIdentifier[];
  /** Maximum USDC value per single transaction. */
  max_value_per_tx_usdc: number;
  /** Derived risk classification. */
  risk_profile: RiskProfile;
}

// ─── NLP output ──────────────────────────────────────────────────────────────

export interface ParsedPolicy {
  constraints: PolicyConstraints;
  /** Plain English explanation of how the constraints map to the user's intent. */
  explanation: string;
  /** Conservative APY estimate given the policy. */
  estimated_apy_range: [number, number];
  raw_intent: string;
}

// ─── Conflict detection ───────────────────────────────────────────────────────

export type ConflictSeverity = "error" | "warning" | "info";

export interface ConflictResult {
  severity: ConflictSeverity;
  code: string;
  message: string;
  fields: (keyof PolicyConstraints)[];
  suggestion?: string;
}

export interface PolicyValidationResult {
  /** false if any conflict has severity === 'error' */
  valid: boolean;
  conflicts: ConflictResult[];
}

// ─── Final compiled output ────────────────────────────────────────────────────

export interface CompiledPolicy {
  parsed: ParsedPolicy;
  validation: PolicyValidationResult;
  /** bytes32 hex string — Merkle root committed to PolicyRegistry.sol */
  policyRoot: `0x${string}`;
  merkleLeaves: `0x${string}`[];
  leafLabels: string[];
  tier: Tier;
}
