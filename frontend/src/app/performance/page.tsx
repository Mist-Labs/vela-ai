import { StatsRow } from "@/components/StatsRow";
import { VelaShell } from "@/components/VelaShell";

const positions = [
  ["ETH/USDC v4", "$18,240", "24.1%", "7.2%", "Allowed"],
  ["WBTC/USDC v4", "$12,050", "18.4%", "6.1%", "Allowed"],
  ["USDC Reserve", "$17,940", "57.5%", "4.0%", "Idle buffer"],
];

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
            <span className="metric-value cyan">$48,230.12</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">30-Day Yield</span>
            <span className="metric-value green">7.3%</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Drawdown</span>
            <span className="metric-value amber">4.1%</span>
          </div>
        </div>
      </section>
      <StatsRow />
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Portfolio Allocation</span>
          <span className="tb-pill pill-cyan">POLICY BOUNDED</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Position</th>
              <th>Value</th>
              <th>Allocation</th>
              <th>APY</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((row) => (
              <tr key={row[0]}>
                {row.map((cell, index) => (
                  <td className={index === 3 ? "green" : ""} key={cell}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </VelaShell>
  );
}
