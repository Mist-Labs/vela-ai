import { NextResponse } from "next/server";
import { ethers } from "ethers";

// ─── Minimal ABIs ─────────────────────────────────────────────────────────────

const POLICY_REGISTRY_ABI = [
  "function getPolicy(address agent) external view returns (tuple(address owner, address operator, bytes32 policyRoot, string policyURI, uint8 tier, uint256 maxValuePerTxUsdc, uint8 activeHoursStartUtc, uint8 activeHoursEndUtc, uint256 totalDecisions, uint256 compliantDecisions, uint256 complianceScore, bool active, bool circuitBreaker))",
];

const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
];

// ─── 0G inference (direct HTTP, no broker init overhead) ─────────────────────

async function fetchDecisionFromProvider(
  providerUrl: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  headers: Record<string, string>,
): Promise<string> {
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt },
    ],
    temperature: 0.1,
    max_tokens: 300,
  };

  const res = await fetch(`${providerUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Inference provider error ${res.status}: ${text}`);
  }

  const json = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return json.choices?.[0]?.message?.content ?? "";
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, t0Dec: number, t1Dec: number): number {
  const Q96 = 2n ** 96n;
  const numerator   = sqrtPriceX96 * sqrtPriceX96;
  const denominator = Q96 * Q96;
  const raw = Number(numerator) / Number(denominator);
  return raw * 10 ** (t0Dec - t1Dec);
}

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

