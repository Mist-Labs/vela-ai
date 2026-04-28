import OpenAI from 'openai';
import type {
  PolicyConstraints,
  ParsedPolicy,
  RiskProfile,
  PoolIdentifier,
} from './types.js';
import { POOL_IDS } from './types.js';

// ─── Client (singleton) ──────────────────────────────────────────────────────

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.MOONSHOT_API_KEY;
    if (!apiKey) throw new Error('MOONSHOT_API_KEY is not set');
    _client = new OpenAI({
      apiKey,
      baseURL: process.env.MOONSHOT_BASE_URL ?? 'https://api.moonshot.ai/v1',
    });
  }
  return _client;
}

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
- Return ONLY a JSON object. No markdown, no prose, no code fences.

Required JSON shape:
{
  "max_allocation_per_pool_bps": 2500,
  "stop_loss_bps": 1500,
  "active_hours_start_utc": 6,
  "active_hours_end_utc": 24,
  "allowed_pools": ["ETH_USDC_V4"],
  "max_value_per_tx_usdc": 10000,
  "risk_profile": "conservative",
  "explanation": "2-3 sentence explanation.",
  "estimated_apy_min": 4,
  "estimated_apy_max": 9
}`;

// ─── Raw tool input type ─────────────────────────────────────────────────────

interface ParseToolInput {
  max_allocation_per_pool_bps: unknown;
  stop_loss_bps: unknown;
  active_hours_start_utc: unknown;
  active_hours_end_utc: unknown;
  allowed_pools: unknown;
  max_value_per_tx_usdc: unknown;
  risk_profile: unknown;
  explanation: unknown;
  estimated_apy_min: unknown;
  estimated_apy_max: unknown;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compile a plain English investment intent into typed PolicyConstraints.
 * This is the ONLY call to Kimi in the entire Vela policy setup path.
 * It runs once, at vault setup. All downstream logic is deterministic.
 */
export async function parseIntent(rawIntent: string): Promise<ParsedPolicy> {
  if (!rawIntent.trim()) throw new Error('Intent is empty');

  const client = getClient();

  const response = await client.chat.completions.create({
    model: process.env.KIMI_MODEL ?? 'kimi-k2.6',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: rawIntent.trim() },
    ],
    max_tokens: 1024,
  });

  const content = response.choices[0]?.message.content;
  if (!content) {
    throw new Error('NLP compilation failed: no structured output returned from model');
  }

  const input = parseModelJson(content);

  // Clamp all values to valid ranges — never trust raw LLM output for on-chain commitments
  const constraints: PolicyConstraints = {
    max_allocation_per_pool_bps: clampNumber(input.max_allocation_per_pool_bps, 100, 10_000),
    stop_loss_bps:               clampNumber(input.stop_loss_bps, 100, 10_000),
    active_hours_start_utc:      clampNumber(input.active_hours_start_utc, 0, 23),
    active_hours_end_utc:        clampNumber(input.active_hours_end_utc, 1, 24),
    allowed_pools:               sanitizePools(input.allowed_pools),
    max_value_per_tx_usdc:       Math.max(100, toFiniteNumber(input.max_value_per_tx_usdc, 10_000)),
    risk_profile:                sanitizeRiskProfile(input.risk_profile),
  };

  return {
    constraints,
    explanation:         sanitizeText(input.explanation, 'Policy compiled from user intent.'),
    estimated_apy_range: [
      clampNumber(input.estimated_apy_min, 0, 100),
      clampNumber(input.estimated_apy_max, 0, 100),
    ],
    raw_intent:          rawIntent,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseModelJson(content: string): ParseToolInput {
  try {
    const parsed = JSON.parse(content) as Partial<ParseToolInput>;
    return {
      max_allocation_per_pool_bps: parsed.max_allocation_per_pool_bps,
      stop_loss_bps:               parsed.stop_loss_bps,
      active_hours_start_utc:      parsed.active_hours_start_utc,
      active_hours_end_utc:        parsed.active_hours_end_utc,
      allowed_pools:               parsed.allowed_pools,
      max_value_per_tx_usdc:       parsed.max_value_per_tx_usdc,
      risk_profile:                parsed.risk_profile,
      explanation:                 parsed.explanation,
      estimated_apy_min:           parsed.estimated_apy_min,
      estimated_apy_max:           parsed.estimated_apy_max,
    };
  } catch {
    throw new Error('NLP compilation failed: model returned invalid JSON');
  }
}

function clampNumber(value: unknown, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(toFiniteNumber(value, min))));
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sanitizePools(pools: unknown): PoolIdentifier[] {
  const valid = Object.values(POOL_IDS) as string[];
  const input = Array.isArray(pools) ? pools : [];
  const filtered = input.filter((p): p is PoolIdentifier => typeof p === 'string' && valid.includes(p));
  return filtered.length > 0 ? filtered : ['ETH_USDC_V4'];
}

function sanitizeRiskProfile(value: unknown): RiskProfile {
  return value === 'moderate' || value === 'aggressive' ? value : 'conservative';
}

function sanitizeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
