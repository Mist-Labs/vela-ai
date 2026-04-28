export const stats = [
  {
    label: "30-Day Yield",
    value: "7.3%",
    tone: "cyan",
    sub: "ERC-4626 share price",
  },
  {
    label: "Compliance Rate",
    value: "100%",
    tone: "green",
    sub: "All 847 decisions verified",
  },
  {
    label: "Max Drawdown",
    value: "4.1%",
    tone: "amber",
    sub: "Within 15% policy limit",
  },
  {
    label: "TEE Integrity",
    value: "100%",
    tone: "green",
    sub: "0G DA record verified",
  },
  {
    label: "NAV",
    value: "$48,230",
    tone: "default",
    sub: "Share price: 1.0073",
  },
];

export const decisions = [
  {
    id: "#847",
    action: "SWAP",
    reason: "Yield opportunity detected at 7.2% APY, all constraints pass",
    value: "$2,400",
    apy: "7.2%",
    status: "VERIFIED",
  },
  {
    id: "#846",
    action: "HOLD",
    reason: "Volatility spike observed; within active hours, hold position",
    value: "-",
    apy: "-",
    status: "VERIFIED",
  },
  {
    id: "#845",
    action: "SWAP",
    reason: "ETH/USDC pool rebalance, pool allowlist check passed",
    value: "$1,800",
    apy: "6.9%",
    status: "VERIFIED",
  },
  {
    id: "#844",
    action: "SWAP",
    reason: "Stable pool opportunity, drawdown 3.2% remains safe",
    value: "$3,100",
    apy: "5.4%",
    status: "VERIFIED",
  },
  {
    id: "#843",
    action: "HOLD",
    reason: "00:15 UTC is outside the policy trading window",
    value: "-",
    apy: "-",
    status: "VERIFIED",
  },
  {
    id: "#842",
    action: "SWAP",
    reason: "Pool rebalance within 25% allocation ceiling",
    value: "$950",
    apy: "7.8%",
    status: "VERIFIED",
  },
];

export const securityLayers = [
  {
    number: "01",
    name: "Execution Firewall",
    stat: "Hook: 0x3c8f...a21e",
    description:
      "Uniswap v4 Hook enforces policy inside beforeSwap on every trade. Policy violations are blocked before execution.",
  },
  {
    number: "02",
    name: "Intelligence Integrity",
    stat: "Model: qwen3.6-plus | Enclave: 0x8f3a...d4c9",
    description:
      "Every decision runs inside 0G Sealed Inference. Attestation is stored on 0G DA and committed on-chain per decision.",
  },
  {
    number: "03",
    name: "Ambient Monitoring",
    stat: "Last poll: 12s ago | Farcaster: @vela-agent",
    description:
      "Watchtower polls 0G DA every 30 seconds. Signature mismatch triggers auto-pause and owner alert immediately.",
  },
];

export const alerts = [
  {
    tone: "ok",
    title: "[Vela] Daily Summary",
    time: "2h ago",
    body: "12 decisions today. All attested. All verified. Yield: +0.3%.",
  },
  {
    tone: "warn",
    title: "[Vela] Warning",
    time: "6h ago",
    body: "Approaching daily volume cap at 82% used. Agent is deprioritising non-urgent trades.",
  },
  {
    tone: "ok",
    title: "[Vela] Daily Summary",
    time: "26h ago",
    body: "8 decisions. All attested. Yield: +0.2%. 0G records available.",
  },
];

export const policyChips = [
  "MAX 25% / POOL",
  "STOP-LOSS 15%",
  "HOURS 06:00-00:00 UTC",
  "CONSERVATIVE",
  "UNISWAP v4 STABLE",
  "4-9% EST APY",
];
