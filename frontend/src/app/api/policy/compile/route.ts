import { NextRequest, NextResponse } from "next/server";
import { compilePolicy } from "../../../../../../policy-engine";

export async function POST(req: NextRequest) {
  try {
    const { intent } = await req.json() as { intent?: string };
    if (!intent?.trim()) {
      return NextResponse.json({ error: "Intent is empty" }, { status: 400 });
    }
    const compiled = await compilePolicy(intent.trim());
    return NextResponse.json(compiled);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Policy compilation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}