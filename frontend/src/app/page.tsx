import ComplianceGauge from "@/components/ComplianceGauge";
import DecisionFeed from "@/components/DecisionFeed";
import PolicyDisplay from "@/components/PolicyDisplay";
import { StatsRow } from "@/components/StatsRow";
import { VelaShell } from "@/components/VelaShell";
import { AgentTerminal } from "@/components/AgentTerminal";

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

        <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <AgentTerminal />
        </section>
      </div>
    </VelaShell>
  );
}