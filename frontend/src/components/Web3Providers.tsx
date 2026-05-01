"use client";

import { createAppKit } from "@reown/appkit/react";
import { baseSepolia } from "@reown/appkit/networks";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";

const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ??
  process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ??
  "00000000000000000000000000000000";

const networks = [baseSepolia] as const;

const wagmiAdapter = new WagmiAdapter({
  networks,
  projectId,
  ssr: true,
  customRpcUrls: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL
    ? {
        [baseSepolia.id]: [
          {
            url: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL,
          },
        ],
      }
    : undefined,
});

createAppKit({
  adapters: [wagmiAdapter],
  networks,
  projectId,
  metadata: {
    name: "Vela",
    description: "Verifiable AI fund manager",
    url: process.env.NEXT_PUBLIC_APP_URL ?? "https://vela.vercel.app",
    icons: [],
  },
  features: {
    analytics: false,
    email: false,
    socials: false,
  },
});

export default function Web3Providers({
  children,
}: {
  children: React.ReactNode;
}) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
