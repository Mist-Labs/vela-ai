import { NextRequest, NextResponse } from "next/server";

// Farcaster frame image endpoint
// Returns an SVG rendered as PNG-compatible image for frame og:image
// Spec: 1.91:1 ratio, min 1200x630

const BRAND_COLOR = "#00ff88";
const BG_COLOR = "#0a0a0a";
const SECONDARY = "#1a1a2e";
const TEXT_DIM = "#888888";

type FrameVariant = "default" | "active" | "alert" | "success" | "error";

interface FrameParams {
  variant: FrameVariant;
  title?: string;
  subtitle?: string;
  value?: string;
  label?: string;
  timestamp?: string;
}

function buildSVG({
  variant = "default",
  title,
  subtitle,
  value,
  label,
  timestamp,
}: FrameParams): string {
  const now = timestamp ?? new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  // Variant-specific config
  const variantConfig: Record<
    FrameVariant,
    { accent: string; badge: string; badgeText: string; icon: string }
  > = {
    default: {
      accent: BRAND_COLOR,
      badge: "#1a1a2e",
      badgeText: "VELA PROTOCOL",
      icon: "◈",
    },
    active: {
      accent: "#00d4ff",
      badge: "#00d4ff22",
      badgeText: "● AGENT ACTIVE",
      icon: "⟳",
    },
    alert: {
      accent: "#ff6b35",
      badge: "#ff6b3522",
      badgeText: "⚠ ALERT TRIGGERED",
      icon: "!",
    },
    success: {
      accent: BRAND_COLOR,
      badge: "#00ff8822",
      badgeText: "✓ EXECUTION COMPLETE",
      icon: "✓",
    },
    error: {
      accent: "#ff4444",
      badge: "#ff444422",
      badgeText: "✗ EXECUTION FAILED",
      icon: "✗",
    },
  };

  const cfg = variantConfig[variant];

  const displayTitle = title ?? "Vela Protocol";
  const displaySubtitle =
    subtitle ?? "AI-Powered Liquidity Protection on Base";
  const displayValue = value ?? null;
  const displayLabel = label ?? null;

  return `<svg
  width="1200"
  height="630"
  viewBox="0 0 1200 630"
  xmlns="http://www.w3.org/2000/svg"
  xmlns:xlink="http://www.w3.org/1999/xlink"
>
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${BG_COLOR};stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0d0d1a;stop-opacity:1" />
    </linearGradient>
    <linearGradient id="glow" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:${cfg.accent};stop-opacity:0.15" />
      <stop offset="50%" style="stop-color:${cfg.accent};stop-opacity:0.05" />
      <stop offset="100%" style="stop-color:${cfg.accent};stop-opacity:0" />
    </linearGradient>
    <filter id="blur">
      <feGaussianBlur stdDeviation="40" />
    </filter>
    <linearGradient id="borderGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:${cfg.accent};stop-opacity:0.8" />
      <stop offset="60%" style="stop-color:${cfg.accent};stop-opacity:0.2" />
      <stop offset="100%" style="stop-color:${cfg.accent};stop-opacity:0" />
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)" />

  <!-- Ambient glow blob -->
  <ellipse cx="200" cy="200" rx="300" ry="200" fill="${cfg.accent}" opacity="0.04" filter="url(#blur)" />
  <ellipse cx="1000" cy="450" rx="250" ry="180" fill="${cfg.accent}" opacity="0.03" filter="url(#blur)" />

  <!-- Grid lines (subtle) -->
  ${Array.from({ length: 8 }, (_, i) => {
    const y = 80 * (i + 1);
    return `<line x1="0" y1="${y}" x2="1200" y2="${y}" stroke="${cfg.accent}" stroke-width="0.3" opacity="0.08"/>`;
  }).join("\n  ")}
  ${Array.from({ length: 12 }, (_, i) => {
    const x = 100 * (i + 1);
    return `<line x1="${x}" y1="0" x2="${x}" y2="630" stroke="${cfg.accent}" stroke-width="0.3" opacity="0.06"/>`;
  }).join("\n  ")}

  <!-- Left accent bar -->
  <rect x="0" y="0" width="4" height="630" fill="url(#borderGrad)" />

  <!-- Top border -->
  <rect x="0" y="0" width="1200" height="1" fill="url(#borderGrad)" />

  <!-- Badge pill -->
  <rect x="60" y="52" width="240" height="32" rx="16" fill="${cfg.badge}" stroke="${cfg.accent}" stroke-width="1" opacity="0.9"/>
  <text x="180" y="72" font-family="'Courier New', Courier, monospace" font-size="12" font-weight="700" fill="${cfg.accent}" text-anchor="middle" letter-spacing="2">${cfg.badgeText}</text>

  <!-- Main title -->
  <text
    x="60"
    y="200"
    font-family="'Courier New', Courier, monospace"
    font-size="56"
    font-weight="700"
    fill="#ffffff"
    letter-spacing="-1"
  >${escapeXml(displayTitle)}</text>

  <!-- Subtitle -->
  <text
    x="60"
    y="260"
    font-family="'Courier New', Courier, monospace"
    font-size="24"
    fill="${TEXT_DIM}"
    letter-spacing="0"
  >${escapeXml(displaySubtitle)}</text>

  <!-- Divider -->
  <rect x="60" y="295" width="400" height="1" fill="${cfg.accent}" opacity="0.4" />

  ${
    displayValue
      ? `
  <!-- Value display -->
  <text x="60" y="370" font-family="'Courier New', Courier, monospace" font-size="16" fill="${TEXT_DIM}" letter-spacing="3">${escapeXml(displayLabel ?? "VALUE")}</text>
  <text x="60" y="430" font-family="'Courier New', Courier, monospace" font-size="64" font-weight="700" fill="${cfg.accent}" letter-spacing="-2">${escapeXml(displayValue)}</text>
  `
      : `
  <!-- Feature pills row -->
  ${buildFeaturePills(cfg.accent)}
  `
  }

  <!-- Bottom bar -->
  <rect x="0" y="600" width="1200" height="30" fill="${SECONDARY}" opacity="0.6" />
  <text x="60" y="620" font-family="'Courier New', Courier, monospace" font-size="12" fill="${TEXT_DIM}" letter-spacing="1">VELA PROTOCOL · BASE SEPOLIA · ${escapeXml(now)}</text>
  <text x="1140" y="620" font-family="'Courier New', Courier, monospace" font-size="12" fill="${cfg.accent}" text-anchor="end" letter-spacing="1">◈ VELA</text>

  <!-- Corner decoration -->
  <polyline points="1160,30 1190,30 1190,60" fill="none" stroke="${cfg.accent}" stroke-width="2" opacity="0.5"/>
  <polyline points="10,570 10,600 40,600" fill="none" stroke="${cfg.accent}" stroke-width="2" opacity="0.3"/>
</svg>`;
}

