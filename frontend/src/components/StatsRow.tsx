"use client";

import { useVelaData } from "./WalletProvider";

export function StatsRow() {
  const data = useVelaData();
  const stats = [
    {
      label: "Vault Assets",
      value: data.totalAssets ? `$${Number(data.totalAssets).toLocaleString()}` : "--",
      tone: "cyan",
      sub: "Read from ERC-4626 totalAssets",
    },
    {
      label: "Compliance Rate",
      value: data.complianceScore || "--",
      tone: "green",
      sub: "Read from PolicyRegistry",
    },
    {
      label: "Total Decisions",
      value: data.totalDecisions || "0",
      tone: "default",
      sub: "Read from VelaVault",
    },
    {
      label: "Compliant Decisions",
      value: data.compliantDecisions || "0",
      tone: "green",
      sub: "Registry accounting",
    },
    {
      label: "Circuit Breaker",
      value: data.circuitBreaker ? "ON" : data.active ? "OFF" : "--",
      tone: data.circuitBreaker ? "red" : "green",
      sub: "Live policy status",
    },
  ];

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
