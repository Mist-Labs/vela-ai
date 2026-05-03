import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";

// ─── ABI (matches agent.ts exactly) ──────────────────────────────────────────

const VAULT_ABI = [
  "function executeHookSwap((tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bool zeroForOne,uint256 amountIn,uint256 minAmountOut,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut)",
  "function commitDecision(bytes32 decisionHash, string calldata explanation, string calldata evidenceCID) external returns (uint256)",
  "event HookSwapExecuted(bytes32 indexed poolId,address indexed agent,bool zeroForOne,uint256 amountIn,uint256 amountOut,address hook)",
];

const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
];

// ─── constants ────────────────────────────────────────────────────────────────

const MIN_SQRT_PRICE_PLUS_ONE = 4_295_128_739n;
const MAX_SQRT_PRICE_MINUS_ONE =
  1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n;

function sqrtPriceX96ToUsdc(sqrtPriceX96: bigint): number {
  const Q96 = 2n ** 96n;
  const price = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 12n) / (Q96 * Q96);
  return Number(price) / 1e6;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function requireAddress(name: string): string {
  const v = requireEnv(name);
  if (!ethers.isAddress(v))
    throw new Error(`${name} is not a valid address: ${v}`);
  return ethers.getAddress(v);
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: { operator?: string; shares?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { operator } = body;
  if (!operator || !ethers.isAddress(operator)) {
    return NextResponse.json(
      { error: "operator address required" },
      { status: 400 },
    );
  }

  try {
    // ── env ──────────────────────────────────────────────────────────────────
    const rpcUrl = requireEnv("RPC_URL");
    const privateKey = requireEnv("AGENT_PRIVATE_KEY"); // separate from PRIVATE_KEY
    const vaultAddress = requireAddress("NEXT_PUBLIC_VELA_VAULT_ADDRESS");
    const hookAddress = requireAddress("VELA_HOOK_ADDRESS");
    const stateViewAddr = requireAddress("STATE_VIEW_ADDRESS");
    const currency0 = requireAddress("ACTIVE_POOL_CURRENCY0");
    const currency1 = requireAddress("ACTIVE_POOL_CURRENCY1");
    const poolId = requireEnv("ACTIVE_POOL_ID");
    const fee = Number(process.env.ACTIVE_POOL_FEE ?? "3000");
    const tickSpacing = Number(process.env.ACTIVE_POOL_TICK_SPACING ?? "60");
    const zeroForOne =
      (process.env.ACTIVE_POOL_ZERO_FOR_ONE ?? "false") === "true";
    const token0Dec = Number(process.env.ACTIVE_POOL_TOKEN0_DECIMALS ?? "18");
    const token1Dec = Number(process.env.ACTIVE_POOL_TOKEN1_DECIMALS ?? "6");
    const slippageBps = Number(process.env.TRADE_SLIPPAGE_BPS ?? "100");

    // Demo trade size: 100 USDC equivalent, overridable
    const tradeValueUsdc = Number(process.env.DEMO_TRADE_VALUE_USDC ?? "100");

    // ── provider / signer ────────────────────────────────────────────────────
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(privateKey, provider);
    const vault = new ethers.Contract(vaultAddress, VAULT_ABI, signer);
    const sv = new ethers.Contract(stateViewAddr, STATE_VIEW_ABI, provider);

    // ── get current price ────────────────────────────────────────────────────
    const [sqrtPriceX96] = (await sv.getSlot0(poolId)) as [bigint];
    const priceUsdc = sqrtPriceX96ToUsdc(sqrtPriceX96);

    // ── compute amounts ──────────────────────────────────────────────────────
    function toUnits(value: number, decimals: number): bigint {
      return ethers.parseUnits(value.toFixed(decimals), decimals);
    }

    const keepBps = 10_000 - slippageBps;

    let amountIn: bigint;
    let minAmountOut: bigint;

    if (zeroForOne) {
      amountIn = ethers.parseUnits(String(tradeValueUsdc), token0Dec);
      minAmountOut =
        (ethers.parseUnits(String(tradeValueUsdc), token1Dec) *
          BigInt(keepBps)) /
        10_000n;
    } else {
      amountIn = ethers.parseUnits(String(tradeValueUsdc), token1Dec);
      minAmountOut =
        (ethers.parseUnits(String(tradeValueUsdc), token0Dec) *
          BigInt(keepBps)) /
        10_000n;
    }

    const sqrtPriceLimitX96 = zeroForOne
      ? (sqrtPriceX96 * 99n) / 100n
      : (sqrtPriceX96 * 101n) / 100n;

    // ── commit decision on-chain (operator-triggered) ─────────────────────────
    const explanation = `Operator-confirmed swap: $${tradeValueUsdc} USDC at price $${priceUsdc.toFixed(2)}`;
    const evidenceCID = "operator-triggered"; // real CID comes from 0G DA in full loop
    const contentHash = ethers.keccak256(
      ethers.toUtf8Bytes(`${operator}:${Date.now()}:${tradeValueUsdc}`),
    );

    const commitTx = await vault.commitDecision(
      contentHash,
      explanation,
      evidenceCID,
    );
    const commitReceipt = await (
      commitTx as ethers.ContractTransactionResponse
    ).wait();
    if (!commitReceipt) throw new Error("commitDecision: no receipt");

    // ── execute swap through VelaHook ────────────────────────────────────────
    const swapTx = await vault.executeHookSwap({
      key: { currency0, currency1, fee, tickSpacing, hooks: hookAddress },
      zeroForOne,
      amountIn,
      minAmountOut,
      sqrtPriceLimitX96,
    });
    const swapReceipt = await (
      swapTx as ethers.ContractTransactionResponse
    ).wait();
    if (!swapReceipt) throw new Error("executeHookSwap: no receipt");

    return NextResponse.json({
      ok: true,
      txHash: swapReceipt.hash,
      commitHash: commitReceipt.hash,
      amountIn: amountIn.toString(),
      priceUsdc,
    });
  } catch (err) {
    console.error("[agent/execute]", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
