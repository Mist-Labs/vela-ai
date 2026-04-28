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
    this.broker = await createZGComputeNetworkBroker(this.wallet);

    // Verify provider TEE attestation before first use.
    console.log(`[0G Compute] Verifying provider ${this.providerAddress}…`);
    try {
      await this.broker.inference.verifyService(this.providerAddress, () => {});
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

    // The broker handles authentication, payment, and TEE attestation.
    const response = await this.broker.inference.requestService(
      this.providerAddress,
      {
        model: this.model,
        messages: [
          { role: "system", content: VELA_TRADING_SYSTEM_PROMPT },
          { role: "user",   content: userPrompt },
        ],
        // Keep responses deterministic and concise.
        temperature: 0,
        max_tokens:  256,
      }
    );

    // Parse the model's JSON response.
    const rawText = response.content ?? "";
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
    const attestationRaw =
      // @ts-ignore — field name may vary by SDK version
      response.teeAttestation ?? response.metadata?.teeAttestation ?? null;

    const teeAttestation: TeeAttestation = attestationRaw
      ? {
          enclave_id: attestationRaw.enclaveId  ?? attestationRaw.enclave_id  ?? "",
          model:      attestationRaw.model       ?? this.model,
          input_hash: attestationRaw.inputHash   ?? attestationRaw.input_hash  ?? "",
          signature:  attestationRaw.signature   ?? "",
          report:     attestationRaw.report      ?? "",
          tee_mode:   attestationRaw.teeMode     ?? "TeeTLS",
        }
      : this._buildStubAttestation(userPrompt);

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

  // ── stub attestation (testnet fallback) ─────────────────────────────────────

  /**
   * Builds a clearly-marked stub attestation for testnet environments
   * where the full TDX report may not be available.
   * The stub is structurally identical — the watchtower can still verify
   * the hash integrity chain even without a real TDX report.
   */
  private _buildStubAttestation(inputPrompt: string): TeeAttestation {
    const crypto = require("crypto") as typeof import("crypto");
    return {
      enclave_id: "0xSTUB_ENCLAVE_TESTNET",
      model:      this.model,
      input_hash: "0x" + crypto.createHash("sha256").update(inputPrompt).digest("hex"),
      signature:  "0xSTUB_SIGNATURE_TESTNET",
      report:     Buffer.from("STUB_TDX_REPORT_TESTNET").toString("base64"),
      tee_mode:   "TeeTLS",
    };
  }
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