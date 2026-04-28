"use client";

import {
  BrowserProvider,
  Contract,
  Eip1193Provider,
  formatUnits,
  isAddress,
} from "ethers";
import {
  AGENT_ADDRESS,
  BASE_SEPOLIA_CHAIN_ID,
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

type EthereumWindow = Window & {
  ethereum?: Eip1193Provider & {
    on?: (event: string, listener: (...args: unknown[]) => void) => void;
    removeListener?: (
      event: string,
      listener: (...args: unknown[]) => void,
    ) => void;
  };
};

type WalletContextValue = {
  account: string;
  chainId: number | null;
  connected: boolean;
  connecting: boolean;
  error: string;
  provider: BrowserProvider | null;
  connect: () => Promise<void>;
  switchNetwork: () => Promise<void>;
  signMessage: (message: string) => Promise<string>;
  triggerCircuitBreaker: () => Promise<string>;
  resumeAgent: () => Promise<string>;
  registerPolicy: (
    policyRoot: string,
    policyURI: string,
    tier: number,
    activeHoursStartUtc: number,
    activeHoursEndUtc: number,
  ) => Promise<string>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

function getEthereum() {
  if (typeof window === "undefined") return undefined;
  return (window as EthereumWindow).ethereum;
}

function toHexChainId(chainId: number) {
  return `0x${chainId.toString(16)}`;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  const provider = useMemo(() => {
    const ethereum = getEthereum();
    return ethereum ? new BrowserProvider(ethereum) : null;
  }, [account, chainId]);

  const refresh = useCallback(async () => {
    const ethereum = getEthereum();
    if (!ethereum) return;

    const accounts = (await ethereum.request({
      method: "eth_accounts",
    })) as string[];
    const currentChain = (await ethereum.request({
      method: "eth_chainId",
    })) as string;

    setAccount(accounts[0] ?? "");
    setChainId(Number.parseInt(currentChain, 16));
  }, []);

  useEffect(() => {
    void refresh();
    const ethereum = getEthereum();
    if (!ethereum?.on) return;

    const handleAccounts = (accounts: unknown) => {
      setAccount(Array.isArray(accounts) ? String(accounts[0] ?? "") : "");
    };
    const handleChain = (nextChainId: unknown) => {
      setChainId(Number.parseInt(String(nextChainId), 16));
    };

    ethereum.on("accountsChanged", handleAccounts);
    ethereum.on("chainChanged", handleChain);

    return () => {
      ethereum.removeListener?.("accountsChanged", handleAccounts);
      ethereum.removeListener?.("chainChanged", handleChain);
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    const ethereum = getEthereum();
    if (!ethereum) {
      setError("Install a wallet with EIP-1193 support to connect.");
      return;
    }

    setConnecting(true);
    setError("");
    try {
      const accounts = (await ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      const currentChain = (await ethereum.request({
        method: "eth_chainId",
      })) as string;
      setAccount(accounts[0] ?? "");
      setChainId(Number.parseInt(currentChain, 16));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connection failed.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchNetwork = useCallback(async () => {
    const ethereum = getEthereum();
    if (!ethereum) {
      setError("Wallet provider not found.");
      return;
    }

    try {
      await ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: toHexChainId(CHAIN_ID) }],
      });
      await refresh();
    } catch (err) {
      const code = typeof err === "object" && err && "code" in err ? err.code : null;
      if (code !== 4902 || CHAIN_ID !== BASE_SEPOLIA_CHAIN_ID) {
        setError(err instanceof Error ? err.message : "Network switch failed.");
        return;
      }

      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: toHexChainId(BASE_SEPOLIA_CHAIN_ID),
            chainName: CHAIN_NAME,
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://sepolia.base.org"],
            blockExplorerUrls: ["https://sepolia.basescan.org"],
          },
        ],
      });
      await refresh();
    }
  }, [refresh]);

  const requireSigner = useCallback(async () => {
    const currentProvider = provider;
    if (!currentProvider || !account) {
      throw new Error("Connect wallet first.");
    }
    if (chainId !== CHAIN_ID) {
      throw new Error(`Switch to ${CHAIN_NAME} before signing.`);
    }
    return currentProvider.getSigner();
  }, [account, chainId, provider]);

  const signMessage = useCallback(
    async (message: string) => {
      const signer = await requireSigner();
      return signer.signMessage(message);
    },
    [requireSigner],
  );

  const registryContract = useCallback(async () => {
    if (!DEPLOYMENT_CONFIGURED || !isAddress(POLICY_REGISTRY_ADDRESS)) {
      throw new Error("Policy registry address is not configured.");
    }
    const signer = await requireSigner();
    return new Contract(POLICY_REGISTRY_ADDRESS, POLICY_REGISTRY_ABI, signer);
  }, [requireSigner]);

  const triggerCircuitBreaker = useCallback(async () => {
    if (!isAddress(AGENT_ADDRESS)) {
      throw new Error("Agent address is not configured.");
    }
    const contract = await registryContract();
    const tx = await contract.triggerCircuitBreaker(AGENT_ADDRESS);
    await tx.wait();
    return tx.hash as string;
  }, [registryContract]);

  const resumeAgent = useCallback(async () => {
    if (!isAddress(AGENT_ADDRESS)) {
      throw new Error("Agent address is not configured.");
    }
    const contract = await registryContract();
    const tx = await contract.resumeAgent(AGENT_ADDRESS);
    await tx.wait();
    return tx.hash as string;
  }, [registryContract]);

  const registerPolicy = useCallback(
    async (
      policyRoot: string,
      policyURI: string,
      tier: number,
      activeHoursStartUtc: number,
      activeHoursEndUtc: number,
    ) => {
      const contract = await registryContract();
      const tx = await contract.registerAgentWithPolicy(
        policyRoot,
        policyURI,
        tier,
        activeHoursStartUtc,
        activeHoursEndUtc,
      );
      await tx.wait();
      return tx.hash as string;
    },
    [registryContract],
  );

  const value = useMemo(
    () => ({
      account,
      chainId,
      connected: Boolean(account),
      connecting,
      error,
      provider,
      connect,
      switchNetwork,
      signMessage,
      triggerCircuitBreaker,
      resumeAgent,
      registerPolicy,
    }),
    [
      account,
      chainId,
      connect,
      connecting,
      error,
      provider,
      resumeAgent,
      registerPolicy,
      signMessage,
      switchNetwork,
      triggerCircuitBreaker,
    ],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error("useWallet must be used inside WalletProvider.");
  }
  return context;
}

