// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

contract AddLiquidity is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address user = vm.addr(key);

        address token0 = vm.envAddress("ACTIVE_POOL_CURRENCY0");
        address token1 = vm.envAddress("ACTIVE_POOL_CURRENCY1");
        address hook = vm.envAddress("VELA_HOOK_ADDRESS");
        address positionManager = vm.envAddress("POSITION_MANAGER_ADDRESS");
        address permit2 = vm.envAddress("PERMIT2_ADDRESS");

        uint24 fee = uint24(vm.envOr("ACTIVE_POOL_FEE", uint256(3000)));
        int24 tickSpacing = int24(int256(vm.envOr("ACTIVE_POOL_TICK_SPACING", uint256(60))));

        PoolKey memory poolKey = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(hook)
        });

        uint256 amount0Max = 10_000 * 1e6;
        uint256 amount1Max = 10_000 * 1e6;

        uint128 liquidity = 10_000 * 1e6;

        int24 tickLower = -600;
        int24 tickUpper = 600;

        bytes memory actions = abi.encodePacked(
            uint8(Actions.MINT_POSITION),
            uint8(Actions.SETTLE_PAIR)
        );

        bytes[] memory params = new bytes[](2);

        params[0] = abi.encode(
            poolKey,
            tickLower,
            tickUpper,
            liquidity,
            uint128(amount0Max),
            uint128(amount1Max),
            user,
            bytes("")
        );

        params[1] = abi.encode(
            Currency.wrap(token0),
            Currency.wrap(token1)
        );

        bytes memory unlockData = abi.encode(actions, params);
        uint256 deadline = block.timestamp + 20 minutes;

        vm.startBroadcast(key);

        IERC20(token0).approve(permit2, type(uint256).max);
        IERC20(token1).approve(permit2, type(uint256).max);

        IAllowanceTransfer(permit2).approve(token0, positionManager, type(uint160).max, type(uint48).max);
        IAllowanceTransfer(permit2).approve(token1, positionManager, type(uint160).max, type(uint48).max);

        IPositionManager(positionManager).modifyLiquidities(unlockData, deadline);

        vm.stopBroadcast();

        console2.log("Liquidity added.");
    }
}