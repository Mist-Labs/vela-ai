// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {VelaExecutionRouter} from "../src/VelaExecutionRouter.sol";

contract DeployExecutionRouter is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address poolManager = vm.envAddress("POOL_MANAGER_ADDRESS");

        vm.startBroadcast(key);
        VelaExecutionRouter router = new VelaExecutionRouter(IPoolManager(poolManager));
        vm.stopBroadcast();

        console2.log("VELA_EXECUTION_ROUTER_ADDRESS=", address(router));
    }
}