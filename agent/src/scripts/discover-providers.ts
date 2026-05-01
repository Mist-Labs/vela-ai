import { ethers } from "ethers";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";

async function main() {
  const privateKey = process.env.ZERO_G_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("ZERO_G_PRIVATE_KEY not set");
  }

  const provider = new ethers.JsonRpcProvider("https://evmrpc-testnet.0g.ai");
  const wallet = new ethers.Wallet(privateKey, provider) as any;
  const broker = await createZGComputeNetworkBroker(wallet);

  console.log("Listing available services...\n");
  const services = await broker.inference.listService();

  if (!services || services.length === 0) {
    console.log("No services found.");
    return;
  }

  for (const s of services) {
    console.log(`Provider:     ${s.provider}`);
    console.log(`Model:        ${s.model}`);
    console.log(`Verifiability:${s.verifiability}`);
    console.log(`URL:          ${s.url}`);
    console.log("---");
  }

  const target = services.find(
    (s: any) =>
      s.model?.toLowerCase().includes("qwen3.6") &&
      s.verifiability === "TeeML"
  );

  if (!target) {
    console.log("\nNo qwen3.6-plus TeeML provider found.");
    console.log("Available models:");
    services.forEach((s: any) => console.log(`  ${s.model} [${s.verifiability}] — ${s.provider}`));
    return;
  }

  console.log(`\nFound target provider:`);
  console.log(`  Provider: ${target.provider}`);
  console.log(`  Model:    ${target.model}`);
  console.log(`  URL:      ${target.url}`);
  console.log(`  TEE:      ${target.verifiability}`);

  try {
    const { endpoint, model } = await broker.inference.getServiceMetadata(target.provider);
    console.log(`\nService metadata:`);
    console.log(`  Endpoint: ${endpoint}`);
    console.log(`  Model:    ${model}`);
  } catch (err) {
    console.warn(`  getServiceMetadata failed: ${err}`);
  }

  console.log(`\n--- Add to .env ---`);
  console.log(`ZERO_G_COMPUTE_PROVIDER_ADDRESS=${target.provider}`);
  console.log(`\n--- Get enclave signing key ---`);
  console.log(`Run: curl ${target.url}/attestation/report`);
  console.log(`Then set: REGISTERED_ENCLAVE_KEY=<signing_address from response>`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});