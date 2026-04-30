// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {VelaVault} from "../src/VelaVault.sol";
import {VelaHook} from "../src/hooks/VelaHook.sol";

/// @notice Wires the live VelaHook execution policy for one active v4 pool.
///         Run with the agent/operator key for hook allowlist and executor setup.
///         If that key is also the vault owner, this script also sets trustedHook
///         and registers the output position token.
contract ConfigureHook is Script {
    using PoolIdLibrary for PoolKey;

    struct Config {
        address caller;
        address hookAddr;
        address vaultAddr;
        address agent;
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address positionToken;
        bool positionTokenIsCurrency0;
    }

    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        Config memory cfg = Config({
            caller: vm.addr(key),
            hookAddr: vm.envAddress("VELA_HOOK_ADDRESS"),
            vaultAddr: vm.envAddress("VELA_VAULT_ADDRESS"),
            agent: address(0),
            currency0: vm.envAddress("ACTIVE_POOL_CURRENCY0"),
            currency1: vm.envAddress("ACTIVE_POOL_CURRENCY1"),
            fee: uint24(vm.envOr("ACTIVE_POOL_FEE", uint256(3000))),
            tickSpacing: int24(int256(vm.envOr("ACTIVE_POOL_TICK_SPACING", uint256(60)))),
            positionToken: vm.envOr("POSITION_TOKEN_ADDRESS", address(0)),
            positionTokenIsCurrency0: vm.envOr("POSITION_TOKEN_IS_CURRENCY0", true)
        });
        cfg.agent = vm.envOr("AGENT_ADDRESS", cfg.caller);

        PoolKey memory poolKey = PoolKey({
            currency0: Currency.wrap(cfg.currency0),
            currency1: Currency.wrap(cfg.currency1),
            fee: cfg.fee,
            tickSpacing: cfg.tickSpacing,
            hooks: IHooks(cfg.hookAddr)
        });
        bytes32 poolId = bytes32(PoolId.unwrap(poolKey.toId()));

        bytes32[] memory pools = new bytes32[](1);
        bool[] memory allowed = new bool[](1);
        pools[0] = poolId;
        allowed[0] = true;

        VelaHook hook = VelaHook(cfg.hookAddr);
        VelaVault vault = VelaVault(cfg.vaultAddr);

        console2.log("=== Vela Hook Configure ===");
        console2.log("Caller:      ", cfg.caller);
        console2.log("Agent:       ", cfg.agent);
        console2.log("Vault:       ", cfg.vaultAddr);
        console2.log("Hook:        ", cfg.hookAddr);
        console2.log("PoolId:");
        console2.logBytes32(poolId);

        vm.startBroadcast(key);
        hook.setAllowedPools(cfg.agent, pools, allowed);
        hook.setAgentExecutor(cfg.agent, cfg.vaultAddr);

        if (cfg.caller == vault.owner()) {
            vault.setTrustedHook(cfg.hookAddr);
            if (cfg.positionToken != address(0)) {
                vault.addPosition(PoolId.wrap(poolId), cfg.positionToken, cfg.positionTokenIsCurrency0);
            }
        }
        vm.stopBroadcast();

        console2.log("Hook pool allowlist configured.");
        console2.log("Hook executor configured.");
        if (cfg.caller != vault.owner()) {
            console2.log("NOTE: caller is not vault owner; setTrustedHook/addPosition still required from owner.");
        }
        console2.log("");
        console2.log("=== Add to .env ===");
        console2.log("ACTIVE_POOL_ID=");
        console2.logBytes32(poolId);
    }
}
