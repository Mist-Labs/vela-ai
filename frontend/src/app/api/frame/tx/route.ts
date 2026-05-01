import { NextRequest, NextResponse } from "next/server";

const REGISTRY = process.env.NEXT_PUBLIC_POLICY_REGISTRY_ADDRESS ?? "";

export async function POST(req: NextRequest) {
  const policyRoot = req.nextUrl.searchParams.get("root") ?? "";
  const startHour = Number(req.nextUrl.searchParams.get("start") ?? "0");
  const endHour = Number(req.nextUrl.searchParams.get("end") ?? "24");

  return NextResponse.json({
    chainId: "eip155:84532",
    method: "eth_sendTransaction",
    params: {
      abi: [
        {
          name: "registerPolicy",
          type: "function",
          inputs: [
            { name: "policyRoot", type: "bytes32" },
            { name: "intent", type: "string" },
            { name: "tier", type: "uint8" },
            { name: "startHour", type: "uint8" },
            { name: "endHour", type: "uint8" },
          ],
        },
      ],
      to: REGISTRY,
      data: policyRoot,
      value: "0",
      args: [policyRoot, "", 1, startHour, endHour],
    },
  });
}