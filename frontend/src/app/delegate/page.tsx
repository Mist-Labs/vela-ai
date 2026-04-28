import { VelaShell } from "@/components/VelaShell";

export default function DelegatePage() {
  return (
    <VelaShell active="Delegate" eyebrow="AGENT AUTHORIZATION">
      <section className="hero">
        <div>
          <div className="eyebrow">Delegate</div>
          <h1>Grant the agent only the authority the policy allows.</h1>
          <p className="hero-copy">
            Delegation binds the vault, policy root, enclave public key, and
            Uniswap v4 Hook address into one constrained execution path.
          </p>
        </div>
        <div className="hero-stats">
          <div className="metric-row">
            <span className="metric-label">Agent</span>
            <span className="metric-value cyan">0x72a4...c11d</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Allowance</span>
            <span className="metric-value">$10,000 / tx</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Status</span>
            <span className="metric-value green">Ready</span>
          </div>
        </div>
      </section>
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
            <input className="input" id="agent" defaultValue="0x72a4...c11d" />
            <p className="form-help">
              The agent can propose trades, but the Hook still blocks any swap
              outside the committed policy.
            </p>
          </div>
          <div className="form-section">
            <div className="metric-list">
              <div className="metric-row">
                <span className="metric-label">Vault</span>
                <span className="metric-value">0x4f2a...b3e1</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">Hook</span>
                <span className="metric-value cyan">0x3c8f...a21e</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">Enclave Key</span>
                <span className="metric-value green">Registered</span>
              </div>
            </div>
            <div className="actions">
              <button className="primary-btn">SIGN DELEGATION</button>
            </div>
          </div>
        </div>
      </section>
    </VelaShell>
  );
}
