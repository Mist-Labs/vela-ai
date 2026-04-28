"use client";

import { useVelaData } from "./WalletProvider";

type LiveMetricProps = {
  field:
    | "totalAssets"
    | "totalDecisions"
    | "compliantDecisions"
    | "complianceScore"
    | "policyRoot"
    | "vaultAddress"
    | "agentAddress";
  prefix?: string;
};

export default function LiveMetric({ field, prefix = "" }: LiveMetricProps) {
  const data = useVelaData();
  const value = data[field];
  return <>{value ? `${prefix}${value}` : "--"}</>;
}

export function LiveStatusText() {
  const data = useVelaData();
  if (data.circuitBreaker) return <>Circuit breaker active</>;
  if (data.active) return <>Active</>;
  if (!data.configured) return <>Deployment not configured</>;
  return <>Connect wallet to load</>;
}
