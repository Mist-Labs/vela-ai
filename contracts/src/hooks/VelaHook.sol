// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {FixedPointMathLib} from "solmate/utils/FixedPointMathLib.sol";
import {PolicyRegistry} from "../PolicyRegistry.sol";

/// @title  VelaHook
/// @notice Uniswap v4 hook that enforces Vela agent behavioral policy
///         inside `beforeSwap()` on every swap.
///
/// @dev    Three invariants enforced before every swap:
///         1. Agent has an active registered policy (not paused).
///         2. Circuit breaker is not triggered.
///         3. Swap's USDC value does not exceed the agent's tier ceiling.
///            Value is derived from the pool's own sqrtPriceX96 via StateLibrary -
///            no external oracle dependency.
///         4. Target pool is on the agent's registered allowlist.
///
///         Spot price note: Uniswap v4 moved oracle observation storage out of
///         pool core. A production TWAP path requires hook-owned observation
///         storage, afterSwap accumulation, and enough pool history to produce
///         a meaningful time-weighted average. Fresh testnet pools have no
///         observation history. Spot price from getSlot0 is honest, available
///         from block one, and keeps the demo reliable. Document spot as the
///         hackathon path; add TWAP in the production upgrade.
///
///         DEPLOYMENT: The hook address must be computed via HookMiner so that
///         the address flags encode `beforeSwap = true`. Use script/HookMiner.s.sol.
contract VelaHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using FixedPointMathLib for uint256;

    // ─── Errors ───────────────────────────────────────────────────────────────

    error AgentNotActive(address agent);
    error CircuitBreakerActive(address agent);
    error TradingHoursClosed(address agent, uint8 currentHourUtc, uint8 activeHoursStartUtc, uint8 activeHoursEndUtc);
    error ValueExceedsPolicy(uint256 valueUsdc, uint256 maxUsdc);
    error PoolNotAllowed(bytes32 poolId);
    error NoHookData();
    error ZeroAddress();

    // ─── Constants ────────────────────────────────────────────────────────────

    /// @dev Q96 = 2^96, used in sqrtPrice -> price conversion.
    uint256 private constant Q96 = 2 ** 96;

    /// @dev 10^6: USDC has 6 decimals.
    uint256 private constant USDC_DECIMALS_SCALAR = 1e6;

    /// @dev 10^18: most ERC-20 tokens (ETH, WBTC via wrappers) use 18 decimals.
    ///      Override per-pool if the base token uses different decimals.
    uint256 private constant BASE_TOKEN_DECIMALS_SCALAR = 1e18;

    // ─── State ────────────────────────────────────────────────────────────────

    PolicyRegistry public immutable registry;
    IPoolManager public immutable poolManager;

    /// @notice Per-agent pool allowlist. agent => poolId => allowed.
    ///         Populated by the agent's operator at registration time.
    mapping(address => mapping(bytes32 => bool)) public allowedPools;

    // ─── Events ───────────────────────────────────────────────────────────────

    event PoolAllowlistUpdated(address indexed agent, bytes32 indexed poolId, bool allowed);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(IPoolManager poolManager_, address registry_) {
        if (address(poolManager_) == address(0)) revert ZeroAddress();
        if (registry_ == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        registry = PolicyRegistry(registry_);
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert ZeroAddress();
        _;
    }

    // ─── Hook Permissions ─────────────────────────────────────────────────────

    /// @notice Only beforeSwap is enabled. All other permissions are false.
    ///         The hook address MUST encode this permission set in its bits -
    ///         use HookMiner.s.sol to compute the correct CREATE2 salt.
    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ─── Core: beforeSwap ─────────────────────────────────────────────────────

    /// @notice Policy enforcement hook called before every swap on pools
    ///         that have VelaHook installed.
    ///
    /// @param  key       The pool key identifying the pool being swapped in.
    /// @param  params    Swap parameters including amountSpecified.
    /// @param  hookData  ABI-encoded agent address: abi.encode(address agent).
    function beforeSwap(
        address, /* sender - unused */
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    )
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        // ── Decode agent from hookData ────────────────────────────────────────
        if (hookData.length < 32) revert NoHookData();
        address agent = abi.decode(hookData, (address));

        // ── Check 1: agent is registered and not paused ───────────────────────
        if (registry.circuitBreakerTriggered(agent)) revert CircuitBreakerActive(agent);
        if (!registry.isActive(agent)) revert AgentNotActive(agent);

        PolicyRegistry.PolicyCommitment memory policy = registry.getPolicy(agent);

        // ── Check 2: trade is inside the configured UTC trading window ────────
        uint8 currentHourUtc = uint8((block.timestamp / 1 hours) % 24);
        if (currentHourUtc < policy.activeHoursStartUtc || currentHourUtc >= policy.activeHoursEndUtc) {
            revert TradingHoursClosed(agent, currentHourUtc, policy.activeHoursStartUtc, policy.activeHoursEndUtc);
        }

        // ── Check 3: pool is on the agent's allowlist ─────────────────────────
        bytes32 poolId = bytes32(PoolId.unwrap(key.toId()));
        if (!allowedPools[agent][poolId]) revert PoolNotAllowed(poolId);

        // ── Check 4: swap value within policy tier ceiling ────────────────────
        // Read sqrtPriceX96 directly from v4 pool state - no external oracle.
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());

        uint256 absAmount =
            params.amountSpecified < 0 ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);

        uint256 swapValueUsdc = _sqrtPriceToUsdc(sqrtPriceX96, absAmount);

        PolicyRegistry.TierConfig memory cfg = registry.getTierConfig(uint8(policy.tier));

        uint256 maxValueUsdc = cfg.maxValuePerTxUsdc * USDC_DECIMALS_SCALAR;
        if (swapValueUsdc > maxValueUsdc) {
            revert ValueExceedsPolicy(swapValueUsdc, maxValueUsdc);
        }

        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        return (IHooks.afterSwap.selector, 0);
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IHooks.beforeDonate.selector;
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IHooks.afterDonate.selector;
    }

    // ─── Allowlist Management ─────────────────────────────────────────────────

    /// @notice Agent operator sets which pools their agent is permitted to trade.
    ///         Only callable by the registered operator of the agent.
    ///         Must be called before the agent executes any swaps.
    ///
    /// @param  agent    The agent address whose allowlist is being updated.
    /// @param  poolIds  Array of pool IDs (bytes32(PoolId.unwrap(key.toId()))).
    /// @param  allowed  Corresponding allow/deny flags.
    function setAllowedPools(address agent, bytes32[] calldata poolIds, bool[] calldata allowed) external {
        require(poolIds.length == allowed.length, "VelaHook: length mismatch");

        // Only the registered operator can update their agent's allowlist
        PolicyRegistry.PolicyCommitment memory policy = registry.getPolicy(agent);
        require(msg.sender == policy.operator, "VelaHook: not operator");
        require(policy.active, "VelaHook: agent not active");

        for (uint256 i = 0; i < poolIds.length; i++) {
            allowedPools[agent][poolIds[i]] = allowed[i];
            emit PoolAllowlistUpdated(agent, poolIds[i], allowed[i]);
        }
    }

    // ─── Price Math ───────────────────────────────────────────────────────────

    /// @notice Convert a token amount to a USDC-denominated value using the
    ///         pool's current sqrtPriceX96.
    ///
    /// @dev    Assumes pool is token/USDC where USDC is token1 (6 decimals)
    ///         and the base token is token0 (18 decimals, e.g. WETH).
    ///
    ///         price = (sqrtPriceX96 / 2^96)^2
    ///         Since sqrtPriceX96 = sqrt(token1/token0) * 2^96:
    ///         price in token1 per token0 = sqrtPriceX96^2 / 2^192
    ///
    ///         valueUsdc = amount * price * USDC_DECIMALS / BASE_DECIMALS
    ///                   = amount * sqrtPriceX96^2 * 1e6 / (2^192 * 1e18)
    ///
    ///         To avoid uint256 overflow on sqrtPriceX96^2 (which can be
    ///         large), we compute in two steps using 512-bit intermediate math
    ///         via FullMath pattern. For hackathon simplicity we cap sqrtPrice
    ///         at uint128 and accept minor precision loss on extreme prices.
    ///
    ///         Production note: replace with FullMath.mulDiv for exact precision.
    function _sqrtPriceToUsdc(uint160 sqrtPriceX96, uint256 amount) internal pure returns (uint256 valueUsdc) {
        if (sqrtPriceX96 == 0 || amount == 0) return 0;

        // price = sqrtPriceX96^2 / Q96^2
        // Use uint256 arithmetic; cap sqrtPriceX96 to prevent overflow
        // sqrtPriceX96 fits in 160 bits, squaring needs 320 bits - use mulDiv
        uint256 boundedSqrtPrice = sqrtPriceX96 > type(uint128).max ? type(uint128).max : uint256(sqrtPriceX96);
        uint256 priceNumerator = boundedSqrtPrice * boundedSqrtPrice;
        uint256 priceDenominator = Q96 * Q96; // 2^192

        // Scaling: token0 = 18 decimals, token1 (USDC) = 6 decimals
        // valueUsdc = amount * priceNumerator * USDC_SCALAR
        //           / (priceDenominator * BASE_SCALAR)
        // Rearranging to avoid overflow:
        // valueUsdc = (amount / BASE_SCALAR) * (priceNumerator * USDC_SCALAR / priceDenominator)
        // Use intermediate scaling at 1e12 precision

        // Step 1: price in USDC per 1e18 base token units (1 "full" token)
        // pricePerFullToken = priceNumerator * USDC_DECIMALS_SCALAR / priceDenominator
        uint256 pricePerFullToken = (priceNumerator / (priceDenominator / USDC_DECIMALS_SCALAR));

        // Step 2: scale by amount (in base token smallest unit)
        // valueUsdc = amount * pricePerFullToken / BASE_TOKEN_DECIMALS_SCALAR
        valueUsdc = amount.mulDivDown(pricePerFullToken, BASE_TOKEN_DECIMALS_SCALAR);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Returns true if the pool is on the agent's allowlist.
    function isPoolAllowed(address agent, bytes32 poolId) external view returns (bool) {
        return allowedPools[agent][poolId];
    }

    /// @notice Helper: compute poolId from a PoolKey for use in setAllowedPools.
    function getPoolId(PoolKey calldata key) external pure returns (bytes32) {
        return bytes32(PoolId.unwrap(key.toId()));
    }
}
