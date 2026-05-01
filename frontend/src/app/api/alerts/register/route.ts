import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import fs from "fs/promises";
import path from "path";

// ─── Storage ──────────────────────────────────────────────────────────────────
// File-based fallback. Swap this section for Supabase/Postgres when ready:
//
//   import { createClient } from "@supabase/supabase-js";
//   const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
//   await supabase.from("alert_contacts").upsert({ wallet, email, farcaster }, { onConflict: "wallet" });

const DB_PATH = path.join(process.cwd(), "data", "alert-contacts.json");

type AlertContact = {
  wallet: string;
  email: string | null;
  farcaster: string | null;
  registeredAt: string;
};

async function readDB(): Promise<AlertContact[]> {
  try {
    const raw = await fs.readFile(DB_PATH, "utf-8");
    return JSON.parse(raw) as AlertContact[];
  } catch {
    return [];
  }
}

async function writeDB(contacts: AlertContact[]): Promise<void> {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(DB_PATH, JSON.stringify(contacts, null, 2), "utf-8");
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: { wallet?: string; email?: string | null; farcaster?: string | null };

  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { wallet, email, farcaster } = body;

  if (!wallet || !isAddress(wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  if (!email && !farcaster) {
    return NextResponse.json(
      { error: "Provide at least one of: email, farcaster" },
      { status: 400 },
    );
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
  }

  if (farcaster && !/^@?[\w.]+$/.test(farcaster)) {
    return NextResponse.json({ error: "Invalid Farcaster username" }, { status: 400 });
  }

  try {
    const contacts = await readDB();
    const idx = contacts.findIndex((c) => c.wallet.toLowerCase() === wallet.toLowerCase());

    const record: AlertContact = {
      wallet: wallet.toLowerCase(),
      email: email ?? null,
      farcaster: farcaster ? farcaster.replace(/^@/, "") : null,
      registeredAt: new Date().toISOString(),
    };

    if (idx >= 0) {
      contacts[idx] = record; // upsert
    } else {
      contacts.push(record);
    }

    await writeDB(contacts);

    return NextResponse.json({ ok: true, wallet: record.wallet }, { status: 200 });
  } catch (err) {
    console.error("[alerts/register]", err);
    return NextResponse.json({ error: "Storage error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!wallet || !isAddress(wallet)) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 });
  }
  const contacts = await readDB();
  const record = contacts.find((c) => c.wallet.toLowerCase() === wallet.toLowerCase());
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(record);
}