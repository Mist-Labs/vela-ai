import { StatsRow } from "@/components/StatsRow";
import { VelaShell } from "@/components/VelaShell";
import LiveMetric from "@/components/LiveMetric";

export default function PerformancePage() {
  return (
    <VelaShell active="Performance" eyebrow="SHARE PRICE 1.0073">
      <section className="hero">
        <div>
          <div className="eyebrow">Performance</div>
          <h1>NAV is measured through the same price source enforcement uses.</h1>
          <p className="hero-copy">
            Vela keeps ERC-4626 accounting aligned with the Uniswap v4 pool
            price used by the Hook, avoiding oracle divergence between policy
            enforcement and share price.
          </p>
        </div>
        <div className="hero-stats">
          <div className="metric-row">
            <span className="metric-label">NAV</span>
            <span className="metric-value cyan">
              $<LiveMetric field="totalAssets" />
            </span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Decisions</span>
            <span className="metric-value green">
              <LiveMetric field="totalDecisions" />
            </span>
          </div>
        </div>
      </section>
      <StatsRow />
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Portfolio Allocation</span>
          <span className="tb-pill pill-cyan">ERC-4626 LIVE READS</span>
        </div>
        <div className="panel-body">
          <p className="body-copy">
            The current vault contract exposes aggregate ERC-4626 assets and
            decision history. Detailed pool-level allocation can be added when
            the deployed strategy adapter exposes position reads.
          </p>
        </div>
      </section>
    </VelaShell>
  );
}
