// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {VelaExecutionRouter} from "../src/VelaExecutionRouter.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

contract Swap is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address user = vm.addr(key);

        address router = vm.envAddress("VELA_EXECUTION_ROUTER_ADDRESS");

        address token0 = vm.envAddress("ACTIVE_POOL_CURRENCY0");
        address token1 = vm.envAddress("ACTIVE_POOL_CURRENCY1");
        address hook = vm.envAddress("VELA_HOOK_ADDRESS");

        uint24 fee = uint24(vm.envOr("ACTIVE_POOL_FEE", uint256(3000)));
        int24 tickSpacing = int24(int256(vm.envOr("ACTIVE_POOL_TICK_SPACING", uint256(60))));

        PoolKey memory poolKey = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(hook)
        });

        uint256 amountIn = vm.envOr("SWAP_AMOUNT_IN", uint256(1 * 1e6));
        bool zeroForOne = vm.envOr("SWAP_ZERO_FOR_ONE", true);

        vm.startBroadcast(key);

        // approve router to pull tokens
        address inputToken = zeroForOne ? token0 : token1;
        IERC20(inputToken).approve(router, amountIn);

        VelaExecutionRouter(router).swapExactInput(
            poolKey,
            zeroForOne,
            amountIn,
            user,
            abi.encode(user) // agent
        );

        vm.stopBroadcast();

        console2.log("Swap executed via router");
        console2.log("Amount in:", amountIn);
    }
}