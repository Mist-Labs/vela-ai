export default function ConflictAlert() {
  return (
    <div className="alert-msg warn">
      <div className="alert-head">
        <span className="alert-title">Conflict Detected</span>
        <span className="alert-time">Resolved</span>
      </div>
      <div className="alert-body">
        "Grow steadily" and a 15% stop-loss reduce exposure to higher-yield pools.
        Conservative settings remain active until the owner confirms otherwise.
      </div>
    </div>
  );
}
