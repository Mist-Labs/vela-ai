"use client";

import { useVelaData } from "./WalletProvider";

const policyChips = [
  "MAX ALLOCATION ENFORCED",
  "STOP-LOSS ENFORCED",
  "TRADING HOURS ENFORCED",
  "UNISWAP v4 HOOK",
  "0G ATTESTATION",
];

export default function PolicyDisplay() {
  const data = useVelaData();

  return (
    <section className="hero">
      <div>
        <div className="eyebrow">Active Policy Intent</div>
        <p className="intent-text">
          {data.policyURI ||
            "Connect a wallet after configuring deployment addresses to load the active policy intent."}
        </p>
        <div className="chip-row">
          {policyChips.map((chip) => (
            <span className="policy-chip" key={chip}>
              {chip}
            </span>
          ))}
        </div>
      </div>
      <div className="hero-stats">
        <div className="metric-row">
          <span className="metric-label">Policy Root</span>
          <span className="metric-value cyan">{data.policyRoot || "--"}</span>
        </div>
        <div className="metric-row">
          <span className="metric-label">Committed</span>
          <span className="metric-value">{data.active ? "Active" : "--"}</span>
        </div>
        <div className="metric-row">
          <span className="metric-label">Conflicts</span>
          <span className="metric-value green">{data.configured ? "Configured" : "Missing env"}</span>
        </div>
        <div className="metric-row">
          <span className="metric-label">Merkle Root</span>
          <span className="metric-value green">{data.policyRoot ? "VALID" : "--"}</span>
        </div>
      </div>
    </section>
  );
}
