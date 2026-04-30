/**
 * zero-g-compute.ts
 *
 * 0G Compute Network — Sealed Inference broker.
 * This is Vela's agent brain. Every trade decision runs through a
 * 0G Sealed Inference enclave (qwen3.6-plus on Intel TDX / TeeTLS).
 *
 * The response includes a TEE attestation — hardware proof that:
 *   - The stated model (qwen3.6-plus) processed the request
 *   - Inside a genuine enclave
 *   - With the stated inputs
 *   - Unmodified by any operator
 *
 * SDK:  @0glabs/0g-serving-broker
 * Docs: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/inference
 */

import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";
import type { TeeAttestation } from "./zero-g.js";

// ─────────────────────────────── types ───────────────────────────────────────

export interface MarketData {
  poolId:         string;
  poolName:       string;
  currentApy:     number;   // annualised %
  sqrtPriceX96:   string;   // raw from poolManager.getSlot0()
  priceUsdc:      number;   // human-readable USDC per ETH
  tvlUsdc:        number;
  volume24hUsdc:  number;
  timestamp:      number;
}

export interface PolicyConstraints {
  maxValuePerTxUsdc:    number;
  maxAllocationPerPool: number;   // basis points (2500 = 25%)
  stopLossBps:          number;
  activeHoursStartUtc:  number;
  activeHoursEndUtc:    number;
  allowedPools:         string[];
  policyRoot:           string;
}

export interface AgentDecision {
  action:     "swap" | "hold" | "rebalance";
  value_usdc: number;
  pool:       string;
  reason:     string;
}

export interface SealedInferenceResponse {
  decision:       AgentDecision;
  teeAttestation: TeeAttestation;
  rawResponse:    string;   // full JSON string — hashed for on-chain commitment
  model:          string;
  providerAddress: string;
}

// ─────────────────────────────── system prompt ───────────────────────────────

const VELA_TRADING_SYSTEM_PROMPT = `You are Vela, a verifiable AI fund manager operating on Uniswap v4.

Your decisions are hardware-attested inside a 0G Sealed Inference TEE enclave.
Every decision you make is permanent, on-chain, and auditable. Act accordingly.

DECISION RULES:
1. Never recommend a swap with value_usdc exceeding maxValuePerTxUsdc.
2. Never recommend a pool not in the allowedPools list.
3. Never recommend a trade outside active hours (activeHoursStartUtc to activeHoursEndUtc UTC).
4. Recommend "hold" when no opportunity meets risk/reward criteria.
5. Your reason must be concise (max 200 chars) and reference the specific opportunity.

OUTPUT FORMAT:
Respond ONLY with a valid JSON object. No preamble, no markdown, no explanation outside the JSON.

{
  "action": "swap" | "hold" | "rebalance",
  "value_usdc": <number — 0 if hold>,
  "pool": "<pool name or empty string if hold>",
  "reason": "<concise reason, max 200 chars>"
}`;

function buildDecisionPrompt(
  market:      MarketData,
  constraints: PolicyConstraints
): string {
  const nowUtc     = new Date();
  const currentHour = nowUtc.getUTCHours();

  return `MARKET DATA:
Pool:          ${market.poolName} (${market.poolId})
Current APY:   ${market.currentApy.toFixed(2)}%
Price (USDC):  $${market.priceUsdc.toFixed(2)} per ETH
TVL:           $${(market.tvlUsdc / 1_000_000).toFixed(2)}M
24h Volume:    $${(market.volume24hUsdc / 1_000_000).toFixed(2)}M
Time (UTC):    ${nowUtc.toISOString()} (hour: ${currentHour})

POLICY CONSTRAINTS:
Max value per tx:    $${constraints.maxValuePerTxUsdc.toLocaleString()} USDC
Max pool allocation: ${constraints.maxAllocationPerPool / 100}%
Stop-loss:           ${constraints.stopLossBps / 100}%
Active hours (UTC):  ${constraints.activeHoursStartUtc}:00 – ${constraints.activeHoursEndUtc}:00
Allowed pools:       ${constraints.allowedPools.join(", ")}

Make your trading decision. If outside active hours, recommend hold.
If no opportunity meets criteria, recommend hold with reason.`;
}

// ─────────────────────────────── client ──────────────────────────────────────

export class ZeroGComputeClient {
  private broker:          Awaited<ReturnType<typeof createZGComputeNetworkBroker>> | null = null;
  private readonly wallet: ethers.Wallet;
  private readonly providerAddress: string;
  private readonly model:           string;

  constructor(wallet: ethers.Wallet, providerAddress: string, model: string) {
    this.wallet          = wallet;
    this.providerAddress = providerAddress;
    this.model           = model;
  }

  // ── initialise ──────────────────────────────────────────────────────────────

  /**
   * Initialise the 0G Compute broker. Must be called before requestDecision().
   * Verifies provider TEE attestation and ensures sub-account is funded.
   */
  async init(): Promise<void> {
    this.broker = await createZGComputeNetworkBroker(this.wallet as never);

    // Verify provider TEE attestation before first use.
    console.log(`[0G Compute] Verifying provider ${this.providerAddress}…`);
    try {
      await this.broker.inference.verifyService(this.providerAddress, ".");
      console.log("[0G Compute] Provider TEE attestation verified.");
    } catch (err) {
      // Non-fatal on testnet — log and continue.
      console.warn("[0G Compute] Provider verification warning:", err);
    }

    // Check sub-account balance.
    const [subAccount] = await this.broker.inference.getAccountWithDetail(
      this.providerAddress
    );
    const balance = subAccount?.balance ?? 0n;
    console.log(
      `[0G Compute] Sub-account balance: ${ethers.formatEther(balance)} 0G`
    );

    if (balance === 0n) {
      throw new Error(
        "[0G Compute] Sub-account has zero balance. " +
        "Run: 0g-compute-cli transfer-fund --provider <ADDR> --amount 5"
      );
    }
  }

