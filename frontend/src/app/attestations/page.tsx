import { VelaShell } from "@/components/VelaShell";
import DecisionFeed from "@/components/DecisionFeed";

export default function AttestationsPage() {
  return (
    <VelaShell active="Attestations" eyebrow="0G DA RECORDS">
      <section className="hero">
        <div>
          <div className="eyebrow">Attestations</div>
          <h1>Decision provenance is signed by the enclave.</h1>
          <p className="hero-copy">
            Each agent output carries the model identity, enclave key, 0G DA
            content ID, and on-chain hash commitment required to verify the
            reasoning path.
          </p>
        </div>
        <div className="hero-stats">
          <div className="metric-row">
            <span className="metric-label">TEE</span>
            <span className="metric-value cyan">Intel TDX</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Model</span>
            <span className="metric-value">0G sealed inference</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Verified</span>
            <span className="metric-value green">100%</span>
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Recent Attestation Records</span>
          <span className="tb-pill pill-cyan">VAULT READ</span>
        </div>
      </section>
      <DecisionFeed />
    </VelaShell>
  );
}
