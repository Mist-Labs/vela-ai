import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    name: "Vela",
    description: "Verifiable AI fund manager status frame",
    vault: process.env.NEXT_PUBLIC_VELA_VAULT_ADDRESS ?? null,
    policyRegistry: process.env.NEXT_PUBLIC_POLICY_REGISTRY_ADDRESS ?? null,
    agent: process.env.NEXT_PUBLIC_AGENT_ADDRESS ?? null,
  });
}