function requireAddress(k: string): string {
  const v = requireEnv(k);
  if (!ethers.isAddress(v)) throw new Error(`${k} is not a valid address`);
  return ethers.getAddress(v);
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const rpcUrl          = requireEnv("RPC_URL");
    const zeroGRpc        = process.env.ZERO_G_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
    const privateKey      = requireEnv("AGENT_PRIVATE_KEY");
    const registryAddress = requireAddress("NEXT_PUBLIC_POLICY_REGISTRY_ADDRESS");
    const agentAddress    = requireAddress("NEXT_PUBLIC_AGENT_ADDRESS");
    const stateViewAddr   = requireAddress("STATE_VIEW_ADDRESS");
    const poolId          = requireEnv("ACTIVE_POOL_ID");
    const poolName        = process.env.ACTIVE_POOL_NAME ?? "MockUSDC/MockUSDT";
    const t0Dec           = Number(process.env.ACTIVE_POOL_TOKEN0_DECIMALS ?? "6");
    const t1Dec           = Number(process.env.ACTIVE_POOL_TOKEN1_DECIMALS ?? "6");
    const providerAddress = requireEnv("ZERO_G_COMPUTE_PROVIDER_ADDRESS");
    const model           = process.env.ZERO_G_COMPUTE_MODEL ?? "qwen/qwen-2.5-7b-instruct";

    // ── step 1: fetch policy from on-chain ──────────────────────────────────
    const baseProvider = new ethers.JsonRpcProvider(rpcUrl);
    const registry     = new ethers.Contract(registryAddress, POLICY_REGISTRY_ABI, baseProvider);
    const policy       = await registry.getPolicy(agentAddress);

    const constraints = {
      maxValuePerTxUsdc:   Number(policy.maxValuePerTxUsdc),
      activeHoursStartUtc: Number(policy.activeHoursStartUtc),
      activeHoursEndUtc:   Number(policy.activeHoursEndUtc),
      policyRoot:          policy.policyRoot as string,
      policyURI:           policy.policyURI as string,
    };

    // ── step 2: fetch market data ───────────────────────────────────────────
    const sv = new ethers.Contract(stateViewAddr, STATE_VIEW_ABI, baseProvider);
    const [sqrtPriceX96] = await sv.getSlot0(poolId) as [bigint];
    const priceUsdc = sqrtPriceX96ToPrice(sqrtPriceX96, t0Dec, t1Dec);

    const market = {
      poolId,
      poolName,
      priceUsdc,
      currentApy:    0,
      tvlUsdc:       0,
      volume24hUsdc: 0,
      timestamp:     Math.floor(Date.now() / 1000),
    };

    // ── step 3: 0G sealed inference ─────────────────────────────────────────
    // Init broker on 0G chain to get request headers
    const { createZGComputeNetworkBroker } = await import(
      // @ts-expect-error CJS default import
      "@0glabs/0g-serving-broker"
    ) as { createZGComputeNetworkBroker: (w: ethers.Wallet) => Promise<{
      inference: {
        getServiceMetadata: (addr: string) => Promise<{ endpoint: string; model: string }>;
        getRequestHeaders:  (addr: string, content: string) => Promise<Record<string, string>>;
      };
    }>};

    const zeroGSigner = new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(zeroGRpc));
    const broker      = await createZGComputeNetworkBroker(zeroGSigner as never);

    const { endpoint } = await broker.inference.getServiceMetadata(providerAddress);

    const nowUtc      = new Date();
    const currentHour = nowUtc.getUTCHours();

    const systemPrompt = `You are Vela, a verifiable AI fund manager on Uniswap v4.
Your decisions run inside a 0G Sealed Inference TEE enclave and are permanently on-chain.

RULES:
1. Never exceed maxValuePerTxUsdc.
2. Only trade pools in allowedPools.
3. Active hours are ${constraints.activeHoursStartUtc}:00–${constraints.activeHoursEndUtc}:00 UTC. Current hour: ${currentHour} UTC. This IS within active hours.
4. Respond ONLY with valid JSON — no markdown, no preamble.

OUTPUT FORMAT:
{"action":"swap"|"hold"|"rebalance","value_usdc":<number>,"pool":"<pool name>","reason":"<max 200 chars>"}`;

    const userPrompt = `MARKET DATA:
Pool:         ${poolName} (${poolId})
Price:        $${priceUsdc.toFixed(4)}
APY:          ${market.currentApy.toFixed(2)}%
TVL:          $${(market.tvlUsdc / 1e6).toFixed(2)}M
24h Volume:   $${(market.volume24hUsdc / 1e6).toFixed(2)}M
Time UTC:     ${nowUtc.toISOString()} (hour ${currentHour})

CONSTRAINTS:
Max tx value: $${constraints.maxValuePerTxUsdc} USDC
Active hours: ${constraints.activeHoursStartUtc}:00–${constraints.activeHoursEndUtc}:00 UTC
Policy root:  ${constraints.policyRoot}

Make your trading decision now.`;

    const reqBody    = JSON.stringify({ model, messages: [] }); // for header signing
    const reqHeaders = await broker.inference.getRequestHeaders(providerAddress, reqBody);

    const rawText = await fetchDecisionFromProvider(
      endpoint, model, systemPrompt, userPrompt, reqHeaders,
    );

    // Parse JSON decision
    let decision: { action: string; value_usdc: number; pool: string; reason: string };
    try {
      const cleaned = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      decision = JSON.parse(cleaned);
    } catch {
      throw new Error(`Model returned non-JSON: ${rawText}`);
    }

    // ── build plain-text summary for user ──────────────────────────────────
    const actionLabel = decision.action.toUpperCase();
    const summary = decision.action === "hold"
      ? `The agent recommends holding this iteration.\n\nReason: ${decision.reason}`
      : `The agent recommends a ${actionLabel} of $${decision.value_usdc.toLocaleString()} USDC on ${decision.pool}.\n\nReason: ${decision.reason}\n\nPolicy constraints verified:\n• Max tx value: $${constraints.maxValuePerTxUsdc} USDC ✓\n• Active hours: ${constraints.activeHoursStartUtc}:00–${constraints.activeHoursEndUtc}:00 UTC ✓\n• Pool allowed: ${decision.pool} ✓\n\nThis decision will be committed on-chain and executed through the VelaHook.`;

    return NextResponse.json({
      ok:         true,
      decision,
      summary,
      market:     { priceUsdc, poolName, poolId },
      constraints: {
        maxValuePerTxUsdc:   constraints.maxValuePerTxUsdc,
        activeHoursStartUtc: constraints.activeHoursStartUtc,
        activeHoursEndUtc:   constraints.activeHoursEndUtc,
        policyRoot:          constraints.policyRoot,
      },
      timestamp: Date.now(),
    });

  } catch (err) {
    console.error("[agent/decision]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}