"use client";

import { keccak256, toUtf8Bytes } from "ethers";
import { useMemo, useState } from "react";
import ConflictAlert from "./ConflictAlert";
import { useVelaData, useWallet } from "./WalletProvider";

export default function IntentInput() {
  const wallet = useWallet();
  const data = useVelaData();
  const [intent, setIntent] = useState(
    "Grow my ETH steadily. Never put more than 25% in one pool. Stop if I lose more than 15%. Do not trade between midnight and 6am.",
  );
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const policyRoot = useMemo(() => keccak256(toUtf8Bytes(intent.trim())), [intent]);
  const parsedPolicy = useMemo(() => {
    const allocation = intent.match(/(\d{1,3})\s*%\s*(?:in|per|\/)?\s*(?:one\s+)?pool/i)?.[1];
    const stopLoss = intent.match(/(?:lose|loss|drawdown|stop-loss)[^\d]*(\d{1,3})\s*%/i)?.[1];
    const restrictedNight = /midnight|6\s*am|06:00/i.test(intent);
    return {
      allocation: allocation ? `${allocation}%` : "Owner-defined",
      stopLoss: stopLoss ? `${stopLoss}% drawdown` : "Owner-defined",
      hours: restrictedNight ? "06:00 - 00:00 UTC" : "00:00 - 24:00 UTC",
      startHour: restrictedNight ? 6 : 0,
      endHour: restrictedNight ? 24 : 24,
    };
  }, [intent]);

  async function deployPolicy() {
    setStatus("");
    setPending(true);
    try {
      if (!intent.trim()) {
        throw new Error("Policy intent cannot be empty.");
      }
      const txHash = await wallet.registerPolicy(
        policyRoot,
        intent.trim(),
        1,
        parsedPolicy.startHour,
        parsedPolicy.endHour,
      );
      await data.refresh();
      setStatus(`Policy registered on-chain: ${txHash}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Policy registration failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="form-panel">
      <div className="panel-head">
        <span className="panel-title">Deploy New Vault | Set Your Course</span>
        <span className="tb-pill pill-cyan">POLICY ENGINE</span>
      </div>
      <div className="form-grid">
        <div className="form-section">
          <label className="form-label" htmlFor="intent">
            Investment intent
          </label>
          <textarea
            className="textarea"
            id="intent"
            onChange={(event) => setIntent(event.target.value)}
            value={intent}
          />
          <div className="parse-output">
            <span className="cyan">-&gt;</span> Max allocation per pool:{" "}
            <strong>{parsedPolicy.allocation}</strong>
            <br />
            <span className="cyan">-&gt;</span> Stop-loss threshold:{" "}
            <strong>{parsedPolicy.stopLoss}</strong>
            <br />
            <span className="cyan">-&gt;</span> Active hours:{" "}
            <strong>{parsedPolicy.hours}</strong>
            <br />
            <span className="cyan">-&gt;</span> Risk profile:{" "}
            <strong>{parsedPolicy.stopLoss === "Owner-defined" ? "Owner-defined" : "Conservative"}</strong>
            <br />
            <span className="cyan">-&gt;</span> Estimated APY:{" "}
            <strong>Derived by agent after deployment</strong>
            <br />
            <span className="cyan">-&gt;</span> Policy root:{" "}
            <strong>{policyRoot}</strong>
          </div>
        </div>
        <div className="form-section">
          <ConflictAlert />
          <div className="metric-list">
            <div className="metric-row">
              <span className="metric-label">Deposit Asset</span>
              <span className="metric-value">USDC</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Vault Standard</span>
              <span className="metric-value cyan">ERC-4626</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Execution</span>
              <span className="metric-value">Uniswap v4</span>
            </div>
          </div>
          <div className="actions">
            <button
              className="primary-btn"
              disabled={!wallet.connected || pending}
              onClick={deployPolicy}
              type="button"
            >
              {pending ? "REGISTERING" : "REGISTER POLICY"}
            </button>
            <button
              className="secondary-btn"
              onClick={() => setIntent("")}
              type="button"
            >
              CLEAR
            </button>
          </div>
          {status && <p className="form-help">{status}</p>}
        </div>
      </div>
    </section>
  );
}
