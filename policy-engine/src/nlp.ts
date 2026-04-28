import Anthropic from '@anthropic-ai/sdk';
import type {
  PolicyConstraints,
  ParsedPolicy,
  RiskProfile,
  PoolIdentifier,
} from './types.js';
import { POOL_IDS } from './types.js';

// ─── Client (singleton) ──────────────────────────────────────────────────────

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// ─── Tool definition ─────────────────────────────────────────────────────────

const PARSE_POLICY_TOOL: Anthropic.Tool = {
  name: 'parse_investment_policy',
  description:
    'Parse a natural language investment intent into typed policy constraints for a DeFi vault.',
  input_schema: {
    type: 'object',
    properties: {
      max_allocation_per_pool_bps: {
        type: 'number',
        description:
          'Max percentage of portfolio in any single pool, in basis points (100=1%, 2500=25%). Default: 2500.',
      },
      stop_loss_bps: {
        type: 'number',
        description:
          'Stop-loss drawdown threshold in basis points (100=1%, 1500=15%). Trading halts when exceeded. Default: 2000.',
      },
      active_hours_start_utc: {
        type: 'number',
        description: 'UTC hour (0–23) when trading may begin. Default: 0.',
      },
      active_hours_end_utc: {
        type: 'number',
        description:
          'UTC hour (1–24) when trading must stop. Use 24 for midnight. Default: 24.',
      },
      allowed_pools: {
        type: 'array',
        items: {
          type: 'string',
          enum: Object.values(POOL_IDS),
        },
        description:
          'Pools the agent may trade. Default: ["ETH_USDC_V4"]. Add WBTC_USDC_V4 for BTC exposure.',
      },
      max_value_per_tx_usdc: {
        type: 'number',
        description:
          'Max USDC value per trade. Tiers: MICRO ≤1000, STANDARD ≤10000, PRO ≤100000. Default: 10000.',
      },
      risk_profile: {
        type: 'string',
        enum: ['conservative', 'moderate', 'aggressive'] satisfies RiskProfile[],
        description: 'Overall risk classification derived from the user intent.',
      },
      explanation: {
        type: 'string',
        description:
          "2–3 sentence plain English explanation of how these constraints match the user's intent. Mention any trade-offs.",
      },
      estimated_apy_min: {
        type: 'number',
        description: 'Estimated minimum annual yield % for this policy.',
      },
      estimated_apy_max: {
        type: 'number',
        description: 'Estimated maximum annual yield % for this policy.',
      },
    },
    required: [
      'max_allocation_per_pool_bps',
      'stop_loss_bps',
      'active_hours_start_utc',
      'active_hours_end_utc',
      'allowed_pools',
      'max_value_per_tx_usdc',
      'risk_profile',
      'explanation',
      'estimated_apy_min',
      'estimated_apy_max',
    ],
  },
};

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a DeFi policy compiler for Vela, a verifiable AI fund manager.
Your sole job: translate a user's natural language investment intent into precise, structured
policy constraints that will be committed on-chain and enforced by a Uniswap v4 Hook.

Mapping guidelines:
- "Grow steadily" / "conservative" / "safe" → max_allocation ≤3000bps, stop_loss ≤1500bps, risk=conservative
- "Moderate growth" / "balanced" → max_allocation ≤5000bps, stop_loss ≤2500bps, risk=moderate
- "Aggressive" / "maximize yield" / "high risk" → max_allocation up to 10000bps, stop_loss up to 5000bps, risk=aggressive
- "Don't trade at night" / "midnight to 6am" → active_hours_start=6, active_hours_end=24
- "Business hours only" / "9 to 5" → active_hours_start=9, active_hours_end=17
- "No time restriction" / unspecified → active_hours_start=0, active_hours_end=24
- Portfolio with BTC mention → include WBTC_USDC_V4
- Default: ETH_USDC_V4 only
- When intent is ambiguous, be conservative.
- Always call the parse_investment_policy tool. Never reply in prose.`;

// ─── Raw tool input type ─────────────────────────────────────────────────────

interface ParseToolInput {
  max_allocation_per_pool_bps: number;
  stop_loss_bps: number;
  active_hours_start_utc: number;
  active_hours_end_utc: number;
  allowed_pools: string[];
  max_value_per_tx_usdc: number;
  risk_profile: RiskProfile;
  explanation: string;
  estimated_apy_min: number;
  estimated_apy_max: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compile a plain English investment intent into typed PolicyConstraints.
 * This is the ONLY call to the Claude API in the entire Vela system.
 * It runs once, at vault setup. All downstream logic is deterministic.
 */
export async function parseIntent(rawIntent: string): Promise<ParsedPolicy> {
  if (!rawIntent.trim()) throw new Error('Intent is empty');

  const client = getClient();

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [PARSE_POLICY_TOOL],
    tool_choice: { type: 'tool', name: 'parse_investment_policy' },
    messages: [{ role: 'user', content: rawIntent.trim() }],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (!toolUse || toolUse.name !== 'parse_investment_policy') {
    throw new Error('NLP compilation failed: no structured output returned from model');
  }

  const input = toolUse.input as ParseToolInput;

  // Clamp all values to valid ranges — never trust raw LLM output for on-chain commitments
  const constraints: PolicyConstraints = {
    max_allocation_per_pool_bps: clamp(input.max_allocation_per_pool_bps, 100, 10_000),
    stop_loss_bps:               clamp(input.stop_loss_bps, 100, 10_000),
    active_hours_start_utc:      clamp(input.active_hours_start_utc, 0, 23),
    active_hours_end_utc:        clamp(input.active_hours_end_utc, 1, 24),
    allowed_pools:               sanitizePools(input.allowed_pools),
    max_value_per_tx_usdc:       Math.max(100, input.max_value_per_tx_usdc),
    risk_profile:                input.risk_profile,
  };

  return {
    constraints,
    explanation:         input.explanation,
    estimated_apy_range: [input.estimated_apy_min, input.estimated_apy_max],
    raw_intent:          rawIntent,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sanitizePools(pools: string[]): PoolIdentifier[] {
  const valid = Object.values(POOL_IDS) as string[];
  const filtered = pools.filter((p) => valid.includes(p)) as PoolIdentifier[];
  return filtered.length > 0 ? filtered : ['ETH_USDC_V4'];
}