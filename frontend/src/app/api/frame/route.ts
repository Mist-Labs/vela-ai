import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    name: "Vela",
    description: "Verifiable AI fund manager status frame",
    vault: "0x4f2a...b3e1",
    compliance: "100%",
    verifiedDecisions: 847,
  });
}
