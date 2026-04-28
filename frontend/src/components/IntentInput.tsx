import ConflictAlert from "./ConflictAlert";

export default function IntentInput() {
  return (
    <section className="form-panel">
      <div className="panel-head">
        <span className="panel-title">Deploy New Vault | Set Your Course</span>
        <span className="tb-pill pill-cyan">POLICY ENGINE</span>
      </div>
      <div className="form-grid">
        <div className="form-section">
          <label className="form-label" htmlFor="intent">
            Investment intent
          </label>
          <textarea
            className="textarea"
            id="intent"
            defaultValue={
              "Grow my ETH steadily. Never put more than 25% in one pool. Stop if I lose more than 15%. Do not trade between midnight and 6am."
            }
          />
          <div className="parse-output">
            <span className="cyan">-&gt;</span> Max allocation per pool:{" "}
            <strong>25%</strong>
            <br />
            <span className="cyan">-&gt;</span> Stop-loss threshold:{" "}
            <strong>15% drawdown</strong>
            <br />
            <span className="cyan">-&gt;</span> Active hours:{" "}
            <strong>06:00 - 00:00 UTC</strong>
            <br />
            <span className="cyan">-&gt;</span> Risk profile:{" "}
            <strong>Conservative</strong>
            <br />
            <span className="cyan">-&gt;</span> Estimated APY:{" "}
            <strong>4 - 9%</strong>
          </div>
        </div>
        <div className="form-section">
          <ConflictAlert />
          <div className="metric-list">
            <div className="metric-row">
              <span className="metric-label">Deposit Asset</span>
              <span className="metric-value">USDC</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Vault Standard</span>
              <span className="metric-value cyan">ERC-4626</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Execution</span>
              <span className="metric-value">Uniswap v4</span>
            </div>
          </div>
          <div className="actions">
            <button className="primary-btn">CONFIRM & DEPLOY</button>
            <button className="secondary-btn">EDIT POLICY</button>
          </div>
        </div>
      </div>
    </section>
  );
}
