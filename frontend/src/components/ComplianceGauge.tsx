"use client";

import { useVelaData } from "./WalletProvider";

export default function ComplianceGauge() {
  const data = useVelaData();
  const score = data.complianceScore || "--";

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Compliance Score</span>
        <span className="tb-pill pill-green">LIVE</span>
      </div>
      <div className="panel-body gauge">
        <div className="gauge-ring">
          <svg className="gauge-svg" width="140" height="140" viewBox="0 0 100 100">
            <circle className="gauge-track" cx="50" cy="50" r="45" />
            <circle className="gauge-fill" cx="50" cy="50" r="45" />
          </svg>
          <div className="gauge-center">
            <div className="gauge-value">{score}</div>
            <div className="gauge-label">COMPLIANCE</div>
          </div>
        </div>
        <div className="metric-list">
          <div className="metric-row">
            <span className="metric-label">Total Decisions</span>
            <span className="metric-value cyan">{data.totalDecisions || "0"}</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">TEE Verified</span>
            <span className="metric-value green">
              {data.compliantDecisions || "0"} / {data.totalDecisions || "0"}
            </span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Hook Blocks</span>
            <span className="metric-value">0</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Auto-Pauses</span>
            <span className="metric-value">0</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">0G DA Records</span>
            <span className="metric-value cyan">
              {data.decisions.length} LOADED
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
