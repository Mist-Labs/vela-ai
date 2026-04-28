import ComplianceGauge from "@/components/ComplianceGauge";
import DecisionFeed from "@/components/DecisionFeed";
import PolicyDisplay from "@/components/PolicyDisplay";
import { StatsRow } from "@/components/StatsRow";
import { VelaShell } from "@/components/VelaShell";

const securityLayers = [
  {
    number: "01",
    name: "Execution Firewall",
    description:
      "Uniswap v4 Hook enforces policy before swaps execute. Violations are blocked at execution time.",
  },
  {
    number: "02",
    name: "Intelligence Integrity",
    description:
      "Agent decisions are designed to be produced in 0G Sealed Inference and stored as verifiable records.",
  },
  {
    number: "03",
    name: "Ambient Monitoring",
    description:
      "The watchtower verifies attestations and can trigger PolicyRegistry circuit breaker protection.",
  },
];

export default function DashboardPage() {
  return (
    <VelaShell active="Dashboard">
      <PolicyDisplay />
      <StatsRow />
      <div className="grid-2">
        <DecisionFeed limit={6} />
        <ComplianceGauge />
      </div>
      <div className="equal-grid">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Security Architecture</span>
            <span className="tb-pill pill-green">3/3 ACTIVE</span>
          </div>
          <div className="panel-body">
            {securityLayers.map((layer) => (
              <div className="layer" key={layer.number}>
                <div className="layer-num">{layer.number}</div>
                <div>
                  <div className="layer-name">
                    {layer.name}
                    <span className="tag active">ACTIVE</span>
                  </div>
                  <div className="layer-desc">{layer.description}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Farcaster Alerts</span>
            <span className="tb-pill pill-dim">@VELA-AGENT</span>
          </div>
          <div className="panel-body page-stack">
            <div className="alert-msg">
              <div className="alert-head">
                <span className="alert-title">Live Alert Channel</span>
                <span className="alert-time">Wallet gated</span>
              </div>
              <div className="alert-body">
                Connect a configured wallet to read vault state. Production
                alert delivery is handled by the watchtower and Farcaster
                notifier service.
              </div>
            </div>
          </div>
        </section>
      </div>
    </VelaShell>
  );
}
