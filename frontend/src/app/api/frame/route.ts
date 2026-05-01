import { NextRequest, NextResponse } from "next/server";
import { compilePolicy } from "../../../../../policy-engine";

const VAULT = process.env.NEXT_PUBLIC_VELA_VAULT_ADDRESS ?? "";
const REGISTRY = process.env.NEXT_PUBLIC_POLICY_REGISTRY_ADDRESS ?? "";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://vela.finance";

type Screen = "home" | "status" | "compile" | "conflicts" | "register";

function frameHtml({
  image,
  screen,
  inputPlaceholder,
  buttons,
}: {
  image: string;
  screen: Screen;
  inputPlaceholder?: string;
  buttons: { label: string; action?: string; target?: string }[];
}) {
  const buttonTags = buttons
    .map(
      (b, i) =>
        `<meta property="fc:frame:button:${i + 1}" content="${b.label}" />` +
        (b.action
          ? `<meta property="fc:frame:button:${i + 1}:action" content="${b.action}" />`
          : "") +
        (b.target
          ? `<meta property="fc:frame:button:${i + 1}:target" content="${b.target}" />`
          : ""),
    )
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <meta property="fc:frame" content="vNext" />
  <meta property="fc:frame:image" content="${image}" />
  <meta property="fc:frame:post_url" content="${APP_URL}/api/frame?screen=${screen}" />
  ${inputPlaceholder ? `<meta property="fc:frame:input:text" content="${inputPlaceholder}" />` : ""}
  ${buttonTags}
</head>
<body></body>
</html>`;
}

function imageUrl(text: string) {
  return `${APP_URL}/api/frame/image?text=${encodeURIComponent(text)}`;
}

export async function GET() {
  return new NextResponse(
    frameHtml({
      image: imageUrl("Vela · Verifiable AI Fund Manager"),
      screen: "home",
      buttons: [
        { label: "View Vault Status" },
        { label: "Create Policy" },
      ],
    }),
    { headers: { "Content-Type": "text/html" } },
  );
}

export async function POST(req: NextRequest) {
  const screen = (req.nextUrl.searchParams.get("screen") ?? "home") as Screen;

  let body: { untrustedData?: { inputText?: string } } = {};
  try {
    body = await req.json() as typeof body;
  } catch {
    // no body
  }

  const inputText = body.untrustedData?.inputText?.trim() ?? "";

  // ── Home ────────────────────────────────────────────────────────────────────
  if (screen === "home") {
    return new NextResponse(
      frameHtml({
        image: imageUrl("Vela · Verifiable AI Fund Manager"),
        screen: "home",
        buttons: [
          { label: "View Vault Status" },
          { label: "Create Policy" },
        ],
      }),
      { headers: { "Content-Type": "text/html" } },
    );
  }

  // ── Status ──────────────────────────────────────────────────────────────────
  if (screen === "status") {
    const lines = [
      "Vault Status",
      VAULT ? `Vault: ${VAULT.slice(0, 10)}...` : "Vault: not configured",
      REGISTRY ? `Registry: ${REGISTRY.slice(0, 10)}...` : "Registry: not configured",
      "Network: Base Sepolia",
    ].join("\n");

    return new NextResponse(
      frameHtml({
        image: imageUrl(lines),
        screen: "status",
        buttons: [
          { label: "Back" },
          { label: "Open App", action: "link", target: APP_URL },
        ],
      }),
      { headers: { "Content-Type": "text/html" } },
    );
  }

  // ── Compile ─────────────────────────────────────────────────────────────────
  if (screen === "compile") {
    if (!inputText) {
      return new NextResponse(
        frameHtml({
          image: imageUrl("Enter your investment intent below"),
          screen: "compile",
          inputPlaceholder: "Grow my ETH steadily, max 25% per pool...",
          buttons: [{ label: "Compile Policy" }, { label: "Back" }],
        }),
        { headers: { "Content-Type": "text/html" } },
      );
    }

    try {
      const compiled = await compilePolicy(inputText);
      const c = compiled.parsed.constraints;
      const hasConflicts = compiled.validation.conflicts.length > 0;
      const errors = compiled.validation.conflicts.filter(x => x.severity === "error");

      const summary = [
        `Risk: ${c.risk_profile}`,
        `Max pool: ${(c.max_allocation_per_pool_bps / 100).toFixed(0)}%`,
        `Stop-loss: ${(c.stop_loss_bps / 100).toFixed(0)}%`,
        `Hours: ${c.active_hours_start_utc}:00-${c.active_hours_end_utc}:00 UTC`,
        `APY: ${compiled.parsed.estimated_apy_range[0]}-${compiled.parsed.estimated_apy_range[1]}%`,
        hasConflicts ? `⚠ ${compiled.validation.conflicts.length} conflict(s) detected` : "✓ No conflicts",
      ].join("\n");

      if (errors.length > 0) {
        return new NextResponse(
          frameHtml({
            image: imageUrl(`Policy errors:\n${errors.map(e => e.message).join("\n")}`),
            screen: "compile",
            inputPlaceholder: "Revise your intent...",
            buttons: [{ label: "Try Again" }, { label: "Back" }],
          }),
          { headers: { "Content-Type": "text/html" } },
        );
      }

      // Store compiled root in URL for register step
      const nextUrl = `${APP_URL}/api/frame?screen=register&root=${encodeURIComponent(compiled.policyRoot)}&start=${c.active_hours_start_utc}&end=${c.active_hours_end_utc}`;

      return new NextResponse(
        frameHtml({
          image: imageUrl(summary),
          screen: hasConflicts ? "conflicts" : "register",
          buttons: hasConflicts
            ? [
                { label: "View Conflicts" },
                { label: "Register Anyway", action: "post", target: nextUrl },
                { label: "Back" },
              ]
            : [
                { label: "Register Policy", action: "post", target: nextUrl },
                { label: "Back" },
              ],
        }),
        { headers: { "Content-Type": "text/html" } },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Compilation failed";
      return new NextResponse(
        frameHtml({
          image: imageUrl(`Error: ${message}`),
          screen: "compile",
          inputPlaceholder: "Try a different intent...",
          buttons: [{ label: "Try Again" }, { label: "Back" }],
        }),
        { headers: { "Content-Type": "text/html" } },
      );
    }
  }

  // ── Conflicts ───────────────────────────────────────────────────────────────
  if (screen === "conflicts") {
    if (!inputText) {
      return new NextResponse(
        frameHtml({
          image: imageUrl("Re-enter your intent to view conflict details"),
          screen: "compile",
          inputPlaceholder: "Paste your intent again...",
          buttons: [{ label: "Check Conflicts" }, { label: "Back" }],
        }),
        { headers: { "Content-Type": "text/html" } },
      );
    }

    try {
      const compiled = await compilePolicy(inputText);
      const warnings = compiled.validation.conflicts.filter(x => x.severity === "warning");
      const text = warnings.length > 0
        ? `Warnings:\n${warnings.map(w => w.message).join("\n")}`
        : "No warnings found.";

      return new NextResponse(
        frameHtml({
          image: imageUrl(text),
          screen: "conflicts",
          buttons: [{ label: "Back" }, { label: "Open App", action: "link", target: APP_URL }],
        }),
        { headers: { "Content-Type": "text/html" } },
      );
    } catch {
      return new NextResponse(
        frameHtml({
          image: imageUrl("Could not re-compile policy for conflict details."),
          screen: "home",
          buttons: [{ label: "Home" }],
        }),
        { headers: { "Content-Type": "text/html" } },
      );
    }
  }

  // ── Register ────────────────────────────────────────────────────────────────
  if (screen === "register") {
    const policyRoot = req.nextUrl.searchParams.get("root") ?? "";
    const startHour = req.nextUrl.searchParams.get("start") ?? "0";
    const endHour = req.nextUrl.searchParams.get("end") ?? "24";

    if (!policyRoot || !REGISTRY) {
      return new NextResponse(
        frameHtml({
          image: imageUrl("Registry not configured. Open the app to register."),
          screen: "home",
          buttons: [
            { label: "Open App", action: "link", target: APP_URL },
            { label: "Back" },
          ],
        }),
        { headers: { "Content-Type": "text/html" } },
      );
    }

    // Build tx_data for Farcaster transaction frame
    const iface = ["function registerPolicy(bytes32,string,uint8,uint8,uint8)"];
    const txData = {
      chainId: "eip155:84532",
      method: "eth_sendTransaction",
      params: {
        abi: iface,
        to: REGISTRY,
        data: null,
        value: "0",
      },
      attribution: false,
    };

    return new NextResponse(
      frameHtml({
        image: imageUrl(`Register policy on-chain\nRoot: ${policyRoot.slice(0, 18)}...\nHours: ${startHour}:00-${endHour}:00 UTC`),
        screen: "register",
        buttons: [
          { label: "Sign & Register", action: "tx", target: `${APP_URL}/api/frame/tx?root=${encodeURIComponent(policyRoot)}&start=${startHour}&end=${endHour}` },
          { label: "Open App", action: "link", target: APP_URL },
        ],
      }),
      { headers: { "Content-Type": "text/html" } },
    );
  }

  // ── Fallback ─────────────────────────────────────────────────────────────────
  return new NextResponse(
    frameHtml({
      image: imageUrl("Vela · Verifiable AI Fund Manager"),
      screen: "home",
      buttons: [{ label: "View Vault Status" }, { label: "Create Policy" }],
    }),
    { headers: { "Content-Type": "text/html" } },
  );
}