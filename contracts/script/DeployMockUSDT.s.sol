// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {MockUSDT} from "../src/MockUSDT.sol";

/// @notice Deploys MockUSDT to Sepolia and optionally seeds a vault address.
///
/// Usage:
///   forge script script/DeployMockUSDT.s.sol \
///     --rpc-url $SEPOLIA_RPC_URL \
///     --broadcast \
///     --verify \
///     --etherscan-api-key $ETHERSCAN_API_KEY \
///     -vvvv
///
/// Optional env vars:
///   SEED_ADDRESS   — address to seed with 1M mUSDT after deploy (e.g. your vault)
///   INITIAL_OWNER  — override the deployer as token owner
contract DeployMockUSDT is Script {
    // ── Sepolia chain ID guard ─────────────────────────────
    // uint256 constant SEPOLIA_CHAIN_ID = 11155111;

    function run() external {
        // // Abort on wrong network
        // require(
        //     block.chainid == SEPOLIA_CHAIN_ID,
        //     string.concat(
        //         "Wrong network: expected Sepolia (11155111), got ",
        //         vm.toString(block.chainid)
        //     )
        // );

        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer   = vm.addr(deployerPk);

        // Allow overriding the initial owner (useful if deployer != protocol multisig)
        address initialOwner = vm.envOr("INITIAL_OWNER", deployer);

        // Optional vault/seed address — gets 1M mUSDC via ownerMint
        address seedAddress = vm.envOr("SEED_ADDRESS", address(0));

        console.log("=== MockUSDT Deploy ===");
        console.log("Network   : Sepolia");
        console.log("Deployer  :", deployer);
        console.log("Owner     :", initialOwner);
        if (seedAddress != address(0)) {
            console.log("Seed addr :", seedAddress);
        }

        vm.startBroadcast(deployerPk);

        MockUSDT token = new MockUSDT(initialOwner);

        console.log("MockUSDT deployed at:", address(token));
        console.log("Name     :", token.name());
        console.log("Symbol   :", token.symbol());
        console.log("Decimals :", token.decimals());
        console.log("DailyCap :", token.DAILY_CAP());

        // ── Optional vault seed ────────────────────────────
        if (seedAddress != address(0)) {
            uint256 seedAmount = 1_000_000 * 10 ** 6; // 1M mUSDT
            token.ownerMint(seedAddress, seedAmount);
            console.log("Seeded", seedAmount, "mUSDT to", seedAddress);
        }

        vm.stopBroadcast();

        // ── Post-deploy checklist output ───────────────────
        console.log("");
        console.log("=== Next steps ===");
        console.log("1. Add to .env:");
        console.log(
            string.concat(
                "   NEXT_PUBLIC_TEST_TOKEN_ADDRESS=",
                vm.toString(address(token))
            )
        );
        console.log("2. Verify on Etherscan (if --verify flag was not set):");
        console.log(
            string.concat(
                "   forge verify-contract ",
                vm.toString(address(token)),
                " contracts/MockUSDT.sol:MockUSDT",
                " --chain sepolia",
                " --etherscan-api-key $ETHERSCAN_API_KEY",
                " --constructor-args $(cast abi-encode 'constructor(address)' ",
                vm.toString(initialOwner),
                ")"
            )
        );
        console.log("3. Fund the faucet page with SEED_ADDRESS env var on next run.");
    }
}