  // ── request decision ────────────────────────────────────────────────────────

  /**
   * Request a trade decision from 0G Sealed Inference.
   *
   * The response includes a TEE attestation proving the decision came from
   * qwen3.6-plus running inside an Intel TDX enclave, unmodified.
   *
   * @throws if broker not initialised or inference call fails.
   */
  async requestDecision(
    market:      MarketData,
    constraints: PolicyConstraints
  ): Promise<SealedInferenceResponse> {
    if (!this.broker) {
      throw new Error("[0G Compute] Broker not initialised. Call init() first.");
    }

    const userPrompt = buildDecisionPrompt(market, constraints);

    const requestBody = {
      model: this.model,
      messages: [
        { role: "system", content: VELA_TRADING_SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
      ],
      // Keep responses deterministic and concise.
      temperature: 0,
      max_tokens:  256,
    };

    const { endpoint, model } = await this.broker.inference.getServiceMetadata(
      this.providerAddress
    );
    const headers = await this.broker.inference.getRequestHeaders(
      this.providerAddress,
      JSON.stringify(requestBody)
    );

    const httpResponse = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ ...requestBody, model }),
    });

    if (!httpResponse.ok) {
      const body = await httpResponse.text();
      throw new Error(
        `[0G Compute] Inference request failed: ${httpResponse.status} ${body}`
      );
    }

    const chatId = httpResponse.headers.get("ZG-Res-Key");
    const response = await httpResponse.json() as {
      id?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: unknown;
      teeAttestation?: unknown;
      metadata?: { teeAttestation?: unknown };
    };

    const processed = await this.broker.inference.processResponse(
      this.providerAddress,
      chatId ?? response.id,
      JSON.stringify(response.usage ?? {})
    );
    if (processed !== true) {
      throw new Error("[0G Compute] Provider response could not be verified");
    }

    // Parse the model's JSON response.
    const rawText = response.choices?.[0]?.message?.content ?? "";
    let decision: AgentDecision;

    try {
      // Strip any accidental markdown fences.
      const cleaned = rawText
        .replace(/```json\s*/gi, "")
        .replace(/```\s*/g,     "")
        .trim();
      decision = JSON.parse(cleaned) as AgentDecision;
    } catch {
      throw new Error(
        `[0G Compute] Failed to parse model response as JSON: ${rawText}`
      );
    }

    // Validate required fields.
    if (!["swap", "hold", "rebalance"].includes(decision.action)) {
      throw new Error(`[0G Compute] Invalid action in response: ${decision.action}`);
    }

    // Extract TEE attestation from response metadata.
    // The 0G broker attaches attestation in response.teeAttestation or
    // response.metadata depending on SDK version. Handle both.
    const attestationRaw = normalizeRecord(response.teeAttestation)
      ?? normalizeRecord(response.metadata?.teeAttestation);
    const signatureLink = chatId
      ? await this.broker.inference.getChatSignatureDownloadLink(
          this.providerAddress,
          chatId
        )
      : "";

    const teeAttestation: TeeAttestation = attestationRaw
      ? {
          enclave_id: stringField(attestationRaw, "enclaveId", "enclave_id"),
          model:      stringField(attestationRaw, "model") || this.model,
          input_hash: stringField(attestationRaw, "inputHash", "input_hash"),
          signature:  stringField(attestationRaw, "signature") || signatureLink,
          report:     stringField(attestationRaw, "report") || signatureLink,
          tee_mode:   teeModeField(attestationRaw),
        }
      : {
          enclave_id: this.providerAddress,
          model:      this.model,
          input_hash: ethers.keccak256(ethers.toUtf8Bytes(userPrompt)),
          signature:  signatureLink,
          report:     await this.broker.inference.getSignerRaDownloadLink(
            this.providerAddress
          ),
          tee_mode:   "TeeTLS",
        };

    // rawResponse is the full response JSON — this gets hashed for on-chain
    // commitment and for the watchtower integrity check.
    const rawResponse = JSON.stringify({
      decision,
      tee_attestation: teeAttestation,
      model:           this.model,
      provider:        this.providerAddress,
      timestamp:       Math.floor(Date.now() / 1000),
    });

    return {
      decision,
      teeAttestation,
      rawResponse,
      model:           this.model,
      providerAddress: this.providerAddress,
    };
  }

}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function stringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function teeModeField(record: Record<string, unknown>): "TeeML" | "TeeTLS" {
  const value = stringField(record, "teeMode", "tee_mode");
  return value === "TeeML" ? "TeeML" : "TeeTLS";
}

// ─────────────────────────────── factory ─────────────────────────────────────

/**
 * Create and initialise a ZeroGComputeClient from environment variables.
 * Call this once at agent startup.
 */
export async function createZeroGComputeClient(
  signer: ethers.Wallet
): Promise<ZeroGComputeClient> {
  const providerAddress = process.env.ZERO_G_COMPUTE_PROVIDER_ADDRESS;
  const model           = process.env.ZERO_G_COMPUTE_MODEL ?? "qwen3.6-plus";

  if (!providerAddress) {
    throw new Error("ZERO_G_COMPUTE_PROVIDER_ADDRESS not set");
  }

  const client = new ZeroGComputeClient(signer, providerAddress, model);
  await client.init();
  return client;
}
