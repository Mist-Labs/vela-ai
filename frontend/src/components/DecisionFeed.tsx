import { decisions } from "@/lib/vela-data";

type DecisionFeedProps = {
  limit?: number;
};

export default function DecisionFeed({ limit }: DecisionFeedProps) {
  const visible = typeof limit === "number" ? decisions.slice(0, limit) : decisions;

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
            <th>Action</th>
            <th>Reason</th>
            <th>Value</th>
            <th>APY</th>
            <th>TEE Status</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((decision) => (
            <tr key={decision.id}>
              <td className="cyan">{decision.id}</td>
              <td>{decision.action}</td>
              <td className="truncate-cell">{decision.reason}</td>
              <td>{decision.value}</td>
              <td className="green">{decision.apy}</td>
              <td>
                <span className="status">
                  <span className="tee-dot-sm" />
                  {decision.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
