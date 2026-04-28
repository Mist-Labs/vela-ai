import Link from "next/link";

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
            <div className="vault-card-addr">0x4f2a...b3e1</div>
            <div className="vault-card-bal">$48,230.12</div>
            <div className="vault-card-sub">847 decisions | 100% verified</div>
          </div>

          <div className="cb-strip">
            <div className="cb-left">
              <span className="cb-dot" />
              VAULT ACTIVE
            </div>
            <button className="cb-toggle">PAUSE</button>
          </div>
        </aside>

        <main className="main">
          <div className="topbar">
            <div className="tb-left">
              <div className="tb-crumb">
                BASE SEPOLIA / <strong>{eyebrow ?? "BLOCK #9,482,041"}</strong>
              </div>
              <div className="tb-pill pill-green">WATCHTOWER LIVE</div>
              <div className="tb-pill pill-cyan">0G TEE | INTEL TDX</div>
              <div className="tb-pill pill-dim">UNISWAP v4 HOOK</div>
            </div>
            <button className="connect-btn">CONNECT WALLET</button>
          </div>
          <div className="content">{children}</div>
        </main>
      </div>
    </>
  );
}
