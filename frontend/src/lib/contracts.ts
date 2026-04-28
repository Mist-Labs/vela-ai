export const BASE_SEPOLIA_CHAIN_ID = 84532;

export const CHAIN_ID = Number(
  process.env.NEXT_PUBLIC_CHAIN_ID ?? BASE_SEPOLIA_CHAIN_ID,
);

export const CHAIN_NAME =
  process.env.NEXT_PUBLIC_CHAIN_NAME ?? "Base Sepolia";

export const POLICY_REGISTRY_ADDRESS =
  process.env.NEXT_PUBLIC_POLICY_REGISTRY_ADDRESS ?? "";

export const VELA_VAULT_ADDRESS =
  process.env.NEXT_PUBLIC_VELA_VAULT_ADDRESS ?? "";

export const ATTESTATION_CONTRACT_ADDRESS =
  process.env.NEXT_PUBLIC_ATTESTATION_CONTRACT_ADDRESS ?? "";

export const AGENT_ADDRESS = process.env.NEXT_PUBLIC_AGENT_ADDRESS ?? "";

export const VAULT_ASSET_DECIMALS = Number(
  process.env.NEXT_PUBLIC_VAULT_ASSET_DECIMALS ?? 6,
);

export const DEPLOYMENT_CONFIGURED =
  Boolean(POLICY_REGISTRY_ADDRESS) &&
  Boolean(VELA_VAULT_ADDRESS) &&
  Boolean(AGENT_ADDRESS);

export const POLICY_REGISTRY_ABI = [
  "function getPolicy(address agent) view returns (tuple(address owner,address operator,bytes32 policyRoot,string policyURI,uint8 tier,uint256 maxValuePerTxUsdc,uint8 activeHoursStartUtc,uint8 activeHoursEndUtc,uint256 totalDecisions,uint256 compliantDecisions,uint256 complianceScore,bool active,bool circuitBreaker))",
  "function triggerCircuitBreaker(address agent)",
  "function resumeAgent(address agent)",
  "function registerAgentWithPolicy(bytes32 policyRoot,string policyURI,uint256 tier,uint8 activeHoursStartUtc,uint8 activeHoursEndUtc)",
];

export const VELA_VAULT_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalDecisions() view returns (uint256)",
  "function agent() view returns (address)",
  "function recentDecisions(uint256 count) view returns (tuple(bytes32 decisionHash,string explanation,string evidenceCID,uint256 timestamp,uint8 status,bytes32 attestationHash)[])",
];
