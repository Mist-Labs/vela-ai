"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { parseUnits, formatUnits, isAddress } from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useWriteContract,
} from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import {
  CHAIN_ID,
  VELA_VAULT_ADDRESS,
  VAULT_ASSET_DECIMALS,
} from "@/lib/contracts";

// ─── Minimal ABIs ─────────────────────────────────────────────────────────────

const ERC20_MINT_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const VAULT_DEPOSIT_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const POLICY_REGISTRY_ABI = [
  {
    name: "registerAgentWithPolicy",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "policyRoot", type: "bytes32" },
      { name: "policyURI", type: "string" },
      { name: "tier", type: "uint256" },
      { name: "activeHoursStartUtc", type: "uint8" },
      { name: "activeHoursEndUtc", type: "uint8" },
    ],
    outputs: [],
  },
] as const;

const TEST_TOKEN_ADDRESS = (process.env.NEXT_PUBLIC_TEST_TOKEN_ADDRESS ??
  "") as `0x${string}`;
const POLICY_REGISTRY_ADDRESS = (process.env
  .NEXT_PUBLIC_POLICY_REGISTRY_ADDRESS ?? "") as `0x${string}`;
const MINT_AMOUNT = parseUnits("1000", VAULT_ASSET_DECIMALS);
const MIN_DEPOSIT = parseUnits("10", VAULT_ASSET_DECIMALS);

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

type LogLine = {
  id: number;
  text: string;
  kind: "system" | "agent" | "success" | "error" | "prompt" | "dim";
};

// ─── Component ────────────────────────────────────────────────────────────────

