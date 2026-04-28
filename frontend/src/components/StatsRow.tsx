import { stats } from "@/lib/vela-data";

export function StatsRow() {
  return (
    <section className="stats-row" aria-label="Vault metrics">
      {stats.map((stat) => (
        <div className="stat-card" key={stat.label}>
          <div className="sc-label">{stat.label}</div>
          <div className={`sc-value ${stat.tone}`}>{stat.value}</div>
          <div className="sc-sub">{stat.sub}</div>
        </div>
      ))}
    </section>
  );
}
