export default function ConflictAlert() {
  return (
    <div className="alert-msg warn">
      <div className="alert-head">
        <span className="alert-title">Compiler Check</span>
        <span className="alert-time">Local</span>
      </div>
      <div className="alert-body">
        The frontend computes the policy root locally and registers it through
        PolicyRegistry. Backend NLP enrichment can publish a policy URI without
        changing the on-chain commitment flow.
      </div>
    </div>
  );
}
