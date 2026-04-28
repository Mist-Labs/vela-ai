import type {
  PolicyConstraints,
  ConflictResult,
  PolicyValidationResult,
} from './types.js';

// ─── Check function type ──────────────────────────────────────────────────────

type ConflictCheck = (c: PolicyConstraints) => ConflictResult | null;

// ─── Rule set ────────────────────────────────────────────────────────────────

const CHECKS: ConflictCheck[] = [
  // ── ERROR: invalid active-hours window ──────────────────────────────────────
  (c) => {
    if (c.active_hours_start_utc >= c.active_hours_end_utc) {
      return {
        severity: 'error',
        code: 'INVALID_ACTIVE_HOURS',
        message: `Trading window is invalid: start (${c.active_hours_start_utc}:00 UTC) is at or after end (${c.active_hours_end_utc}:00 UTC).`,
        fields: ['active_hours_start_utc', 'active_hours_end_utc'],
        suggestion: 'Ensure active_hours_start_utc < active_hours_end_utc.',
      };
    }
    return null;
  },

  // ── ERROR: no allowed pools ──────────────────────────────────────────────────
  (c) => {
    if (c.allowed_pools.length === 0) {
      return {
        severity: 'error',
        code: 'NO_ALLOWED_POOLS',
        message: 'No pools in allowlist. The agent cannot execute any trades.',
        fields: ['allowed_pools'],
        suggestion: 'Add at least one pool (e.g. ETH_USDC_V4).',
      };
    }
    return null;
  },

  // ── ERROR: aggressive profile + very tight stop-loss (contradiction) ─────────
  (c) => {
    if (c.risk_profile === 'aggressive' && c.stop_loss_bps < 500) {
      return {
        severity: 'error',
        code: 'AGGRESSIVE_TIGHT_STOP',
        message:
          '"Aggressive" risk profile with a <5% stop-loss is contradictory. Aggressive strategies require wider drawdown tolerance to operate.',
        fields: ['risk_profile', 'stop_loss_bps'],
        suggestion:
          'Increase stop_loss_bps to ≥1500 for aggressive profiles, or switch to conservative.',
      };
    }
    return null;
  },

  // ── ERROR: stop-loss so tight it will fire on normal volatility ──────────────
  (c) => {
    if (c.stop_loss_bps < 100) {
      return {
        severity: 'error',
        code: 'STOP_LOSS_TOO_TIGHT',
        message: 'Stop-loss below 1% will trigger on normal pool price fluctuation, effectively preventing all trading.',
        fields: ['stop_loss_bps'],
        suggestion: 'Set stop_loss_bps to at least 300 (3%).',
      };
    }
    return null;
  },

  // ── WARNING: aggressive yield + low stop-loss (spec rule) ───────────────────
  (c) => {
    if (c.risk_profile === 'aggressive' && c.stop_loss_bps < 1000) {
      return {
        severity: 'warning',
        code: 'AGGRESSIVE_LOW_DRAWDOWN',
        message: '"Aggressive" yield target with a <10% stop-loss limits access to higher-yield pools and contradicts intent.',
        fields: ['risk_profile', 'stop_loss_bps'],
        suggestion: 'Either raise stop_loss_bps or dial back to "moderate" risk profile.',
      };
    }
    return null;
  },

  // ── WARNING: <4 active hours + non-conservative = yield harm (spec rule) ─────
  (c) => {
    const activeHours = c.active_hours_end_utc - c.active_hours_start_utc;
    if (activeHours < 4 && c.risk_profile !== 'conservative') {
      return {
        severity: 'warning',
        code: 'LIMITED_TRADING_HOURS',
        message: `Only ${activeHours}h of active trading per day. This significantly limits yield for a "${c.risk_profile}" strategy.`,
        fields: ['active_hours_start_utc', 'active_hours_end_utc', 'risk_profile'],
        suggestion:
          'Extend the trading window or accept lower APY estimates. Conservative strategies are less affected by narrow windows.',
      };
    }
    return null;
  },

  // ── WARNING: conservative + high concentration per pool ─────────────────────
  (c) => {
    if (c.risk_profile === 'conservative' && c.max_allocation_per_pool_bps > 5000) {
      return {
        severity: 'warning',
        code: 'CONSERVATIVE_HIGH_CONCENTRATION',
        message:
          'Conservative profile with >50% allocation in a single pool contradicts diversification intent.',
        fields: ['risk_profile', 'max_allocation_per_pool_bps'],
        suggestion: 'Reduce max_allocation_per_pool_bps to ≤3000 for conservative strategies.',
      };
    }
    return null;
  },

  // ── WARNING: stop-loss tight relative to pool allocation ────────────────────
  (c) => {
    // If a single pool can hold 40%+ of NAV, a 10% pool move = 4% drawdown.
    // Stop-loss tighter than that will fire on moderate moves.
    const maxSinglePoolFraction = c.max_allocation_per_pool_bps / 10_000;
    const stopLossFraction = c.stop_loss_bps / 10_000;
    if (stopLossFraction < maxSinglePoolFraction * 0.1 && c.max_allocation_per_pool_bps > 2000) {
      return {
        severity: 'warning',
        code: 'STOP_LOSS_TIGHT_RELATIVE_TO_ALLOCATION',
        message:
          'Stop-loss is very tight relative to single-pool concentration. A modest pool move could repeatedly trigger the stop-loss.',
        fields: ['stop_loss_bps', 'max_allocation_per_pool_bps'],
        suggestion:
          'Raise stop_loss_bps, lower max_allocation_per_pool_bps, or accept that trading may halt frequently.',
      };
    }
    return null;
  },

  // ── WARNING: aggressive profile + only stable pools ─────────────────────────
  (c) => {
    const STABLE_POOLS = new Set(['ETH_USDC_V4', 'ETH_USDT_V4']);
    const allStable = c.allowed_pools.every((p) => STABLE_POOLS.has(p));
    if (c.risk_profile === 'aggressive' && allStable) {
      return {
        severity: 'warning',
        code: 'AGGRESSIVE_STABLE_ONLY',
        message:
          '"Aggressive" profile limited to stable pools caps achievable APY well below what aggressive strategies typically target.',
        fields: ['risk_profile', 'allowed_pools'],
        suggestion:
          'Add WBTC_USDC_V4 for higher yield opportunities, or switch to "moderate" profile.',
      };
    }
    return null;
  },

  // ── INFO: high tx value on conservative profile ──────────────────────────────
  (c) => {
    if (c.risk_profile === 'conservative' && c.max_value_per_tx_usdc > 50_000) {
      return {
        severity: 'info',
        code: 'HIGH_TX_VALUE_CONSERVATIVE',
        message:
          'Max transaction value is unusually high for a conservative strategy.',
        fields: ['risk_profile', 'max_value_per_tx_usdc'],
        suggestion: 'Consider capping max_value_per_tx_usdc at ≤10000 for conservative vaults.',
      };
    }
    return null;
  },

  // ── INFO: no time restriction on aggressive ──────────────────────────────────
  (c) => {
    const is24h =
      c.active_hours_start_utc === 0 && c.active_hours_end_utc === 24;
    if (is24h && c.risk_profile === 'aggressive') {
      return {
        severity: 'info',
        code: 'FULL_HOURS_AGGRESSIVE',
        message:
          '24/7 trading on an aggressive profile maximises yield opportunity but increases overnight risk exposure during low-liquidity hours.',
        fields: ['active_hours_start_utc', 'active_hours_end_utc', 'risk_profile'],
        suggestion:
          'Consider restricting to peak liquidity hours (e.g. 6:00–22:00 UTC) to reduce slippage risk.',
      };
    }
    return null;
  },
];

// ─── Public API ───────────────────────────────────────────────────────────────

export function detectConflicts(constraints: PolicyConstraints): PolicyValidationResult {
  const conflicts: ConflictResult[] = [];

  for (const check of CHECKS) {
    const result = check(constraints);
    if (result !== null) conflicts.push(result);
  }

  return {
    valid: !conflicts.some((c) => c.severity === 'error'),
    conflicts,
  };
}

export function conflictSummary(validation: PolicyValidationResult): string {
  if (validation.conflicts.length === 0) return 'No conflicts detected.';
  return validation.conflicts
    .map(
      (c) =>
        `[${c.severity.toUpperCase()}] ${c.message}${
          c.suggestion ? `\n  → ${c.suggestion}` : ''
        }`,
    )
    .join('\n\n');
}