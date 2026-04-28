// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {VelaHook} from "../src/hooks/VelaHook.sol";

/// @notice Mines a CREATE2 salt that produces a VelaHook address with the
///         correct Hooks permission flags bits, then deploys the hook.
///
/// Uniswap v4 encodes hook permissions in the address bits. VelaHook only
/// uses beforeSwap, so bit 7 of address byte 19 (rightmost byte) must be 1
/// and all other permission bits must be 0.
///
/// The required flags bitmask: Hooks.BEFORE_SWAP_FLAG = 0x0080
///
/// Usage:
///   forge script script/HookMiner.s.sol \
///     --rpc-url $RPC_URL \
///     --private-key $PRIVATE_KEY \
///     --broadcast \
///     -vvvv
///
/// After running, add to .env:
///   VELA_HOOK_ADDRESS=<printed address>
contract HookMiner is Script {
    // Base Sepolia PoolManager (Uniswap v4 deployment)
    address constant POOL_MANAGER = 0x05e73354cFdD6745c338B50bcfDFA14A7E33F5c3;

    // Required hook flags for VelaHook: only beforeSwap = true
    uint160 constant REQUIRED_FLAGS = uint160(Hooks.BEFORE_SWAP_FLAG);

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address policyRegistry = vm.envAddress("POLICY_REGISTRY_ADDRESS");

        console2.log("Mining CREATE2 salt for VelaHook...");
        console2.log("Required flags:", REQUIRED_FLAGS);
        console2.log("PolicyRegistry:", policyRegistry);

        // Mine salt
        (address hookAddr, bytes32 salt) = _mine(deployer, policyRegistry, REQUIRED_FLAGS);

        console2.log("Found salt:", uint256(salt));
        console2.log("Hook address:", hookAddr);

        // Deploy
        vm.startBroadcast(deployerKey);
        VelaHook hook = new VelaHook{salt: salt}(IPoolManager(POOL_MANAGER), policyRegistry);
        vm.stopBroadcast();

        require(address(hook) == hookAddr, "HookMiner: address mismatch");
        console2.log("VelaHook deployed:", address(hook));
        console2.log("");
        console2.log("=== Add to .env ===");
        console2.log("VELA_HOOK_ADDRESS=", address(hook));
        console2.log("POOL_MANAGER_ADDRESS=", POOL_MANAGER);
    }

    /// @dev Iterates salts until the resulting CREATE2 address has the
    ///      required Hooks permission bits set. Off-chain computation only.
    function _mine(address deployer, address registryAddr, uint160 requiredFlags)
        internal
        pure
        returns (address hookAddr, bytes32 salt)
    {
        bytes memory creationCode =
            abi.encodePacked(type(VelaHook).creationCode, abi.encode(POOL_MANAGER, registryAddr));
        bytes32 initCodeHash = keccak256(creationCode);

        uint256 nonce;
        while (true) {
            salt = bytes32(nonce);
            hookAddr = _computeCreate2Address(deployer, salt, initCodeHash);

            // Check that required bits are set and no unexpected bits are set
            uint160 addr = uint160(hookAddr);
            uint160 allFlags = 0x3FFF; // all 14 permission bits in v4
            if ((addr & allFlags) == requiredFlags) {
                break;
            }
            unchecked {
                nonce++;
            }

            // Safety: max 1M iterations
            require(nonce < 1_000_000, "HookMiner: no salt found");
        }
    }

    function _computeCreate2Address(address deployer, bytes32 salt, bytes32 initCodeHash)
        internal
        pure
        returns (address)
    {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