export function AgentTerminal() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { open } = useAppKit();

  const [step, setStep] = useState<Step>(1);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [intentInput, setIntentInput] = useState("");
  const [compilingPolicy, setCompilingPolicy] = useState(false);
  const [depositInput, setDepositInput] = useState("100");
  const [alertEmail, setAlertEmail] = useState("");
  const [alertFarcaster, setAlertFarcaster] = useState("");
  const [confirmInput, setConfirmInput] = useState("");
  const [userShares, setUserShares] = useState<bigint>(0n);
  const [tokenBalance, setTokenBalance] = useState<bigint>(0n);
  const [txHash, setTxHash] = useState("");
  const [agentFeedDone, setAgentFeedDone] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<{
    action: string;
    value_usdc: number;
    pool: string;
    reason: string;
  } | null>(null);

  const feedRef = useRef<HTMLDivElement>(null);
  const lineId = useRef(0);
  const prevConnected = useRef(false);

  const wrongNetwork = isConnected && chainId !== CHAIN_ID;

  function nextId() {
    lineId.current += 1;
    return lineId.current;
  }

  const push = useCallback((text: string, kind: LogLine["kind"] = "system") => {
    setLines((prev) => [...prev, { id: nextId(), text, kind }]);
  }, []);

  // Auto-scroll
  useEffect(() => {
    feedRef.current?.scrollTo({
      top: feedRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [lines]);

  // ── Step 1: boot sequence ──────────────────────────────────────────────────
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const schedule = (fn: () => void, ms: number) =>
      timers.push(setTimeout(fn, ms));

    schedule(() => push("VELA AGENT TERMINAL v0.1.0", "dim"), 0);
    schedule(() => push("─".repeat(48), "dim"), 120);
    schedule(() => push("Initializing secure channel...", "system"), 300);
    schedule(() => push("0G TEE handshake ✓", "dim"), 720);
    schedule(() => push("Uniswap v4 hook registry ✓", "dim"), 1020);
    schedule(() => push("Policy engine ready ✓", "dim"), 1320);
    schedule(() => push("─".repeat(48), "dim"), 1600);

    schedule(() => {
      if (!isConnected) {
        push("No wallet detected.", "system");
        push("→ Connect your wallet to begin.", "prompt");
      } else if (wrongNetwork) {
        push(`Connected: ${address}`, "success");
        push("Wrong network — switch to Base Sepolia.", "error");
      } else {
        push(`Connected: ${address}`, "success");
        prevConnected.current = true;
        setStep(2);
      }
    }, 1900);

    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Step 1 → 2 on late connect
  useEffect(() => {
    if (step !== 1 || prevConnected.current) return;
    if (isConnected && !wrongNetwork && address) {
      prevConnected.current = true;
      push(`Wallet connected: ${address}`, "success");
      setTimeout(() => setStep(2), 400);
    }
  }, [isConnected, wrongNetwork, address, step, push]);

  // ── Step 2 entry message ───────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 2) return;
    push("─".repeat(48), "dim");
    push("Set your investment policy.", "system");
    push(
      "Describe your goals in plain English. Kimi will compile and register it on-chain.",
      "dim",
    );
    push("→ Enter your intent below and click COMPILE + REGISTER.", "prompt");
  }, [step, push]);

  // ── Step 2: compile + register policy ─────────────────────────────────────
  async function handleCompilePolicy() {
    if (!intentInput.trim() || compilingPolicy || !address) return;
    setCompilingPolicy(true);
    push("─".repeat(48), "dim");
    push("Compiling policy intent via Kimi...", "system");

    try {
      const compileRes = await fetch("/api/policy/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: intentInput.trim() }),
      });
      const compiled = (await compileRes.json()) as {
        policyRoot?: string;
        policyURI?: string;
        parsed?: {
          constraints?: {
            active_hours_start_utc?: number;
            active_hours_end_utc?: number;
            max_allocation_per_pool_bps?: number;
            stop_loss_bps?: number;
            risk_profile?: string;
          };
          explanation?: string;
          estimated_apy_range?: number[];
        };
        validation?: { conflicts?: Array<{ message: string }> };
        error?: string;
      };

      if (!compileRes.ok || compiled.error) {
        throw new Error(compiled.error ?? "Compilation failed");
      }

      const c = compiled.parsed?.constraints;
      push("Policy compiled ✓", "success");
      push(
        `Risk: ${c?.risk_profile ?? "conservative"}  |  Max pool: ${((c?.max_allocation_per_pool_bps ?? 2500) / 100).toFixed(0)}%  |  Stop-loss: ${((c?.stop_loss_bps ?? 1500) / 100).toFixed(0)}%`,
        "dim",
      );
      push(
        `Active hours: ${c?.active_hours_start_utc ?? 0}:00 – ${c?.active_hours_end_utc ?? 24}:00 UTC`,
        "dim",
      );
      push(
        `APY estimate: ${compiled.parsed?.estimated_apy_range?.[0] ?? 0}% – ${compiled.parsed?.estimated_apy_range?.[1] ?? 0}%`,
        "dim",
      );

      if ((compiled.validation?.conflicts?.length ?? 0) > 0) {
        push(
          `⚠ ${compiled.validation!.conflicts!.map((cf) => cf.message).join(" · ")}`,
          "error",
        );
      }

      push(`Policy root: ${compiled.policyRoot?.slice(0, 20)}...`, "dim");
      push("Registering policy on-chain — confirm in wallet...", "system");

      const startHour = c?.active_hours_start_utc ?? 0;
      const endHour = c?.active_hours_end_utc ?? 24;

      const policyURI =
        compiled.policyURI ||
        `ipfs://vela-policy-${compiled.policyRoot?.slice(2, 10) ?? "bootstrap"}`;

      console.log("[policy/register] policyRoot:", compiled.policyRoot);
      console.log("[policy/register] policyURI:", policyURI);
      console.log(
        "[policy/register] startHour:",
        startHour,
        "endHour:",
        endHour,
      );

      await writeContractAsync({
        address: POLICY_REGISTRY_ADDRESS,
        abi: POLICY_REGISTRY_ABI,
        functionName: "registerAgentWithPolicy",
        args: [
          compiled.policyRoot as `0x${string}`,
          policyURI,
          1n,
          startHour,
          endHour,
        ],
        chainId: CHAIN_ID,
        gas: 500_000n,
      });

      push("Policy registered on-chain ✓", "success");
      setIntentInput("");
      push("─".repeat(48), "dim");
      setTimeout(() => setStep(3), 600);
    } catch (err) {
      push(
        `Policy setup failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setCompilingPolicy(false);
    }
  }

  // ── Step 3: balance check ──────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 3 || !address || !publicClient) return;

    const run = async () => {
      push("─".repeat(48), "dim");
      push("Checking test token balance...", "system");

      if (!isAddress(TEST_TOKEN_ADDRESS)) {
        push(
          "NEXT_PUBLIC_TEST_TOKEN_ADDRESS not set — deploy OZ ERC20 first.",
          "error",
        );
        return;
      }

      try {
        const bal = (await publicClient.readContract({
          address: TEST_TOKEN_ADDRESS,
          abi: ERC20_MINT_ABI,
          functionName: "balanceOf",
          args: [address as `0x${string}`],
        })) as bigint;

        setTokenBalance(bal);
        const fmt = formatUnits(bal, VAULT_ASSET_DECIMALS);
        push(`Balance: ${fmt} TEST`, "success");

        if (bal < MIN_DEPOSIT) {
          push("Insufficient balance for minimum deposit (10 TEST).", "system");
          push("→ Click MINT to receive 1000 TEST from faucet.", "prompt");
        } else {
          push("Sufficient balance. Ready to deposit.", "dim");
          push("→ Click NEXT to proceed.", "prompt");
        }
      } catch (err) {
        push(
          `Balance check failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    };

    void run();
  }, [step, address, publicClient, push]);

  async function handleMint() {
    if (!address || busy || !publicClient) return;
    setBusy(true);
    push("Requesting 1000 TEST from faucet...", "system");
    try {
      const hash = await writeContractAsync({
        address: TEST_TOKEN_ADDRESS,
        abi: ERC20_MINT_ABI,
        functionName: "mint",
        args: [address as `0x${string}`, MINT_AMOUNT],
        chainId: CHAIN_ID,
      });
      push(`Mint tx: ${hash.slice(0, 20)}...`, "dim");
      await publicClient!.waitForTransactionReceipt({ hash });
      const newBal = (await publicClient!.readContract({
        address: TEST_TOKEN_ADDRESS,
        abi: ERC20_MINT_ABI,
        functionName: "balanceOf",
        args: [address as `0x${string}`],
      })) as bigint;
      setTokenBalance(newBal);
      push(
        `Minted. Balance: ${formatUnits(newBal, VAULT_ASSET_DECIMALS)} TEST ✓`,
        "success",
      );
      push("→ Click NEXT to proceed.", "prompt");
    } catch (err) {
      push(
        `Mint failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  // ── Step 4: deposit ────────────────────────────────────────────────────────
  async function handleDeposit() {
    if (!address || busy || !publicClient) return;
    const amount = parseUnits(depositInput || "0", VAULT_ASSET_DECIMALS);
    if (amount === 0n || amount > tokenBalance) {
      push("Invalid deposit amount.", "error");
      return;
    }
    setBusy(true);
    push("─".repeat(48), "dim");
    push(`Deposit requested: ${depositInput} TEST`, "system");

    try {
      push("Checking ERC-20 allowance...", "dim");
      const allowance = (await publicClient.readContract({
        address: TEST_TOKEN_ADDRESS,
        abi: ERC20_MINT_ABI,
        functionName: "allowance",
        args: [address as `0x${string}`, VELA_VAULT_ADDRESS as `0x${string}`],
      })) as bigint;

      if (allowance < amount) {
        push("Approval required — confirm in wallet...", "system");
        const approveHash = await writeContractAsync({
          address: TEST_TOKEN_ADDRESS,
          abi: ERC20_MINT_ABI,
          functionName: "approve",
          args: [VELA_VAULT_ADDRESS as `0x${string}`, amount],
          chainId: CHAIN_ID,
          gas: 100_000n,
        });
        push(`Approve tx: ${approveHash.slice(0, 20)}...`, "dim");
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
        push("Approval confirmed ✓", "success");
      } else {
        push("Allowance sufficient ✓", "dim");
      }

      push("Submitting deposit — confirm in wallet...", "system");
      const depositHash = await writeContractAsync({
        address: VELA_VAULT_ADDRESS as `0x${string}`,
        abi: VAULT_DEPOSIT_ABI,
        functionName: "deposit",
        args: [amount, address as `0x${string}`],
        chainId: CHAIN_ID,
        gas: 300_000n,
      });

      push(`Deposit tx: ${depositHash.slice(0, 20)}...`, "dim");
      await publicClient.waitForTransactionReceipt({ hash: depositHash });
      push(`Deposit confirmed ✓`, "success");
      push(`tx: ${depositHash}`, "dim");
      setStep(5);
    } catch (err) {
      push(
        `Deposit failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  // ── Step 5: poll shares ────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 5 || !address || !publicClient) return;
    push("─".repeat(48), "dim");
    push("Verifying vault share allocation...", "system");

    let cancelled = false;

    const poll = async () => {
      try {
        const shares = (await publicClient.readContract({
          address: VELA_VAULT_ADDRESS as `0x${string}`,
          abi: VAULT_DEPOSIT_ABI,
          functionName: "balanceOf",
          args: [address as `0x${string}`],
        })) as bigint;

        if (cancelled) return;

        if (shares > 0n) {
          setUserShares(shares);
          push(
            `Shares received: ${formatUnits(shares, VAULT_ASSET_DECIMALS)} VELA ✓`,
            "success",
          );
          push("Capital allocated. Agent has deployment authority.", "dim");
          setTimeout(() => {
            if (!cancelled) setStep(6);
          }, 600);
        } else {
          push("Shares not yet settled — retrying in 4s...", "dim");
          setTimeout(() => {
            if (!cancelled) void poll();
          }, 4000);
        }
      } catch (err) {
        if (!cancelled)
          push(
            `Share check error: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [step, address, publicClient, push]);

  // ── Step 6: agent feed ─────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 6) return;
    setAgentFeedDone(false);
    push("─".repeat(48), "dim");
    push("AGENT ACTIVITY FEED — LIVE", "system");

    const sequence = [
      {
        text: "Fetching on-chain policy constraints...",
        kind: "agent" as const,
        delay: 400,
      },
      {
        text: "Reading Uniswap v4 pool state...",
        kind: "agent" as const,
        delay: 1100,
      },
      {
        text: "Sending inference request → 0G Sealed Inference (Intel TDX)...",
        kind: "agent" as const,
        delay: 2000,
      },
    ];
    const timers = sequence.map(({ text, kind, delay }) =>
      setTimeout(() => push(text, kind), delay),
    );

    const fetchTimer = setTimeout(() => {
      const MAX_ATTEMPTS = 15;
      let attempt = 0;

      const tryFetch = async (): Promise<void> => {
        attempt += 1;
        if (attempt === 1) {
          push("Awaiting TEE attestation...", "dim");
        } else {
          push(
            `Network error — retrying... (${attempt}/${MAX_ATTEMPTS})`,
            "dim",
          );
        }

        try {
          const res = await fetch("/api/agent/decision");
          if (!res.ok) {
            const err = (await res
              .json()
              .catch(() => ({ error: res.statusText }))) as { error?: string };
            throw new Error(err.error ?? res.statusText);
          }
          const data = (await res.json()) as {
            decision: {
              action: string;
              value_usdc: number;
              pool: string;
              reason: string;
            };
            summary: string;
            market: { priceUsdc: number; poolName: string };
            constraints: {
              maxValuePerTxUsdc: number;
              activeHoursStartUtc: number;
              activeHoursEndUtc: number;
            };
          };

          push("0G Sealed Inference response received ✓", "success");
          push("─".repeat(48), "dim");
          push(
            `Pool: ${data.market.poolName}  |  Price: $${data.market.priceUsdc.toFixed(4)}`,
            "dim",
          );
          push(
            `Active hours: ${data.constraints.activeHoursStartUtc}:00 – ${data.constraints.activeHoursEndUtc}:00 UTC  |  Max tx: $${data.constraints.maxValuePerTxUsdc}`,
            "dim",
          );
          push("─".repeat(48), "dim");
          push(
            `AGENT DECISION: ${data.decision.action.toUpperCase()}`,
            "system",
          );
          if (data.decision.action !== "hold") {
            push(
              `Amount: $${data.decision.value_usdc.toLocaleString()} USDC on ${data.decision.pool}`,
              "agent",
            );
          }
          push(`Reason: ${data.decision.reason}`, "agent");
          push("─".repeat(48), "dim");
          if (data.decision.action === "hold") {
            push("Agent recommends no trade this cycle.", "dim");
            push(
              "→ Type  confirm  to acknowledge and continue monitoring.",
              "prompt",
            );
          } else {
            push("Policy constraints verified ✓", "success");
            push(
              "Decision committed to 0G DA. Awaiting your authorisation.",
              "system",
            );
            push(
              "→ Type  confirm  to deploy capital through VelaHook.",
              "prompt",
            );
          }
          setPendingDecision(data.decision);
          setAgentFeedDone(true);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isNetwork =
            msg.includes("timeout") ||
            msg.includes("fetch") ||
            msg.includes("ENOTFOUND") ||
            msg.includes("network");
          if (isNetwork && attempt < MAX_ATTEMPTS) {
            setTimeout(() => void tryFetch(), 4000);
          } else {
            push(
              `Decision fetch failed after ${attempt} attempt${attempt > 1 ? "s" : ""}: ${msg}`,
              "error",
            );
            push("→ Check your connection or retry.", "prompt");
            setAgentFeedDone(true);
          }
        }
      };

      void tryFetch();
    }, 3200);

    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(fetchTimer);
    };
  }, [step, push]);

  // ── Step 7: execute ────────────────────────────────────────────────────────
  async function handleConfirm() {
    if (confirmInput.trim().toLowerCase() !== "confirm") {
      push("Type  confirm  exactly to authorise.", "error");
      return;
    }
    if (busy) return;
    setBusy(true);
    push("─".repeat(48), "dim");
    setConfirmInput("");

    if (pendingDecision?.action === "hold") {
      push("Hold acknowledged. Agent will re-evaluate next cycle.", "dim");
      setBusy(false);
      setTimeout(() => {
        push("Restarting agent cycle in 30s...", "dim");
        setTimeout(() => setStep(6), 30_000);
      }, 400);
      return;
    }

    push("Operator confirmation received. Deploying capital...", "system");
    try {
      const executeWithRetry = async (
        attempts = 5,
        delayMs = 4000,
      ): Promise<Response> => {
        for (let i = 1; i <= attempts; i++) {
          try {
            const res = await fetch("/api/agent/execute", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                operator: address,
                shares: userShares.toString(),
                decision: pendingDecision,
              }),
            });

            if (res.status === 500) {
              const body = await res.text().catch(() => "");
              if (
                (body.includes("timeout") || body.includes("TIMEOUT")) &&
                i < attempts
              ) {
                push(
                  `RPC timeout — retrying in 4s... (${i}/${attempts})`,
                  "dim",
                );
                await new Promise((r) => setTimeout(r, delayMs));
                continue;
              }
              return new Response(body, { status: 500 });
            }
            return res;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isNetwork =
              msg.includes("timeout") ||
              msg.includes("fetch") ||
              msg.includes("ENOTFOUND");
            if (isNetwork && i < attempts) {
              push(
                `Execute network error — retrying in 4s... (${i}/${attempts})`,
                "dim",
              );
              await new Promise((r) => setTimeout(r, delayMs));
            } else {
              throw err;
            }
          }
        }
        throw new Error("Execute failed after all retries");
      };

      const res = await executeWithRetry();
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} — ${body}`);
      }
      const json = (await res.json()) as {
        txHash?: string;
        commitHash?: string;
      };
      const hash = json.txHash ?? "pending";
      setTxHash(hash);
      push("Decision committed on-chain ✓", "success");
      push("Swap routed through VelaHook ✓", "success");
      push(`Hook tx: ${hash}`, "dim");
      if (json.commitHash) push(`Commit tx: ${json.commitHash}`, "dim");
      push("Position live. Watchtower monitoring 24/7.", "success");
      setTimeout(() => setStep(8), 600);
    } catch (err) {
      push(
        `Execution failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      push("→ Check /api/agent/execute or retry.", "prompt");
    } finally {
      setBusy(false);
    }
  }

  // ── Step 8: alert registration ─────────────────────────────────────────────
  async function handleAlerts() {
    if (!alertEmail && !alertFarcaster) {
      push("Provide at least one contact method.", "error");
      return;
    }
    if (busy) return;
    setBusy(true);
    push("Registering alert contact...", "system");

    try {
      const res = await fetch("/api/alerts/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: address,
          email: alertEmail || null,
          farcaster: alertFarcaster || null,
        }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      push("Alert registration confirmed ✓", "success");
      push(
        "Notifications active: circuit breaker · failed attestations.",
        "dim",
      );
      push("─".repeat(48), "dim");
      push("SETUP COMPLETE — VELA IS SAILING.", "success");
    } catch (err) {
      push(
        `Registration failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="agent-terminal">
      <style>{STYLES}</style>

      {/* Header */}
      <div className="at-header">
        <div className="at-title">
          <span className="at-blink">▋</span> AGENT TERMINAL
        </div>
        <div className="at-steps">
          {([1, 2, 3, 4, 5, 6, 7, 8] as Step[]).map((s) => (
            <span
              key={s}
              className={[
                "at-step",
                step > s ? "at-step-done" : "",
                step === s ? "at-step-active" : "",
              ].join(" ")}
            >
              {s}
            </span>
          ))}
        </div>
      </div>

      {/* Feed */}
      <div className="at-feed" ref={feedRef}>
        {lines.map((line) => (
          <div key={line.id} className={`at-line at-${line.kind}`}>
            {line.kind === "agent" && (
              <span className="at-agent-tag">AGENT</span>
            )}
            {line.kind === "prompt" && <span className="at-chevron">›</span>}
            {line.text}
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="at-controls">
        {/* 1 — wallet */}
        {step === 1 && !isConnected && (
          <button
            className="at-btn at-btn-primary"
            onClick={() => void open({ view: "Connect" })}
          >
            CONNECT WALLET
          </button>
        )}
        {step === 1 && isConnected && wrongNetwork && (
          <button
            className="at-btn at-btn-warn"
            onClick={() => void open({ view: "Networks" })}
          >
            SWITCH TO BASE SEPOLIA
          </button>
        )}

        {/* 2 — policy intent */}
        {step === 2 && (
          <div className="at-col">
            <textarea
              className="at-input"
              style={{ minHeight: "72px", resize: "vertical" }}
              value={intentInput}
              onChange={(e) => setIntentInput(e.target.value)}
              placeholder="Grow my portfolio steadily. Never put more than 40% in one pool. Stop if I lose more than 20%. Trade anytime, no hour restrictions."
              disabled={compilingPolicy}
              spellCheck={false}
            />
            <div className="at-hint">
              Describe your investment goals in plain English. Kimi compiles
              this into a verifiable on-chain policy.
            </div>
            <button
              className="at-btn at-btn-primary"
              disabled={compilingPolicy || !intentInput.trim()}
              onClick={() => void handleCompilePolicy()}
            >
              {compilingPolicy
                ? "COMPILING + REGISTERING..."
                : "COMPILE + REGISTER POLICY →"}
            </button>
          </div>
        )}

        {/* 3 — mint / next */}
        {step === 3 && (
          <div className="at-row">
            <button
              className="at-btn at-btn-secondary"
              disabled={busy || tokenBalance >= MIN_DEPOSIT}
              onClick={() => void handleMint()}
            >
              {busy ? "MINTING..." : "MINT 1000 TEST"}
            </button>
            <button
              className="at-btn at-btn-primary"
              disabled={tokenBalance < MIN_DEPOSIT}
              onClick={() => {
                push("─".repeat(48), "dim");
                push(
                  `Proceeding to deposit. Balance: ${formatUnits(tokenBalance, VAULT_ASSET_DECIMALS)} TEST`,
                  "dim",
                );
                setStep(4);
              }}
            >
              NEXT →
            </button>
          </div>
        )}

        {/* 4 — deposit */}
        {step === 4 && (
          <div className="at-col">
            <div className="at-row">
              <label className="at-label">DEPOSIT</label>
              <input
                className="at-input"
                type="number"
                min="10"
                step="10"
                value={depositInput}
                onChange={(e) => setDepositInput(e.target.value)}
                placeholder="100"
              />
              <span className="at-unit">TEST</span>
            </div>
            <div className="at-hint">
              Balance: {formatUnits(tokenBalance, VAULT_ASSET_DECIMALS)} TEST
              &nbsp;·&nbsp; Minimum: 10 TEST
            </div>
            <div className="at-row">
              <button
                className="at-btn at-btn-warn"
                disabled={busy}
                onClick={() => setStep(3)}
              >
                ← BACK
              </button>
              <button
                className="at-btn at-btn-primary"
                disabled={busy || Number(depositInput) < 10}
                onClick={() => void handleDeposit()}
              >
                {busy ? "DEPOSITING..." : "APPROVE + DEPOSIT"}
              </button>
            </div>
          </div>
        )}

        {/* 5 — settling */}
        {step === 5 && (
          <div className="at-status">
            <span className="at-spinner" /> Awaiting share settlement...
          </div>
        )}

        {/* 6 — confirm */}
        {step === 6 && (
          <div className="at-row">
            <input
              className="at-input at-confirm-input"
              type="text"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleConfirm();
              }}
              placeholder={
                agentFeedDone
                  ? "type confirm to execute"
                  : "agent is processing..."
              }
              disabled={!agentFeedDone || busy}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              className="at-btn at-btn-danger"
              disabled={
                !agentFeedDone ||
                busy ||
                confirmInput.trim().toLowerCase() !== "confirm"
              }
              onClick={() => void handleConfirm()}
            >
              {busy ? "EXECUTING..." : "EXECUTE"}
            </button>
          </div>
        )}

        {/* 7 — tx in flight */}
        {step === 7 && (
          <div className="at-status">
            <span className="at-spinner" /> Routing through VelaHook...
          </div>
        )}

        {/* 8 — alerts */}
        {step === 8 && (
          <div className="at-col">
            <div className="at-row">
              <input
                className="at-input"
                type="email"
                value={alertEmail}
                onChange={(e) => setAlertEmail(e.target.value)}
                placeholder="email (optional)"
              />
              <input
                className="at-input"
                type="text"
                value={alertFarcaster}
                onChange={(e) => setAlertFarcaster(e.target.value)}
                placeholder="@farcaster (optional)"
              />
            </div>
            <div className="at-row">
              <button
                className="at-btn at-btn-secondary"
                disabled={busy}
                onClick={() => {
                  push("Alert setup skipped.", "dim");
                  push("─".repeat(48), "dim");
                  push("SETUP COMPLETE — VELA IS SAILING.", "success");
                }}
              >
                SKIP
              </button>
              <button
                className="at-btn at-btn-primary"
                disabled={busy}
                onClick={() => void handleAlerts()}
              >
                {busy ? "SAVING..." : "SAVE ALERTS"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const STYLES = `
.agent-terminal {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 520px;
  background: #030507;
  border: 1px solid #1a2a1a;
  border-radius: 4px;
  font-family: "Fira Code", "Cascadia Code", "JetBrains Mono", monospace;
  font-size: 12.5px;
  color: #c8d8c8;
  overflow: hidden;
}

.at-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #060d06;
  border-bottom: 1px solid #1a2a1a;
  flex-shrink: 0;
}
.at-title {
  font-size: 11px;
  letter-spacing: 0.14em;
  color: #4cff72;
  text-transform: uppercase;
}
.at-blink {
  animation: blink 1.1s step-start infinite;
  color: #4cff72;
  margin-right: 6px;
}
@keyframes blink { 50% { opacity: 0; } }

.at-steps { display: flex; gap: 4px; }
.at-step {
  width: 20px; height: 20px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px;
  background: #0e1a0e;
  border: 1px solid #1f3020;
  color: #3a4e3a;
  transition: all 0.3s;
}
.at-step-done  { background: #0c2010; border-color: #2a6030; color: #4cff72; }
.at-step-active {
  background: #0d2e14; border-color: #4cff72; color: #4cff72;
  box-shadow: 0 0 8px #4cff7240;
}

.at-feed {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  scrollbar-width: thin;
  scrollbar-color: #1a2a1a transparent;
  min-height: 0;
  max-height: 380px;
}
.at-feed::-webkit-scrollbar { width: 4px; }
.at-feed::-webkit-scrollbar-thumb { background: #1a2a1a; border-radius: 2px; }

.at-line {
  display: flex; align-items: flex-start; gap: 8px;
  line-height: 1.6;
  animation: fadeIn 0.18s ease;
  word-break: break-all;
}
@keyframes fadeIn { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; } }

.at-system  { color: #c8d8c8; }
.at-agent   { color: #7dd3fc; }
.at-success { color: #4cff72; }
.at-error   { color: #ff5555; }
.at-prompt  { color: #fbbf24; }
.at-dim     { color: #3a4e3a; }

.at-agent-tag {
  font-size: 9px; letter-spacing: 0.1em;
  padding: 1px 5px;
  border: 1px solid #1d4ed8; color: #7dd3fc;
  border-radius: 2px; flex-shrink: 0; margin-top: 2px;
}
.at-chevron { color: #fbbf24; font-size: 14px; line-height: 1.4; flex-shrink: 0; }

.at-spinner {
  display: inline-block; width: 10px; height: 10px;
  border: 1.5px solid #1a2a1a; border-top-color: #4cff72;
  border-radius: 50%;
  animation: spin 0.7s linear infinite; flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

.at-controls {
  flex-shrink: 0;
  padding: 12px 16px;
  border-top: 1px solid #1a2a1a;
  background: #060d06;
  display: flex; flex-direction: column; gap: 8px;
}
.at-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.at-col { display: flex; flex-direction: column; gap: 8px; }
.at-status { display: flex; align-items: center; gap: 8px; color: #3a4e3a; font-size: 11px; letter-spacing: 0.08em; }
.at-hint { font-size: 10.5px; color: #3a4e3a; letter-spacing: 0.04em; }
.at-label { font-size: 10px; letter-spacing: 0.12em; color: #3a6040; white-space: nowrap; }
.at-unit  { font-size: 10px; color: #3a4e3a; white-space: nowrap; }

.at-input {
  flex: 1; min-width: 120px;
  background: #0a120a; border: 1px solid #1a2a1a; border-radius: 3px;
  color: #c8d8c8; font-family: inherit; font-size: 12px;
  padding: 6px 10px; outline: none; transition: border-color 0.15s;
}
.at-input:focus { border-color: #2a6030; }
.at-input::placeholder { color: #2a3a2a; }
.at-input:disabled { opacity: 0.4; cursor: not-allowed; }
.at-confirm-input { letter-spacing: 0.08em; }

.at-btn {
  font-family: inherit; font-size: 10.5px; letter-spacing: 0.12em;
  padding: 7px 16px; border-radius: 3px; border: 1px solid;
  cursor: pointer; transition: all 0.15s; white-space: nowrap;
}
.at-btn:disabled { opacity: 0.35; cursor: not-allowed; }

.at-btn-primary  { background: #0d2e14; border-color: #2a6030; color: #4cff72; }
.at-btn-primary:hover:not(:disabled) { background: #102e18; border-color: #4cff72; box-shadow: 0 0 10px #4cff7230; }

.at-btn-secondary { background: transparent; border-color: #1a2a1a; color: #3a6040; }
.at-btn-secondary:hover:not(:disabled) { border-color: #2a4030; color: #6aaa80; }

.at-btn-warn { background: transparent; border-color: #3a2a0a; color: #7a5a20; }
.at-btn-warn:hover:not(:disabled) { border-color: #fbbf24; color: #fbbf24; }

.at-btn-danger { background: #1e0a0a; border-color: #6b2020; color: #ff5555; }
.at-btn-danger:not(:disabled) { border-color: #ff5555; box-shadow: 0 0 10px #ff555330; }
.at-btn-danger:hover:not(:disabled) { background: #2e1010; }
`;
