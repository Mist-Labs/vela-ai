import type { Metadata } from "next";
import Web3Providers from "@/components/Web3Providers";
import { WalletProvider } from "@/components/WalletProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vela | Verifiable AI Fund Manager",
  description:
    "A verifiable AI fund manager with policy-enforced Uniswap v4 execution and 0G TEE attestations.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <Web3Providers>
          <WalletProvider>{children}</WalletProvider>
        </Web3Providers>
      </body>
    </html>
  );
}
