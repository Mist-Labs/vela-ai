import DelegateForm from "@/components/DelegateForm";
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
            <span className="metric-label">Allowance</span>
            <span className="metric-value">Policy tier bound</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Status</span>
            <span className="metric-value green">Wallet required</span>
          </div>
        </div>
      </section>
      <DelegateForm />
    </VelaShell>
  );
}
