"use client";

import { formatUnits, isAddress } from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSignMessage,
  useWriteContract,
} from "wagmi";
import {
  AGENT_ADDRESS,
  CHAIN_ID,
  CHAIN_NAME,
  DEPLOYMENT_CONFIGURED,
  POLICY_REGISTRY_ABI,
  POLICY_REGISTRY_ADDRESS,
  VAULT_ASSET_DECIMALS,
  VELA_VAULT_ABI,
  VELA_VAULT_ADDRESS,
} from "@/lib/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

// ─── Wallet context ───────────────────────────────────────────────────────────

type WalletContextValue = {
  account: string;
  chainId: number | null;
  connected: boolean;
  connecting: boolean;
  error: string;
  signMessage: (message: string) => Promise<string>;
  triggerCircuitBreaker: () => Promise<string>;
  resumeAgent: () => Promise<string>;
  registerPolicy: (
    policyRoot: `0x${string}`,
    policyURI: string,
    tier: number,
    activeHoursStartUtc: number,
    activeHoursEndUtc: number,
  ) => Promise<string>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

function assertReady(account: string, chainId: number) {
  if (!account) throw new Error("Connect wallet first.");
  if (chainId !== CHAIN_ID)
    throw new Error(`Switch to ${CHAIN_NAME} before signing.`);
}

function assertDeploymentConfigured() {
  if (
    !DEPLOYMENT_CONFIGURED ||
    !isAddress(POLICY_REGISTRY_ADDRESS) ||
    !isAddress(AGENT_ADDRESS)
  ) {
    throw new Error("Policy registry and agent addresses are not configured.");
  }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const { address, isConnected, isConnecting } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const [error, setError] = useState("");

  const account = address ?? "";

  const signMessage = useCallback(
    async (message: string) => {
      setError("");
      try {
        assertReady(account, chainId);
        return await signMessageAsync({ message });
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : "Message signing failed.";
        setError(messageText);
        throw new Error(messageText);
      }
    },
    [account, chainId, signMessageAsync],
  );

  const writeRegistry = useCallback(
    async (
      functionName: "triggerCircuitBreaker" | "resumeAgent",
      args: [`0x${string}`],
    ) => {
      setError("");
      try {
        assertReady(account, chainId);
        assertDeploymentConfigured();
        return await writeContractAsync({
          address: POLICY_REGISTRY_ADDRESS as `0x${string}`,
          abi: POLICY_REGISTRY_ABI,
          functionName,
          args,
          chainId: CHAIN_ID,
        });
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : "Transaction failed.";
        setError(messageText);
        throw new Error(messageText);
      }
    },
    [account, chainId, writeContractAsync],
  );

  const triggerCircuitBreaker = useCallback(async () => {
    return await writeRegistry("triggerCircuitBreaker", [
      AGENT_ADDRESS as `0x${string}`,
    ]);
  }, [writeRegistry]);

  const resumeAgent = useCallback(async () => {
    return await writeRegistry("resumeAgent", [AGENT_ADDRESS as `0x${string}`]);
  }, [writeRegistry]);

  const registerPolicy = useCallback(
    async (
      policyRoot: `0x${string}`,
      policyURI: string,
      tier: number,
      activeHoursStartUtc: number,
      activeHoursEndUtc: number,
    ) => {
      setError("");
      try {
        assertReady(account, chainId);
        assertDeploymentConfigured();
        return await writeContractAsync({
          address: POLICY_REGISTRY_ADDRESS as `0x${string}`,
          abi: POLICY_REGISTRY_ABI,
          functionName: "registerAgentWithPolicy",
          args: [
            policyRoot,
            policyURI,
            BigInt(tier),
            activeHoursStartUtc,
            activeHoursEndUtc,
          ],
          chainId: CHAIN_ID,
        });
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : "Policy registration failed.";
        setError(messageText);
        throw new Error(messageText);
      }
    },
    [account, chainId, writeContractAsync],
  );

  const value = useMemo(
    () => ({
      account,
      chainId,
      connected: isConnected,
      connecting: isConnecting,
      error,
      signMessage,
      triggerCircuitBreaker,
      resumeAgent,
      registerPolicy,
    }),
    [
      account,
      chainId,
      error,
      isConnected,
      isConnecting,
      registerPolicy,
      resumeAgent,
      signMessage,
      triggerCircuitBreaker,
    ],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context)
    throw new Error("useWallet must be used inside WalletProvider.");
  return context;
}

// ─── VelaData context ─────────────────────────────────────────────────────────

export type Decision = {
  id: number;
  explanation: string;
  evidenceCID: string;
  timestamp: string;
  status: string;
  decisionHash: string;
};

export type PoolAllocation = {
  name: string;
  allocationUsdc: string;
  percentage: string;
};

export type VelaData = {
  loading: boolean;
  error: string;
  configured: boolean;
  vaultAddress: string;
  agentAddress: string;
  policyRoot: string;
  policyURI: string;
  totalAssets: string;
  totalSupply: string;
  sharePrice: string;
  sharePriceHistory: { timestamp: number; price: number }[];
  totalDecisions: string;
  compliantDecisions: string;
  complianceScore: string;
  active: boolean;
  circuitBreaker: boolean;
  hookBlocks: number;
  autoPauses: number;
  decisions: Decision[];
  poolAllocations: PoolAllocation[];
  refresh: () => Promise<void>;
};

const VelaDataContext = createContext<VelaData | null>(null);

type PolicyCommitment = {
  owner: string;
  operator: string;
  policyRoot: `0x${string}`;
  policyURI: string;
  tier: number;
  maxValuePerTxUsdc: bigint;
  activeHoursStartUtc: number;
  activeHoursEndUtc: number;
  totalDecisions: bigint;
  compliantDecisions: bigint;
  complianceScore: bigint;
  active: boolean;
  circuitBreaker: boolean;
};

type DecisionRecord = {
  decisionHash: `0x${string}`;
  explanation: string;
  evidenceCID: string;
  timestamp: bigint;
  status: number;
  attestationHash: `0x${string}`;
};

export function VelaDataProvider({ children }: { children: React.ReactNode }) {
  const publicClient = usePublicClient();
  const [data, setData] = useState<Omit<VelaData, "refresh">>({
    loading: false,
    error: "",
    configured: DEPLOYMENT_CONFIGURED,
    vaultAddress: VELA_VAULT_ADDRESS,
    agentAddress: AGENT_ADDRESS,
    policyRoot: "",
    policyURI: "",
    totalAssets: "",
    totalSupply: "",
    sharePrice: "",
    sharePriceHistory: [],
    totalDecisions: "",
    compliantDecisions: "",
    complianceScore: "",
    active: false,
    circuitBreaker: false,
    hookBlocks: 0,
    autoPauses: 0,
    decisions: [],
    poolAllocations: [],
  });

  const refresh = useCallback(async () => {
    if (!DEPLOYMENT_CONFIGURED) {
      setData((current) => ({
        ...current,
        loading: false,
        error:
          "Set NEXT_PUBLIC_POLICY_REGISTRY_ADDRESS, NEXT_PUBLIC_VELA_VAULT_ADDRESS, and NEXT_PUBLIC_AGENT_ADDRESS for live data.",
      }));
      return;
    }
    if (
      !isAddress(POLICY_REGISTRY_ADDRESS) ||
      !isAddress(VELA_VAULT_ADDRESS) ||
      !isAddress(AGENT_ADDRESS)
    ) {
      setData((current) => ({
        ...current,
        loading: false,
        error: "One or more deployment addresses are invalid.",
      }));
      return;
    }
    if (!publicClient) {
      setData((current) => ({
        ...current,
        loading: false,
        error: "RPC client is not available.",
      }));
      return;
    }

    setData((current) => ({ ...current, loading: true, error: "" }));
    try {
      const [policy, totalAssets, totalSupply, totalDecisions, recent] =
        await Promise.all([
          publicClient.readContract({
            address: POLICY_REGISTRY_ADDRESS as `0x${string}`,
            abi: POLICY_REGISTRY_ABI,
            functionName: "getPolicy",
            args: [AGENT_ADDRESS as `0x${string}`],
          }),
          publicClient.readContract({
            address: VELA_VAULT_ADDRESS as `0x${string}`,
            abi: VELA_VAULT_ABI,
            functionName: "totalAssets",
          }),
          publicClient.readContract({
            address: VELA_VAULT_ADDRESS as `0x${string}`,
            abi: VELA_VAULT_ABI,
            functionName: "totalSupply",
          }),
          publicClient.readContract({
            address: VELA_VAULT_ADDRESS as `0x${string}`,
            abi: VELA_VAULT_ABI,
            functionName: "totalDecisions",
          }),
          publicClient.readContract({
            address: VELA_VAULT_ADDRESS as `0x${string}`,
            abi: VELA_VAULT_ABI,
            functionName: "recentDecisions",
            args: [12n],
          }),
        ]);

      const typedPolicy = policy as PolicyCommitment;
      console.log(
        "[VelaData] active:",
        typedPolicy.active,
        "cb:",
        typedPolicy.circuitBreaker,
        "raw:",
        policy,
      );
      const typedRecent = recent as unknown as DecisionRecord[];
      const typedTotalAssets = totalAssets as bigint;
      const typedTotalSupply = totalSupply as bigint;
      const typedTotalDecisions = totalDecisions as bigint;

      const decisionCount = Number(typedTotalDecisions);
      const decisions = typedRecent.map((record, index) => ({
        id: decisionCount - index - 1,
        explanation: record.explanation,
        evidenceCID: record.evidenceCID,
        timestamp: new Date(Number(record.timestamp) * 1000).toISOString(),
        status:
          Number(record.status) === 1
            ? "Attested"
            : Number(record.status) === 2
              ? "Failed"
              : "Pending",
        decisionHash: record.decisionHash,
      }));

      // Share price
      const sharePriceRaw =
        typedTotalSupply > 0n
          ? Number(formatUnits(typedTotalAssets, VAULT_ASSET_DECIMALS)) /
            Number(formatUnits(typedTotalSupply, VAULT_ASSET_DECIMALS))
          : 1;

      // Hook blocks and auto-pauses from events
      let hookBlocks = 0;
      let autoPauses = 0;
      try {
        const cbLogs = await publicClient.getLogs({
          address: POLICY_REGISTRY_ADDRESS as `0x${string}`,
          event: {
            type: "event",
            name: "CircuitBreakerTriggered",
            inputs: [{ type: "address", name: "agent", indexed: true }],
          },
          args: { agent: AGENT_ADDRESS as `0x${string}` },
          fromBlock: "earliest",
        });
        autoPauses = cbLogs.length;

        const hookBlockLogs = await publicClient.getLogs({
          address: VELA_VAULT_ADDRESS as `0x${string}`,
          event: {
            type: "event",
            name: "HookPolicyViolation",
            inputs: [
              { type: "bytes32", name: "poolId", indexed: true },
              { type: "address", name: "agent", indexed: true },
              { type: "string", name: "reason" },
            ],
          },
          fromBlock: "earliest",
        });
        hookBlocks = hookBlockLogs.length;
      } catch {
        // events may not exist on this deployment
      }

      // Pool allocations from HookSwapExecuted events
      const poolAllocations: PoolAllocation[] = [];
      try {
        const swapLogs = await publicClient.getLogs({
          address: VELA_VAULT_ADDRESS as `0x${string}`,
          event: {
            type: "event",
            name: "HookSwapExecuted",
            inputs: [
              { type: "bytes32", name: "poolId", indexed: true },
              { type: "address", name: "agent", indexed: true },
              { type: "bool", name: "zeroForOne" },
              { type: "uint256", name: "amountIn" },
              { type: "uint256", name: "amountOut" },
              { type: "address", name: "hook" },
            ],
          },
          fromBlock: "earliest",
        });

        const poolTotals: Record<string, bigint> = {};
        for (const log of swapLogs) {
          const args = log.args as Record<string, unknown>;
          const poolId = args.poolId as string;
          const amountIn = (args.amountIn as bigint) ?? 0n;
          poolTotals[poolId] = (poolTotals[poolId] ?? 0n) + amountIn;
        }
        const grandTotal = Object.values(poolTotals).reduce(
          (a, b) => a + b,
          0n,
        );
        for (const [poolId, total] of Object.entries(poolTotals)) {
          const pct =
            grandTotal > 0n ? Number((total * 10000n) / grandTotal) / 100 : 0;
          poolAllocations.push({
            name: `Pool ${poolId.slice(0, 10)}…`,
            allocationUsdc: formatUnits(total, VAULT_ASSET_DECIMALS),
            percentage: `${pct.toFixed(1)}%`,
          });
        }
      } catch {
        // leave empty
      }

      setData((prev) => ({
        loading: false,
        error: "",
        configured: true,
        vaultAddress: VELA_VAULT_ADDRESS,
        agentAddress: AGENT_ADDRESS,
        policyRoot: typedPolicy.policyRoot,
        policyURI: typedPolicy.policyURI,
        totalAssets: formatUnits(typedTotalAssets, VAULT_ASSET_DECIMALS),
        totalSupply: formatUnits(typedTotalSupply, VAULT_ASSET_DECIMALS),
        sharePrice: sharePriceRaw.toFixed(6),
        sharePriceHistory: [
          ...prev.sharePriceHistory.slice(-59),
          { timestamp: Date.now(), price: sharePriceRaw },
        ],
        totalDecisions: typedTotalDecisions.toString(),
        compliantDecisions: typedPolicy.compliantDecisions.toString(),
        complianceScore: `${Number(typedPolicy.complianceScore) / 10}%`,
        active: typedPolicy.active,
        circuitBreaker: typedPolicy.circuitBreaker,
        hookBlocks,
        autoPauses,
        decisions,
        poolAllocations,
      }));
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to load live vault data.";

      if (
        msg.includes("returned no data") ||
        msg.includes("Failed to fetch") ||
        msg.includes("HTTP request failed") ||
        msg.includes("ERR_NAME_NOT_RESOLVED") ||
        msg.includes("Connect Timeout")
      ) {
        setData((current) => ({
          ...current,
          loading: false,
          error: "",
        }));
        return;
      }

      setData((current) => ({
        ...current,
        loading: false,
        error: msg,
      }));
    }
  }, [publicClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live polling every 30s
  useEffect(() => {
    if (!DEPLOYMENT_CONFIGURED) return;
    const id = setInterval(() => {
      void refresh();
    }, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const value = useMemo(() => ({ ...data, refresh }), [data, refresh]);

  return (
    <VelaDataContext.Provider value={value}>
      {children}
    </VelaDataContext.Provider>
  );
}

export function useVelaData() {
  const context = useContext(VelaDataContext);
  if (!context)
    throw new Error("useVelaData must be used inside VelaDataProvider.");
  return context;
}
