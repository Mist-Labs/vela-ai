"use client";

import { useMemo, useState } from "react";
import ConflictAlert from "./ConflictAlert";
import { useVelaData, useWallet } from "./WalletProvider";
import type { CompiledPolicy } from "@vela/policy-engine";

export default function IntentInput() {
  const wallet = useWallet();
  const data = useVelaData();
  const [intent, setIntent] = useState(
    "Grow my ETH steadily. Never put more than 25% in one pool. Stop if I lose more than 15%. Do not trade between midnight and 6am.",
  );
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [compiled, setCompiled] = useState<CompiledPolicy | null>(null);
  const [compiling, setCompiling] = useState(false);

  const displayPolicy = useMemo(() => {
    if (!compiled) return null;
    const c = compiled.parsed.constraints;
    return {
      allocation: `${(c.max_allocation_per_pool_bps / 100).toFixed(0)}%`,
      stopLoss: `${(c.stop_loss_bps / 100).toFixed(0)}% drawdown`,
      hours: `${String(c.active_hours_start_utc).padStart(2, "0")}:00 - ${String(c.active_hours_end_utc).padStart(2, "0")}:00 UTC`,
      startHour: c.active_hours_start_utc,
      endHour: c.active_hours_end_utc,
      risk: c.risk_profile,
      explanation: compiled.parsed.explanation,
      apyMin: compiled.parsed.estimated_apy_range[0],
      apyMax: compiled.parsed.estimated_apy_range[1],
      policyRoot: compiled.policyRoot,
    };
  }, [compiled]);

  async function compile() {
    setCompiling(true);
    setStatus("");
    setCompiled(null);
    try {
      const res = await fetch("/api/policy/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent }),
      });
      const body = (await res.json()) as CompiledPolicy & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Compilation failed");
      setCompiled(body);
    } catch (err) {
      setStatus(
        err instanceof Error ? err.message : "Policy compilation failed.",
      );
    } finally {
      setCompiling(false);
    }
  }

  async function deployPolicy() {
    if (!compiled) {
      setStatus("Compile your policy first.");
      return;
    }
    setStatus("");
    setPending(true);
    try {
      const c = compiled.parsed.constraints;
      const txHash = await wallet.registerPolicy(
        compiled.policyRoot,
        intent.trim(),
        1,
        c.active_hours_start_utc,
        c.active_hours_end_utc,
      );
      await data.refresh();
      setStatus(`Policy registered on-chain: ${txHash}`);
    } catch (err) {
      setStatus(
        err instanceof Error ? err.message : "Policy registration failed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="form-panel">
      <div className="panel-head">
        <span className="panel-title">Deploy New Vault | Set Your Course</span>
        <span className="tb-pill pill-cyan">POLICY ENGINE</span>
      </div>
      <div className="form-grid">
        <div className="form-section">
          <label className="form-label" htmlFor="intent">
            Investment intent
          </label>
          <textarea
            className="textarea"
            id="intent"
            onChange={(event) => {
              setIntent(event.target.value);
              setCompiled(null);
            }}
            value={intent}
          />
          <div className="actions" style={{ marginBottom: "0.75rem" }}>
            <button
              className="secondary-btn"
              disabled={compiling || !intent.trim()}
              onClick={compile}
              type="button"
            >
              {compiling ? "COMPILING..." : "COMPILE POLICY"}
            </button>
          </div>
          {displayPolicy ? (
            <div className="parse-output">
              <span className="cyan">-&gt;</span> Max allocation per pool:{" "}
              <strong>{displayPolicy.allocation}</strong>
              <br />
              <span className="cyan">-&gt;</span> Stop-loss threshold:{" "}
              <strong>{displayPolicy.stopLoss}</strong>
              <br />
              <span className="cyan">-&gt;</span> Active hours:{" "}
              <strong>{displayPolicy.hours}</strong>
              <br />
              <span className="cyan">-&gt;</span> Risk profile:{" "}
              <strong>{displayPolicy.risk}</strong>
              <br />
              <span className="cyan">-&gt;</span> Estimated APY:{" "}
              <strong>
                {displayPolicy.apyMin}% – {displayPolicy.apyMax}%
              </strong>
              <br />
              <span className="cyan">-&gt;</span> Explanation:{" "}
              <strong>{displayPolicy.explanation}</strong>
              <br />
              <span className="cyan">-&gt;</span> Policy root:{" "}
              <strong>{displayPolicy.policyRoot}</strong>
              {(compiled?.validation.conflicts.length ?? 0) > 0 && (
                <div style={{ marginTop: "0.5rem", color: "var(--amber)" }}>
                  ⚠{" "}
                  {compiled?.validation.conflicts
                    .map((c) => c.message)
                    .join(" · ")}
                </div>
              )}
            </div>
          ) : (
            <div className="parse-output" style={{ color: "var(--muted)" }}>
              Press Compile to run Kimi policy compilation.
            </div>
          )}
        </div>
        <div className="form-section">
          <ConflictAlert />
          <div className="metric-list">
            <div className="metric-row">
              <span className="metric-label">Deposit Asset</span>
              <span className="metric-value">USDC</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Vault Standard</span>
              <span className="metric-value cyan">ERC-4626</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Execution</span>
              <span className="metric-value">Uniswap v4</span>
            </div>
          </div>
          <div className="actions">
            <button
              className="primary-btn"
              disabled={!wallet.connected || pending || !compiled}
              onClick={deployPolicy}
              type="button"
            >
              {pending ? "REGISTERING" : "REGISTER POLICY"}
            </button>
            <button
              className="secondary-btn"
              onClick={() => {
                setIntent("");
                setCompiled(null);
              }}
              type="button"
            >
              CLEAR
            </button>
          </div>
          {status && <p className="form-help">{status}</p>}
        </div>
      </div>
    </section>
  );
}
