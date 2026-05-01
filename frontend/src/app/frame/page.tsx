import type { Metadata } from "next";

const BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://vela-protocol.vercel.app";

interface FrameSearchParams {
  wallet?: string;
  variant?: string;
  value?: string;
  label?: string;
}

// Next.js 15: searchParams is a Promise — must be awaited
interface FramePageProps {
  searchParams: Promise<FrameSearchParams>;
}

export async function generateMetadata({
  searchParams,
}: FramePageProps): Promise<Metadata> {
  const { variant = "default", value, label, wallet } = await searchParams;

  const imageParams = new URLSearchParams({
    variant,
    ...(value && { value }),
    ...(label && { label }),
    ts: new Date().toISOString(),
  });

  const imageUrl = `${BASE_URL}/api/frame/image?${imageParams.toString()}`;
  const appUrl = wallet ? `${BASE_URL}/?wallet=${wallet}` : `${BASE_URL}/`;

  return {
    title: "Vela Protocol — AI Liquidity Protection",
    description:
      "On-chain AI agent that monitors and protects liquidity positions on Uniswap V4. Powered by 0G Storage and Base.",
    openGraph: {
      title: "Vela Protocol",
      description: "AI-Powered Liquidity Protection on Base",
      images: [{ url: imageUrl, width: 1200, height: 630 }],
    },
    other: {
      "fc:frame": "vNext",
      "fc:frame:image": imageUrl,
      "fc:frame:image:aspect_ratio": "1.91:1",
      "fc:frame:button:1": "Launch Agent Terminal",
      "fc:frame:button:1:action": "link",
      "fc:frame:button:1:target": appUrl,
      "fc:frame:button:2": "View on GitHub",
      "fc:frame:button:2:action": "link",
      "fc:frame:button:2:target": "https://github.com/your-org/vela-protocol",
    },
  };
}

export default function FramePage() {
  const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#0a0a0a",
          color: "#fff",
          fontFamily: "monospace",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 32, color: "#00ff88", marginBottom: 12 }}>
            ◈ VELA PROTOCOL
          </div>
          <div style={{ color: "#888" }}>Redirecting to agent terminal…</div>
          <meta httpEquiv="refresh" content={`0;url=${BASE}`} />
        </div>
      </body>
    </html>
  );
}