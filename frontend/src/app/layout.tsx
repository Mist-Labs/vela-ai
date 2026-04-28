import type { Metadata } from "next";
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
      <body>{children}</body>
    </html>
  );
}
