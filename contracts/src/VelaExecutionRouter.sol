// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

contract VelaExecutionRouter is IUnlockCallback {
    error NotOwner();
    error NotOperator();
    error NotPoolManager();
    error InvalidAmount();
    error TransferFailed();

    event OperatorUpdated(address indexed operator, bool allowed);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event SwapExecuted(
        address indexed operator,
        address indexed recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    );

    IPoolManager public immutable poolManager;

    address public owner;
    mapping(address => bool) public operators;

    struct CallbackData {
        PoolKey key;
        SwapParams params;
        address payer;
        address recipient;
        bytes hookData;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != owner && !operators[msg.sender]) revert NotOperator();
        _;
    }

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
        owner = msg.sender;

        emit OwnershipTransferred(address(0), msg.sender);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorUpdated(operator, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");

        address oldOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function swapExactInput(
        PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        address recipient,
        bytes calldata hookData
    ) external onlyOperator returns (bytes memory result) {
        if (amountIn == 0 || amountIn > uint256(type(int256).max)) {
            revert InvalidAmount();
        }

        SwapParams memory params = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: zeroForOne
                ? uint160(4295128740)
                : uint160(1461446703485210103287273052203988822378723970341)
        });

        result = poolManager.unlock(
            abi.encode(
                CallbackData({
                    key: key,
                    params: params,
                    payer: msg.sender,
                    recipient: recipient,
                    hookData: hookData
                })
            )
        );

        emit SwapExecuted(
            msg.sender,
            recipient,
            zeroForOne ? Currency.unwrap(key.currency0) : Currency.unwrap(key.currency1),
            zeroForOne ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0),
            amountIn
        );
    }

    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        CallbackData memory data = abi.decode(rawData, (CallbackData));

        BalanceDelta delta = poolManager.swap(data.key, data.params, data.hookData);

        if (delta.amount0() < 0) {
            _settle(data.key.currency0, data.payer, uint256(uint128(-delta.amount0())));
        }

        if (delta.amount1() < 0) {
            _settle(data.key.currency1, data.payer, uint256(uint128(-delta.amount1())));
        }

        if (delta.amount0() > 0) {
            poolManager.take(
                data.key.currency0,
                data.recipient,
                uint256(uint128(delta.amount0()))
            );
        }

        if (delta.amount1() > 0) {
            poolManager.take(
                data.key.currency1,
                data.recipient,
                uint256(uint128(delta.amount1()))
            );
        }

        return "";
    }

    function _settle(Currency currency, address payer, uint256 amount) internal {
        address token = Currency.unwrap(currency);

        poolManager.sync(currency);

        bool ok = IERC20(token).transferFrom(payer, address(poolManager), amount);
        if (!ok) revert TransferFailed();

        poolManager.settle();
    }
}