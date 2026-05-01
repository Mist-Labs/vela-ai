// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {VelaHook} from "../src/hooks/VelaHook.sol";

/// @notice Mines a CREATE2 salt that produces a VelaHook address with the
///         correct Uniswap v4 hook permission flags, then deploys the hook.
contract HookMiner is Script {
    // Base Sepolia PoolManager
    address constant POOL_MANAGER_BASE_SEPOLIA =
        0x05e73354cFdD6745c338B50bcfDFA14A7E33F5c3;

    // Foundry / deterministic CREATE2 deployer used by `new Contract{salt: salt}(...)`
    address constant CREATE2_DEPLOYER =
        0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // VelaHook only uses beforeSwap
    uint160 constant REQUIRED_FLAGS = uint160(Hooks.BEFORE_SWAP_FLAG);

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address policyRegistry = vm.envAddress("POLICY_REGISTRY_ADDRESS");
        address poolManager = vm.envOr(
            "POOL_MANAGER_ADDRESS",
            POOL_MANAGER_BASE_SEPOLIA
        );

        console2.log("Mining CREATE2 salt for VelaHook...");
        console2.log("Broadcaster:", deployer);
        console2.log("CREATE2 deployer:", CREATE2_DEPLOYER);
        console2.log("Required flags:", REQUIRED_FLAGS);
        console2.log("PolicyRegistry:", policyRegistry);
        console2.log("PoolManager:", poolManager);

        // IMPORTANT:
        // Foundry deploys salted contracts through the deterministic CREATE2 deployer,
        // not directly from your EOA. So mine using CREATE2_DEPLOYER.
        (address hookAddr, bytes32 salt) = _mine(
            CREATE2_DEPLOYER,
            poolManager,
            policyRegistry,
            REQUIRED_FLAGS
        );

        console2.log("Found salt:", uint256(salt));
        console2.log("Expected hook address:", hookAddr);

        vm.startBroadcast(deployerKey);

        VelaHook hook = new VelaHook{salt: salt}(
            IPoolManager(poolManager),
            policyRegistry,
            true
        );

        vm.stopBroadcast();

        require(address(hook) == hookAddr, "HookMiner: address mismatch");

        console2.log("VelaHook deployed:", address(hook));
        console2.log("");
        console2.log("=== Add to .env ===");
        console2.log("VELA_HOOK_ADDRESS=", address(hook));
        console2.log("POOL_MANAGER_ADDRESS=", poolManager);
    }

    function _mine(
        address create2Deployer,
        address poolManager,
        address registryAddr,
        uint160 requiredFlags
    ) internal pure returns (address hookAddr, bytes32 salt) {
        bytes memory creationCode = abi.encodePacked(
            type(VelaHook).creationCode,
            abi.encode(IPoolManager(poolManager), registryAddr, true)
        );

        bytes32 initCodeHash = keccak256(creationCode);

        uint256 nonce;

        while (true) {
            salt = bytes32(nonce);
            hookAddr = _computeCreate2Address(
                create2Deployer,
                salt,
                initCodeHash
            );

            uint160 addr = uint160(hookAddr);
            uint160 allFlags = 0x3FFF;

            if ((addr & allFlags) == requiredFlags) {
                break;
            }

            unchecked {
                nonce++;
            }

            require(nonce < 1_000_000, "HookMiner: no salt found");
        }
    }

    function _computeCreate2Address(
        address deployer,
        bytes32 salt,
        bytes32 initCodeHash
    ) internal pure returns (address) {
        return
            address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(
                                bytes1(0xff),
                                deployer,
                                salt,
                                initCodeHash
                            )
                        )
                    )
                )
            );
    }
}
