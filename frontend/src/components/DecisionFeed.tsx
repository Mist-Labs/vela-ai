"use client";

import { useVelaData } from "./WalletProvider";

type DecisionFeedProps = {
  limit?: number;
};

export default function DecisionFeed({ limit }: DecisionFeedProps) {
  const data = useVelaData();
  const visible =
    typeof limit === "number" ? data.decisions.slice(0, limit) : data.decisions;

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Decision Feed</span>
        <span className="tb-pill pill-cyan">LIVE</span>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Status</th>
            <th>Reason</th>
            <th>Timestamp</th>
            <th>0G CID</th>
            <th>Decision Hash</th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td colSpan={6}>
                {data.configured
                  ? "Connect a wallet to load live decisions from the vault."
                  : "Deployment addresses are not configured."}
              </td>
            </tr>
          )}
          {visible.map((decision) => (
            <tr key={decision.id}>
              <td className="cyan">#{decision.id}</td>
              <td>{decision.status}</td>
              <td className="truncate-cell">{decision.explanation}</td>
              <td>{new Date(decision.timestamp).toLocaleString()}</td>
              <td className="green">{decision.evidenceCID}</td>
              <td>
                <span className="status">
                  <span className="tee-dot-sm" />
                  {decision.decisionHash}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
