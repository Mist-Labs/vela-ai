// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

contract InitializePool is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");

        address poolManager = vm.envAddress("POOL_MANAGER_ADDRESS");
        address hook = vm.envAddress("VELA_HOOK_ADDRESS");

        address currency0 = vm.envAddress("ACTIVE_POOL_CURRENCY0");
        address currency1 = vm.envAddress("ACTIVE_POOL_CURRENCY1");

        uint24 fee = uint24(vm.envOr("ACTIVE_POOL_FEE", uint256(3000)));
        int24 tickSpacing = int24(int256(vm.envOr("ACTIVE_POOL_TICK_SPACING", uint256(60))));

        PoolKey memory poolKey = PoolKey({
            currency0: Currency.wrap(currency0),
            currency1: Currency.wrap(currency1),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(hook)
        });

        // 1:1 price
        uint160 sqrtPriceX96 = 79228162514264337593543950336;

        console2.log("Initializing Vela pool...");
        console2.log("PoolManager:", poolManager);
        console2.log("Currency0:", currency0);
        console2.log("Currency1:", currency1);
        console2.log("Hook:", hook);
        console2.log("Fee:", fee);
        console2.log("TickSpacing:", uint256(uint24(tickSpacing)));

        vm.startBroadcast(key);
        int24 tick = IPoolManager(poolManager).initialize(poolKey, sqrtPriceX96);
        vm.stopBroadcast();

        console2.log("Pool initialized at tick:");
        console2.logInt(tick);
    }
}