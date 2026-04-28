"use client";

import { useMemo, useState } from "react";
import { useVelaData, useWallet } from "./WalletProvider";

export default function DelegateForm() {
  const wallet = useWallet();
  const data = useVelaData();
  const [agent, setAgent] = useState(data.agentAddress);
  const [signature, setSignature] = useState("");
  const [pending, setPending] = useState(false);
  const message = useMemo(
    () =>
      [
        "Vela Agent Delegation",
        `Owner: ${wallet.account || "not-connected"}`,
        `Vault: ${data.vaultAddress || "not-configured"}`,
        `Agent: ${agent || "not-configured"}`,
        `PolicyRoot: ${data.policyRoot || "not-registered"}`,
        `ChainId: ${wallet.chainId ?? "unknown"}`,
      ].join("\n"),
    [agent, data.policyRoot, data.vaultAddress, wallet.account, wallet.chainId],
  );

  async function signDelegation() {
    setSignature("");
    setPending(true);
    try {
      const signed = await wallet.signMessage(message);
      setSignature(signed);
    } catch (err) {
      setSignature(err instanceof Error ? err.message : "Delegation signing failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="form-panel">
      <div className="panel-head">
        <span className="panel-title">Delegation Parameters</span>
        <span className="tb-pill pill-dim">OWNER SIGNATURE REQUIRED</span>
      </div>
      <div className="form-grid">
        <div className="form-section">
          <label className="form-label" htmlFor="agent">
            Agent address
          </label>
          <input
            className="input"
            id="agent"
            onChange={(event) => setAgent(event.target.value)}
            value={agent}
          />
          <p className="form-help">
            The signed authorization binds owner, vault, policy root, chain, and
            agent address for off-chain agent onboarding.
          </p>
        </div>
        <div className="form-section">
          <div className="metric-list">
            <div className="metric-row">
              <span className="metric-label">Vault</span>
              <span className="metric-value">{data.vaultAddress || "--"}</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Policy Root</span>
              <span className="metric-value cyan">{data.policyRoot || "--"}</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Wallet</span>
              <span className="metric-value green">{wallet.account || "--"}</span>
            </div>
          </div>
          <div className="actions">
            <button
              className="primary-btn"
              disabled={!wallet.connected || pending}
              onClick={signDelegation}
              type="button"
            >
              {pending ? "SIGNING" : "SIGN AUTHORIZATION"}
            </button>
          </div>
          {signature && <p className="form-help">{signature}</p>}
        </div>
      </div>
    </section>
  );
}
