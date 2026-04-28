import { policyChips } from "@/lib/vela-data";

export default function PolicyDisplay() {
  return (
    <section className="hero">
      <div>
        <div className="eyebrow">Active Policy Intent</div>
        <p className="intent-text">
          "Grow my ETH steadily. Never put more than 25% in one pool. Stop if I
          lose more than 15%. Do not trade between midnight and 6am."
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
          <span className="metric-value cyan">0xabc3...d9f1</span>
        </div>
        <div className="metric-row">
          <span className="metric-label">Committed</span>
          <span className="metric-value">Block #9,480,102</span>
        </div>
        <div className="metric-row">
          <span className="metric-label">Conflicts</span>
          <span className="metric-value green">1 RESOLVED</span>
        </div>
        <div className="metric-row">
          <span className="metric-label">Merkle Root</span>
          <span className="metric-value green">VALID</span>
        </div>
      </div>
    </section>
  );
}
