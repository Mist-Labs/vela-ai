import IntentInput from "@/components/IntentInput";
import { VelaShell } from "@/components/VelaShell";

export default function CreateVaultPage() {
  return (
    <VelaShell active="New Vault" eyebrow="POLICY COMPILER">
      <section className="hero">
        <div>
          <div className="eyebrow">New Vault</div>
          <h1>Turn intent into enforceable policy.</h1>
          <p className="hero-copy">
            Describe the portfolio boundaries in plain English. Vela compiles
            them into typed constraints, detects conflicts, and commits the
            resulting Merkle root before the agent can trade.
          </p>
        </div>
        <div className="hero-stats">
          <div className="metric-row">
            <span className="metric-label">Compiler</span>
            <span className="metric-value cyan">NLP -&gt; Constraints</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Root</span>
            <span className="metric-value green">On-chain</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Vault</span>
            <span className="metric-value">ERC-4626</span>
          </div>
        </div>
      </section>
      <IntentInput />
    </VelaShell>
  );
}
