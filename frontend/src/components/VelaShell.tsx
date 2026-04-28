"use client";

import Link from "next/link";
import { CHAIN_ID, CHAIN_NAME, DEPLOYMENT_CONFIGURED } from "@/lib/contracts";
import { useState } from "react";
import { useVelaData, useWallet, VelaDataProvider } from "./WalletProvider";

const groups = [
  {
    label: "Vault",
    items: [
      { href: "/", mark: "01", label: "Dashboard" },
      { href: "/decisions", mark: "02", label: "Decisions" },
      { href: "/performance", mark: "03", label: "Performance" },
    ],
  },
  {
    label: "Security",
    items: [
      { href: "/watchtower", mark: "04", label: "Watchtower" },
      { href: "/attestations", mark: "05", label: "Attestations" },
      { href: "/policy", mark: "06", label: "Policy" },
    ],
  },
  {
    label: "Setup",
    items: [
      { href: "/create", mark: "07", label: "New Vault" },
      { href: "/delegate", mark: "08", label: "Delegate" },
    ],
  },
];

type VelaShellProps = {
  active: string;
  eyebrow?: string;
  children: React.ReactNode;
};

export function VelaShell({ active, eyebrow, children }: VelaShellProps) {
  return (
    <VelaDataProvider>
      <VelaShellInner active={active} eyebrow={eyebrow}>
        {children}
      </VelaShellInner>
    </VelaDataProvider>
  );
}

function shorten(value: string) {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "";
}

function VelaShellInner({ active, eyebrow, children }: VelaShellProps) {
  const wallet = useWallet();
  const data = useVelaData();
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState("");

  const wrongNetwork = wallet.connected && wallet.chainId !== CHAIN_ID;
  const buttonLabel = wallet.connecting
    ? "CONNECTING"
    : wallet.connected
      ? shorten(wallet.account)
      : "CONNECT WALLET";

  async function handleWalletClick() {
    if (wrongNetwork) {
      await wallet.switchNetwork();
      return;
    }
    if (!wallet.connected) {
      await wallet.connect();
    }
  }

  async function toggleCircuitBreaker() {
    setActionError("");
    setPendingAction(data.circuitBreaker ? "resume" : "pause");
    try {
      const hash = data.circuitBreaker
        ? await wallet.resumeAgent()
        : await wallet.triggerCircuitBreaker();
      await data.refresh();
      setActionError(`Transaction confirmed: ${shorten(hash)}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Transaction failed.");
    } finally {
      setPendingAction("");
    }
  }

  return (
    <>
      <div className="bg-grid" />
      <div className="bg-glow" />
      <div className="layout">
        <aside className="sidebar">
          <Link className="logo" href="/">
            <span className="logo-icon" aria-hidden="true">
              <span className="compass-ring" />
              <span className="compass-core" />
            </span>
            <span>
              <span className="logo-name">
                Ve<em>la</em>
              </span>
              <span className="logo-tagline">Set your course. Vela sails.</span>
            </span>
          </Link>

          <nav className="nav" aria-label="Primary navigation">
            {groups.map((group) => (
              <div className="nav-group" key={group.label}>
                <div className="nav-label">{group.label}</div>
                {group.items.map((item) => (
                  <Link
                    className={`nav-item ${active === item.label ? "active" : ""}`}
                    href={item.href}
                    key={item.href}
                  >
                    <span className="ni">{item.mark}</span>
                    {item.label}
                  </Link>
                ))}
              </div>
            ))}
          </nav>

          <div className="vault-card">
            <div className="vault-card-label">Active Vault</div>
            <div className="vault-card-addr">
              {data.vaultAddress ? shorten(data.vaultAddress) : "Not configured"}
            </div>
            <div className="vault-card-bal">
              {data.totalAssets ? `$${Number(data.totalAssets).toLocaleString()}` : "--"}
            </div>
            <div className="vault-card-sub">
              {data.totalDecisions || "0"} decisions | {data.complianceScore || "--"} compliance
            </div>
          </div>

          <div className="cb-strip">
            <div className="cb-left">
              <span className="cb-dot" />
              {data.circuitBreaker ? "CIRCUIT BREAKER" : data.active ? "VAULT ACTIVE" : "VAULT STATUS UNKNOWN"}
            </div>
            <button
              className="cb-toggle"
              disabled={!wallet.connected || wrongNetwork || !DEPLOYMENT_CONFIGURED || Boolean(pendingAction)}
              onClick={toggleCircuitBreaker}
              type="button"
            >
              {pendingAction ? "PENDING" : data.circuitBreaker ? "RESUME" : "PAUSE"}
            </button>
          </div>
          {(actionError || data.error || wallet.error) && (
            <div className="sidebar-status">{actionError || data.error || wallet.error}</div>
          )}
        </aside>

        <main className="main">
          <div className="topbar">
            <div className="tb-left">
              <div className="tb-crumb">
                BASE SEPOLIA / <strong>{eyebrow ?? `CHAIN ${CHAIN_ID}`}</strong>
              </div>
              <div className="tb-pill pill-green">WATCHTOWER LIVE</div>
              <div className="tb-pill pill-cyan">0G TEE | INTEL TDX</div>
              <div className="tb-pill pill-dim">UNISWAP v4 HOOK</div>
            </div>
            <button className="connect-btn" onClick={handleWalletClick} type="button">
              {wrongNetwork ? `SWITCH TO ${CHAIN_NAME.toUpperCase()}` : buttonLabel}
            </button>
          </div>
          <div className="content">{children}</div>
        </main>
      </div>
    </>
  );
}