function buildFeaturePills(accent: string): string {
  const pills = [
    { icon: "◈", text: "0G STORAGE VERIFIED" },
    { icon: "⚡", text: "UNISWAP V4 HOOKS" },
    { icon: "🛡", text: "ERC4626 VAULT" },
    { icon: "●", text: "LIVE WATCHTOWER" },
  ];

  return pills
    .map((pill, i) => {
      const x = 60 + i * 270;
      const y = 360;
      return `
    <rect x="${x}" y="${y}" width="250" height="44" rx="8" fill="#ffffff08" stroke="${accent}" stroke-width="0.8" opacity="0.7"/>
    <text x="${x + 16}" y="${y + 27}" font-family="'Courier New', Courier, monospace" font-size="14" fill="${accent}">${pill.icon}</text>
    <text x="${x + 36}" y="${y + 27}" font-family="'Courier New', Courier, monospace" font-size="12" fill="#cccccc" letter-spacing="1">${pill.text}</text>`;
    })
    .join("\n");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const variant = (searchParams.get("variant") as FrameVariant) ?? "default";
  const title = searchParams.get("title") ?? undefined;
  const subtitle = searchParams.get("subtitle") ?? undefined;
  const value = searchParams.get("value") ?? undefined;
  const label = searchParams.get("label") ?? undefined;
  const timestamp = searchParams.get("ts") ?? undefined;

  // Validate variant
  const validVariants: FrameVariant[] = ["default", "active", "alert", "success", "error"];
  const safeVariant = validVariants.includes(variant) ? variant : "default";

  const svg = buildSVG({
    variant: safeVariant,
    title,
    subtitle,
    value,
    label,
    timestamp,
  });

  return new NextResponse(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml",
      // Farcaster crawlers cache aggressively — short TTL so alerts show fresh state
      "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
    },
  });
}