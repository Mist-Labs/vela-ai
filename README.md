# ◈ Vela Protocol

> Verifiable AI fund manager — policy-enforced Uniswap v4 execution with 0G Sealed Inference (Intel TDX) and on-chain attestation.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Built at ETHGlobal Open Agents](https://img.shields.io/badge/Built%20at-ETHGlobal%20Open%20Agents-blue)](https://ethglobal.com)
[![Network: Base Sepolia](https://img.shields.io/badge/Network-Base%20Sepolia-0052FF)](https://sepolia.basescan.org)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-vela--ai--chi.vercel.app-green)](https://vela-ai-chi.vercel.app)

**Live:** [https://vela-ai-chi.vercel.app](https://vela-ai-chi.vercel.app)

---

## What is Vela?

Vela is an autonomous on-chain fund manager where every trade decision is:

- **Produced inside a 0G Sealed Inference TEE enclave** (Intel TDX) — hardware proof that a stated model processed the exact stated inputs, unmodified
- **Committed on-chain before execution** — `VelaVault.commitDecision()` writes the decision hash and 0G DA content address before any capital moves
- **Enforced at the hook layer** — `VelaHook` intercepts Uniswap v4 `beforeSwap` and blocks any swap not authorized by the registered agent
- **Monitored by an independent watchtower** — a Rust binary that continuously fetches decision blobs from 0G DA, verifies content hashes, and triggers the `PolicyRegistry` circuit breaker on any integrity failure

Users define risk tolerance in plain English. Vela compiles it into a typed constraint set, builds a Merkle tree, uploads the constraints to 0G DA, and registers the Merkle root on-chain. The agent fetches and decodes the live policy URI at runtime — every iteration is governed by the current registered policy.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          User (browser)                             │
│         Agent Terminal · Dashboard · /create (Policy Compiler)      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS
┌──────────────────────────────▼──────────────────────────────────────┐
│                    Next.js 15 Frontend (Vercel)                      │
│  /api/agent/decision   — steps 1-3: policy + market + 0G inference  │
│  /api/agent/execute    — steps 4-6: commit + hook swap              │
│  /api/policy/compile   — NLP → constraints → 0G DA upload           │
│  /api/alerts/register  — watchtower notification registration        │
│  /api/frame/*          — Farcaster frame endpoints                   │
└──────┬───────────────────────────────────────┬───────────────────────┘
       │ ethers.js (Base Sepolia RPC)           │ ethers.js (0G chain)
       │                                        │
┌──────▼──────────────┐           ┌─────────────▼─────────────────────┐
│    Base Sepolia      │           │         0G Testnet (16602)        │
│                      │           │                                   │
│  VelaVault (ERC4626) │           │  0G Compute Network               │
│  VelaHook (v4 hook)  │           │  └─ Sealed Inference (TDX/TeeML)  │
│  PolicyRegistry      │           │  0G Storage DA                    │
│  AttestationContract │           │  └─ Decision blobs, policy docs   │
└──────────────────────┘           └───────────────────────────────────┘
       │
┌──────▼──────────────┐
│  Uniswap v4          │
│  PoolManager         │
│  StateView           │
│  MockUSDC/MockUSDT   │
└──────────────────────┘
```

### Decision Loop (every 30s)

```
1. Fetch policy constraints    ← PolicyRegistry.getPolicy() + 0G DA fetchRaw(policyURI)
2. Fetch market data           ← Uniswap v4 StateView.getSlot0()
3. 0G Sealed Inference         ← qwen/qwen-2.5-7b-instruct in TeeML enclave
4. Upload decision record      ← 0G DA upload → rootHash (CID)
5. Commit on-chain             ← VelaVault.commitDecision(hash, reason, CID)
6. Execute hook swap           ← VelaVault.executeHookSwap() → VelaHook.beforeSwap()
7. Verify attestation          ← AttestationContract.verifyAndSettle() [async]
```

---

## Sponsor Track Integrations

### 0G Labs — Verifiable Finance + Privacy & Sovereign Infrastructure

Vela uses 0G across two layers:

**0G Storage DA** — every agent decision is uploaded as a structured JSON blob before the trade executes. The blob contains the TEE attestation, model inputs, policy constraints evaluated, and the signed model output. The `rootHash` from the upload is committed on-chain as `evidenceCID`. The watchtower independently fetches every CID and verifies the content hash matches the on-chain record — making evidence tampering detectable without trusting any intermediary.

**0G Compute Network (Sealed Inference)** — every trade decision is requested from a 0G Sealed Inference provider running inside an Intel TDX enclave. The response includes a TEE attestation proving the stated model processed the exact stated inputs. On-chain verification is done by `AttestationContract.verifyAndSettle()`.

**Key integration points:**
- `agent/src/zero-g.ts` — `ZeroGStorageClient`: upload, fetchRaw, verifyRecordIntegrity
- `agent/src/zero-g-compute.ts` — `ZeroGComputeClient`: TEE inference, attestation extraction
- `watchtower/src/checker.rs` — CID fetch and hash verification loop
- `frontend/src/app/api/policy/compile/route.ts` — policy blob upload on compile
- `frontend/src/app/api/agent/decision/route.ts` — live inference call per operator cycle

**0G endpoints:**
```
Compute RPC:  https://evmrpc-testnet.0g.ai  (chain 16602)
Storage RPC:  https://evmrpc-testnet.0g.ai
Indexer:      https://indexer-storage-testnet-turbo.0g.ai
```

---

### Uniswap Foundation — v4 Hook Infrastructure

Vela is built natively on Uniswap v4 and uses two primitives unavailable in v3:

**VelaHook** (`beforeSwap` / `afterSwap`) — intercepts every swap through the registered pool. On `beforeSwap`, verifies the swap was authorized by the registered agent address. Unauthorized swaps revert. On `afterSwap`, records execution result. This gives hard guarantees that only policy-governed decisions can move capital — no external contract or user can bypass the agent.

**Direct PoolManager interaction** — `VelaVault.executeHookSwap()` calls `poolManager.unlock()` directly, implementing `IUnlockCallback`. No router. The vault is the sole authorized caller, enforced by the hook.

**Key integration points:**
- `contracts/src/hooks/VelaHook.sol` — `beforeSwap` authorization gate
- `contracts/src/VelaVault.sol` — `executeHookSwap`, `unlockCallback`, ERC4626
- `frontend/src/app/api/agent/execute/route.ts` — TypeScript execution path
- `agent/src/agent.ts` — autonomous loop executing swaps on signal

**V4 contracts (Base Sepolia):**
```
PoolManager:       0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408
StateView:         0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4
PositionManager:   0x4b2b777b0F6d2A2a1E69A2df3C8cFfD2D4c39D5A
```

---

## Deployed Contracts (Base Sepolia)

| Contract | Address |
|---|---|
| `PolicyRegistry` | [`0x89623570b393a080dBcDC30454b55E1a33fD18a9`](https://sepolia.basescan.org/address/0x89623570b393a080dBcDC30454b55E1a33fD18a9) |
| `VelaVault` | [`0x45b9F15A91a1A64765a8A37910A4fbdBd48094Ad`](https://sepolia.basescan.org/address/0x45b9F15A91a1A64765a8A37910A4fbdBd48094Ad) |
| `AttestationContract` | [`0xF8CB6bcf778DcF3C699aB662Dd917eFa64daAf7B`](https://sepolia.basescan.org/address/0xF8CB6bcf778DcF3C699aB662Dd917eFa64daAf7B) |
| `VelaHook` | [`0x3f9B3b12Bc07Cc6E1e2801bE8696B154799EC080`](https://sepolia.basescan.org/address/0x3f9B3b12Bc07Cc6E1e2801bE8696B154799EC080) |
| `MockUSDC (mUSDC)` | [`0x89F4f0e13997Ca27cEB963DEE291C607e4E59923`](https://sepolia.basescan.org/address/0x89F4f0e13997Ca27cEB963DEE291C607e4E59923) |
| `MockUSDT (mUSDT)` | [`0xdD6A1d4c2659A2d8B95BEAB203aFe0b197451ba6`](https://sepolia.basescan.org/address/0xdD6A1d4c2659A2d8B95BEAB203aFe0b197451ba6) |
| `PoolManager (v4)` | [`0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408`](https://sepolia.basescan.org/address/0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408) |
| `StateView (v4)` | [`0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4`](https://sepolia.basescan.org/address/0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4) |

**Active Pool:** MockUSDC / MockUSDT · Fee 3000 · TickSpacing 60 · VelaHook attached  
**Pool ID:** `0x8e0e223de1cf52f911ad2abaa56976d7347588637e747e7b6467cc69a6915391`

**Live transactions:**
- Hook swap: [`0x202a8a05...`](https://sepolia.basescan.org/tx/0x202a8a0547497790fa391270e0f046a5553e6ba7d3ffbf325f7a6748078ff8a1)
- Decision commit: [`0x87fe4551...`](https://sepolia.basescan.org/tx/0x87fe4551fd62815038336ef324874e2dc434aeac40e214bbea7c8cb12dc0a196)

---

## Local Setup

### Prerequisites

- Node.js 22+, pnpm 10+
- Rust + Cargo (stable)
- Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)

### 1. Clone and install

```bash
git clone https://github.com/Mist-Labs/vela-ai
cd vela-ai
```

### 2. Frontend

```bash
cd frontend
cp .env.example .env.local   # fill in values — see table below
pnpm install
pnpm dev                     # http://localhost:3000
```

### 3. Contracts

```bash
cd contracts
forge install
forge build
forge test --match-path test/MockUSDC.t.sol -vv
```

### 4. Agent

```bash
cd agent
pnpm install
NODE_OPTIONS='--conditions=require' tsx --env-file=../.env src/agent.ts
# or:
pnpm dev
```

### 5. Watchtower

```bash
cd watchtower
cargo build --release
RUST_LOG=info ./target/release/watchtower
```

### 6. Policy Engine

```bash
cd policy-engine
pnpm install
pnpm build
```

### Environment Variables

Key variables for `frontend/.env.local`:

```bash
# Chain
NEXT_PUBLIC_CHAIN_ID=84532
NEXT_PUBLIC_CHAIN_NAME=Base Sepolia

# RPC
RPC_URL=https://sepolia.base.org
NEXT_PUBLIC_RPC_URL=https://sepolia.base.org

# Contracts (deployed — copy from table above)
NEXT_PUBLIC_VELA_VAULT_ADDRESS=0x45b9F15A91a1A64765a8A37910A4fbdBd48094Ad
NEXT_PUBLIC_POLICY_REGISTRY_ADDRESS=0x89623570b393a080dBcDC30454b55E1a33fD18a9
NEXT_PUBLIC_ATTESTATION_CONTRACT_ADDRESS=0xF8CB6bcf778DcF3C699aB662Dd917eFa64daAf7B
NEXT_PUBLIC_AGENT_ADDRESS=0xF23a4a721d59CA979cB354bae567A59eD7EC04c5
NEXT_PUBLIC_TEST_TOKEN_ADDRESS=0x89F4f0e13997Ca27cEB963DEE291C607e4E59923
NEXT_PUBLIC_VAULT_ASSET_DECIMALS=6

# Pool
ACTIVE_POOL_ID=0x8e0e223de1cf52f911ad2abaa56976d7347588637e747e7b6467cc69a6915391
ACTIVE_POOL_NAME=MockUSDC/MockUSDT
ACTIVE_POOL_CURRENCY0=0x89F4f0e13997Ca27cEB963DEE291C607e4E59923
ACTIVE_POOL_CURRENCY1=0xdD6A1d4c2659A2d8B95BEAB203aFe0b197451ba6
ACTIVE_POOL_FEE=3000
ACTIVE_POOL_TICK_SPACING=60
ACTIVE_POOL_ZERO_FOR_ONE=true
ACTIVE_POOL_TOKEN0_DECIMALS=6
ACTIVE_POOL_TOKEN1_DECIMALS=6
VELA_HOOK_ADDRESS=0x3f9B3b12Bc07Cc6E1e2801bE8696B154799EC080
STATE_VIEW_ADDRESS=0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4

# Agent signer (funded on Base Sepolia)
AGENT_PRIVATE_KEY=0x...

# 0G
ZERO_G_RPC_URL=https://evmrpc-testnet.0g.ai
ZERO_G_INDEXER_URL=https://indexer-storage-testnet-turbo.0g.ai
ZERO_G_COMPUTE_PROVIDER_ADDRESS=0xa48f01287233509FD694a22Bf840225062E67836
ZERO_G_COMPUTE_MODEL=qwen/qwen-2.5-7b-instruct

# NLP (policy compiler)
MOONSHOT_API_KEY=sk-...
MOONSHOT_BASE_URL=https://api.moonshot.ai/v1
KIMI_MODEL=moonshot-v1-8k

# Trade
DEMO_TRADE_VALUE_USDC=20
TRADE_SLIPPAGE_BPS=1000

# Reown / WalletConnect
NEXT_PUBLIC_REOWN_PROJECT_ID=your_project_id

# App URL (Farcaster frames)
NEXT_PUBLIC_APP_URL=https://vela-ai-chi.vercel.app

# Database (required for Prisma)
DATABASE_URL=file:./dev.db
```

---

## Demo Flow

1. **Connect wallet** — MetaMask on Base Sepolia
2. **Define policy** — Agent Terminal step 2: describe risk tolerance in plain English (e.g. "max $500 per trade, stop loss 5%, trade anytime"), Kimi compiles into typed constraints, Merkle root registered on-chain via PolicyRegistry
3. **Get test tokens** — mint 1000 mUSDC from the public faucet
4. **Deposit** — approve + deposit into VelaVault (ERC4626), receive vlSHARE tokens
5. **Agent decides** — Terminal calls `/api/agent/decision`: fetches live policy from 0G DA, reads pool state from Uniswap v4 StateView, requests decision from 0G Sealed Inference (TDX enclave), returns plain-English summary
6. **Operator confirms** — type `confirm` → `/api/agent/execute` commits decision on-chain and executes swap through VelaHook
7. **Verify on-chain** — Dashboard shows decision feed, compliance score, TEE verification status

### Tamper Demo

```bash
cd scripts
npx ts-node inject-tamper.ts
# corrupts a pending decision blob on 0G DA
# watchtower detects hash mismatch within one polling cycle → logs BLOCKED
# PolicyRegistry circuit breaker triggers → vault paused
```

---

## Known Limitations (Testnet)

- **TEE verification counter shows 0** — the testnet 0G Compute provider (`0xa48f01...`) is a centralized Aliyun/dstack node. `AttestationContract.verifyAndSettle()` requires a genuine Intel TDX attestation report. Production deployment targets a verified TDX enclave.
- **Policy URI fallback** — if `policyURI` is not a live 0G DA CID the agent falls back to safe defaults (`activeHoursStartUtc=0, activeHoursEndUtc=24`). Register a real policy via the Agent Terminal to activate full constraint decoding.
- **Low pool liquidity** — testnet MockUSDC/MockUSDT pool has ~300 USDC liquidity. Demo trade size capped at 20 USDC.
- **Network dependency** — WalletConnect RPC relay (`rpc.walletconnect.org`) is used as fallback transport. On restricted networks, MetaMask injected provider is required for reliable contract reads.
- **Policy NLP model** — uses `moonshot-v1-8k` via Moonshot AI API. Requires `MOONSHOT_API_KEY`. kimi-k2.x series not supported (thinking mode incompatible with JSON output).

---

## Project Structure

```
vela-ai/
├── frontend/           # Next.js 15 app (Vercel)
│   ├── src/app/        # pages: /, /create, /decisions, /policy, /watchtower
│   ├── src/components/ # AgentTerminal, Dashboard, WalletProvider, VelaShell
│   └── src/app/api/    # agent/decision, agent/execute, policy/compile, alerts/register
├── contracts/          # Foundry project
│   ├── src/            # VelaVault, VelaHook, PolicyRegistry, AttestationContract, MockUSDC
│   ├── test/           # Forge tests
│   └── script/         # Deploy.s.sol, AddLiquidity.s.sol
├── agent/              # TypeScript autonomous decision loop
│   └── src/            # agent.ts, zero-g.ts, zero-g-compute.ts
├── watchtower/         # Rust integrity checker
│   └── src/            # main.rs, checker.rs
├── policy-engine/      # TypeScript NLP policy compiler
│   └── src/            # nlp.ts, merkle.ts, conflict-detector.ts, types.ts
└── scripts/            # inject-tamper.ts, seed-vault.ts
```

---

## License

MIT — see [LICENSE](LICENSE)