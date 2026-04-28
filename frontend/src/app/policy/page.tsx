import PolicyDisplay from "@/components/PolicyDisplay";
import { VelaShell } from "@/components/VelaShell";

const constraints = [
  ["max_allocation_per_pool_bps", "2500", "Hook enforced"],
  ["stop_loss_bps", "1500", "Hook enforced"],
  ["active_hours_start_utc", "6", "Hook enforced"],
  ["active_hours_end_utc", "24", "Hook enforced"],
  ["allowed_pools", "ETH_USDC_V4, WBTC_USDC_V4", "Merkle committed"],
  ["max_value_per_tx_usdc", "10000", "Hook enforced"],
];

export default function PolicyPage() {
  return (
    <VelaShell active="Policy" eyebrow="MERKLE ROOT VALID">
      <PolicyDisplay />
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Compiled Constraints</span>
          <span className="tb-pill pill-cyan">LIVE POLICY READ</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Constraint</th>
              <th>Value</th>
              <th>Enforcement</th>
            </tr>
          </thead>
          <tbody>
            {constraints.map((row) => (
              <tr key={row[0]}>
                <td className="cyan">{row[0]}</td>
                <td>{row[1]}</td>
                <td className="green">{row[2]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </VelaShell>
  );
}