export type Decision = {
  id: number;
  explanation: string;
  evidenceCID: string;
  timestamp: string;
  status: string;
  decisionHash: string;
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
  totalDecisions: string;
  compliantDecisions: string;
  complianceScore: string;
  active: boolean;
  circuitBreaker: boolean;
  decisions: Decision[];
  refresh: () => Promise<void>;
};

const VelaDataContext = createContext<VelaData | null>(null);

export function VelaDataProvider({ children }: { children: React.ReactNode }) {
  const { provider, connected } = useWallet();
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
    totalDecisions: "",
    compliantDecisions: "",
    complianceScore: "",
    active: false,
    circuitBreaker: false,
    decisions: [],
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
    if (!provider || !connected) {
      setData((current) => ({ ...current, loading: false, error: "" }));
      return;
    }
    if (!isAddress(POLICY_REGISTRY_ADDRESS) || !isAddress(VELA_VAULT_ADDRESS) || !isAddress(AGENT_ADDRESS)) {
      setData((current) => ({
        ...current,
        loading: false,
        error: "One or more deployment addresses are invalid.",
      }));
      return;
    }

    setData((current) => ({ ...current, loading: true, error: "" }));
    try {
      const registry = new Contract(
        POLICY_REGISTRY_ADDRESS,
        POLICY_REGISTRY_ABI,
        provider,
      );
      const vault = new Contract(VELA_VAULT_ADDRESS, VELA_VAULT_ABI, provider);

      const [policy, totalAssets, totalSupply, totalDecisions, recent] =
        await Promise.all([
          registry.getPolicy(AGENT_ADDRESS),
          vault.totalAssets(),
          vault.totalSupply(),
          vault.totalDecisions(),
          vault.recentDecisions(12),
        ]);

      const decisionCount = Number(totalDecisions);
      const decisions = (recent as Array<{
        decisionHash: string;
        explanation: string;
        evidenceCID: string;
        timestamp: bigint;
        status: bigint;
      }>).map((record, index) => ({
        id: decisionCount - index - 1,
        explanation: record.explanation,
        evidenceCID: record.evidenceCID,
        timestamp: new Date(Number(record.timestamp) * 1000).toISOString(),
        status: Number(record.status) === 1 ? "Attested" : "Pending",
        decisionHash: record.decisionHash,
      }));

      setData({
        loading: false,
        error: "",
        configured: true,
        vaultAddress: VELA_VAULT_ADDRESS,
        agentAddress: AGENT_ADDRESS,
        policyRoot: String(policy.policyRoot),
        policyURI: String(policy.policyURI),
        totalAssets: formatUnits(totalAssets, VAULT_ASSET_DECIMALS),
        totalSupply: formatUnits(totalSupply, VAULT_ASSET_DECIMALS),
        totalDecisions: totalDecisions.toString(),
        compliantDecisions: policy.compliantDecisions.toString(),
        complianceScore: `${Number(policy.complianceScore) / 10}%`,
        active: Boolean(policy.active),
        circuitBreaker: Boolean(policy.circuitBreaker),
        decisions,
      });
    } catch (err) {
      setData((current) => ({
        ...current,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load live vault data.",
      }));
    }
  }, [connected, provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ ...data, refresh }), [data, refresh]);

  return (
    <VelaDataContext.Provider value={value}>{children}</VelaDataContext.Provider>
  );
}

export function useVelaData() {
  const context = useContext(VelaDataContext);
  if (!context) {
    throw new Error("useVelaData must be used inside VelaDataProvider.");
  }
  return context;
}
