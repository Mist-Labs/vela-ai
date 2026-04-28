// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PolicyRegistry}   from "../src/PolicyRegistry.sol";
import {VelaVault}        from "../src/VelaVault.sol";
import {SettlementContract} from "../src/SettlementContract.sol";
import {SlashingModule}   from "../src/SlashingModule.sol";
import {IERC20}           from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deploys the full Vela contract suite to Base Sepolia and prints
///         all addresses for export to .env.
///
/// Usage:
///   forge script script/Deploy.s.sol \
///     --rpc-url $RPC_URL \
///     --private-key $PRIVATE_KEY \
///     --broadcast \
///     --verify \
///     --etherscan-api-key $ETHERSCAN_API_KEY \
///     -vvvv
///
/// After running, copy the printed addresses into your .env file.
/// Then deploy VelaHook separately using HookMiner.s.sol.
contract Deploy is Script {

    // ── Config ────────────────────────────────────────────────────────────────

    // Base Sepolia USDC (Circle's testnet deployment)
    address constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    // ── Run ───────────────────────────────────────────────────────────────────

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        address treasury    = vm.envOr("TREASURY_ADDRESS", deployer);
        address vaultAsset  = vm.envOr("VAULT_ASSET_ADDRESS", USDC_BASE_SEPOLIA);
        address agentAddr   = vm.envOr("AGENT_ADDRESS", deployer);
        address enclaveKey  = vm.envOr("REGISTERED_ENCLAVE_KEY", address(0));

        console2.log("=== Vela Deploy ===");
        console2.log("Deployer:     ", deployer);
        console2.log("Treasury:     ", treasury);
        console2.log("Vault asset:  ", vaultAsset);
        console2.log("Agent:        ", agentAddr);
        console2.log("Enclave key:  ", enclaveKey);
        console2.log("");

        vm.startBroadcast(deployerKey);

        // 1. PolicyRegistry
        PolicyRegistry policyRegistry = new PolicyRegistry(deployer);
        console2.log("PolicyRegistry deployed:", address(policyRegistry));

        // 2. SlashingModule
        SlashingModule slashingModule = new SlashingModule(
            address(policyRegistry),
            treasury,
            deployer
        );
        console2.log("SlashingModule deployed:", address(slashingModule));

        // 3. SettlementContract
        SettlementContract settlementContract = new SettlementContract(deployer);
        console2.log("SettlementContract deployed:", address(settlementContract));

        // 4. VelaVault (single-vault MVP)
        VelaVault velaVault = new VelaVault(
            IERC20(vaultAsset),
            agentAddr,
            address(policyRegistry),
            address(settlementContract)
        );
        console2.log("VelaVault deployed:", address(velaVault));

        // 5. Wire contracts
        policyRegistry.setContracts(address(settlementContract), address(slashingModule));
        settlementContract.setContracts(address(policyRegistry), address(velaVault));
        console2.log("Contracts wired.");

        // 6. Register enclave key (if provided)
        if (enclaveKey != address(0)) {
            settlementContract.registerEnclaveKey(enclaveKey);
            console2.log("Enclave key registered:", enclaveKey);
        } else {
            console2.log("WARNING: No enclave key provided. Register manually after DCAP verification.");
        }

        vm.stopBroadcast();

        // ── Print .env block ─────────────────────────────────────────────────
        console2.log("");
        console2.log("=== Add to .env ===");
        console2.log("POLICY_REGISTRY_ADDRESS=", address(policyRegistry));
        console2.log("VELA_VAULT_ADDRESS=", address(velaVault));
        console2.log("SETTLEMENT_CONTRACT_ADDRESS=", address(settlementContract));
        console2.log("SLASHING_MODULE_ADDRESS=", address(slashingModule));
        console2.log("");
        console2.log("VelaHook not deployed here. Run HookMiner.s.sol next.");
    }
}
