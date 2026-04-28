import { VelaShell } from "@/components/VelaShell";

const attestations = [
  ["#847", "0G DA", "bafy...91ac", "0x8f3a...d4c9", "Verified"],
  ["#846", "0G DA", "bafy...71bd", "0x8f3a...d4c9", "Verified"],
  ["#845", "0G DA", "bafy...53ef", "0x8f3a...d4c9", "Verified"],
  ["#844", "0G DA", "bafy...24aa", "0x8f3a...d4c9", "Verified"],
];

export default function AttestationsPage() {
  return (
    <VelaShell active="Attestations" eyebrow="0G DA RECORDS">
      <section className="hero">
        <div>
          <div className="eyebrow">Attestations</div>
          <h1>Decision provenance is signed by the enclave.</h1>
          <p className="hero-copy">
            Each agent output carries the model identity, enclave key, 0G DA
            content ID, and on-chain hash commitment required to verify the
            reasoning path.
          </p>
        </div>
        <div className="hero-stats">
          <div className="metric-row">
            <span className="metric-label">TEE</span>
            <span className="metric-value cyan">Intel TDX</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Model</span>
            <span className="metric-value">qwen3.6-plus</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Verified</span>
            <span className="metric-value green">100%</span>
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Recent Attestation Records</span>
          <span className="tb-pill pill-cyan">847 STORED</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Decision</th>
              <th>Storage</th>
              <th>CID</th>
              <th>Enclave</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {attestations.map((row) => (
              <tr key={row[0]}>
                {row.map((cell, index) => (
                  <td className={index === 4 ? "green" : ""} key={cell}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </VelaShell>
  );
}
