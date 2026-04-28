import { VelaShell } from "@/components/VelaShell";

export default function WatchtowerPage() {
  return (
    <VelaShell active="Watchtower" eyebrow="30S POLLING">
      <section className="hero">
        <div>
          <div className="eyebrow">Watchtower</div>
          <h1>Real-time verification without a challenge window.</h1>
          <p className="hero-copy">
            The watchtower fetches 0G DA records, validates enclave signatures,
            checks committed hashes, and auto-pauses the vault on integrity
            failures.
          </p>
        </div>
        <div className="hero-stats">
          <div className="metric-row">
            <span className="metric-label">Last Poll</span>
            <span className="metric-value green">Service managed</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Auto-Pauses</span>
            <span className="metric-value">0</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Farcaster</span>
            <span className="metric-value cyan">@vela-agent</span>
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Alert Stream</span>
          <span className="tb-pill pill-green">LIVE</span>
        </div>
        <div className="panel-body page-stack">
          <div className="alert-msg">
            <div className="alert-head">
              <span className="alert-title">Watchtower Endpoint</span>
              <span className="alert-time">Configured off-chain</span>
            </div>
            <div className="alert-body">
              The deployed frontend reads on-chain pause and compliance state.
              The watchtower service owns polling 0G DA and sending Farcaster
              alerts when attestations fail.
            </div>
          </div>
        </div>
      </section>
    </VelaShell>
  );
}
