import DecisionFeed from "@/components/DecisionFeed";
import LiveMetric from "@/components/LiveMetric";
import { VelaShell } from "@/components/VelaShell";

export default function DecisionsPage() {
  return (
    <VelaShell active="Decisions" eyebrow="DECISION LOG">
      <section className="hero">
        <div>
          <div className="eyebrow">Decision Feed</div>
          <h1>Every agent action is explainable and attestable.</h1>
          <p className="hero-copy">
            Each row represents a signed agent decision with value, rationale,
            expected APY, 0G DA storage, and enclave verification status.
          </p>
        </div>
        <div className="hero-stats">
          <div className="metric-row">
            <span className="metric-label">Total</span>
            <span className="metric-value cyan">
              <LiveMetric field="totalDecisions" />
            </span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Verified</span>
            <span className="metric-value green">
              <LiveMetric field="compliantDecisions" />
            </span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Failures</span>
            <span className="metric-value">0</span>
          </div>
        </div>
      </section>
      <DecisionFeed />
    </VelaShell>
  );
}
