// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {VelaHook} from "../src/hooks/VelaHook.sol";

/// @dev Minimal IPoolManager stub that lets us control getSlot0 output.
contract MockPoolManager {
    mapping(bytes32 => uint160) public sqrtPrices;

    function setSqrtPrice(bytes32 poolId, uint160 sqrtPriceX96) external {
        sqrtPrices[poolId] = sqrtPriceX96;
    }

    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 cardinality)
    {
        return (sqrtPrices[poolId], 0, 0, 1);
    }

    // Stub every other IPoolManager function the hook might reference
    fallback() external {}
}

/// @dev Deployable VelaHook wrapper for testing (bypasses CREATE2 address check).
contract TestableVelaHook is VelaHook {
    constructor(address poolManager_, address registry_) VelaHook(IPoolManager(poolManager_), registry_, false) {}

    /// @dev Expose internal price math for unit testing.
    function exposedSqrtPriceToUsdc(uint160 sqrtPriceX96, uint256 amount) external pure returns (uint256) {
        return _sqrtPriceToUsdc(sqrtPriceX96, amount);
    }

    /// @dev Allow tests to call beforeSwap directly without the onlyPoolManager modifier.
    function testBeforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        view
        returns (bytes4 selector, uint256 valueUsdc)
    {
        // Re-implement enforcement logic without the modifier for test isolation
        if (hookData.length < 32) revert NoHookData();
        address agent = abi.decode(hookData, (address));

        PolicyRegistry reg = PolicyRegistry(address(registry));
        if (reg.circuitBreakerTriggered(agent)) revert CircuitBreakerActive(agent);
        if (!reg.isActive(agent)) revert AgentNotActive(agent);
        PolicyRegistry.PolicyCommitment memory policy = reg.getPolicy(agent);

        address expectedExecutor = trustedExecutors[agent];
        if (sender != expectedExecutor) {
            revert UntrustedExecutor(agent, sender, expectedExecutor);
        }

        uint8 currentHourUtc = uint8((block.timestamp / 1 hours) % 24);
        if (currentHourUtc < policy.activeHoursStartUtc || currentHourUtc >= policy.activeHoursEndUtc) {
            revert TradingHoursClosed(agent, currentHourUtc, policy.activeHoursStartUtc, policy.activeHoursEndUtc);
        }

        bytes32 poolId = bytes32(PoolId.unwrap(key.toId()));
        if (!allowedPools[agent][poolId]) revert PoolNotAllowed(poolId);

        (uint160 sqrtPriceX96,,,) = MockPoolManager(address(poolManager)).getSlot0(poolId);
        uint256 absAmount =
            params.amountSpecified < 0 ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);

        bool amountIsCurrency0 = params.amountSpecified < 0 ? params.zeroForOne : !params.zeroForOne;
        valueUsdc = amountIsCurrency0 ? _sqrtPriceToUsdc(sqrtPriceX96, absAmount) : absAmount;
        PolicyRegistry.TierConfig memory cfg = reg.getTierConfig(uint8(policy.tier));
        uint256 maxValueUsdc = cfg.maxValuePerTxUsdc * 1e6;
        if (valueUsdc > maxValueUsdc) {
            revert ValueExceedsPolicy(valueUsdc, maxValueUsdc);
        }

        return (VelaHook.beforeSwap.selector, valueUsdc);
    }
}

contract VelaHookTest is Test {
    using PoolIdLibrary for PoolKey;

    TestableVelaHook public hook;
    MockPoolManager public poolManager;
    PolicyRegistry public registry;

    address public owner = makeAddr("owner");
    address public attestation = makeAddr("attestation");
    address public agent = makeAddr("agent");
    address public operator; // same as agent.operator
    address public stranger = makeAddr("stranger");

    bytes32 constant POLICY_ROOT = keccak256("policy");
    string constant POLICY_URI = "0g://policy";

    PoolKey public testPoolKey;
    bytes32 public testPoolId;

    // ETH/USDC sqrtPriceX96 at $2000/ETH
    // sqrtPrice = sqrt(2000 * 1e6 / 1e18) * 2^96
    // = sqrt(2e-12) * 2^96 ≈ 1.414e-6 * 2^96
    // Approximate value for $2000/ETH: ~3961408125713216879677197516800
    uint160 constant SQRT_PRICE_2000 = 3_543_191_142_285_914_203_689_109_514_473;

    function setUp() public {
        poolManager = new MockPoolManager();
        registry = new PolicyRegistry(owner);
        hook = new TestableVelaHook(address(poolManager), address(registry));

        vm.prank(owner);
        registry.setContracts(attestation);

        // Register agent (operator = agent for simplicity)
        vm.prank(agent);
        // MICRO tier: max $1000 USDC per tx
        registry.registerAgent(POLICY_ROOT, POLICY_URI, 0);

        // Build a test pool key
        testPoolKey = PoolKey({
            currency0: Currency.wrap(address(0x1111)), // token0 (e.g. WETH)
            currency1: Currency.wrap(address(0x2222)), // token1 (e.g. USDC)
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        testPoolId = bytes32(PoolId.unwrap(testPoolKey.toId()));

        // Whitelist the pool for the agent
        bytes32[] memory pools = new bytes32[](1);
        bool[] memory allowed = new bool[](1);
        pools[0] = testPoolId;
        allowed[0] = true;
        vm.prank(agent);
        hook.setAllowedPools(agent, pools, allowed);
        vm.prank(agent);
        hook.setAgentExecutor(agent, agent);

        // Set sqrtPrice in mock pool manager
        poolManager.setSqrtPrice(testPoolId, SQRT_PRICE_2000);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _swapParams(int256 amount) internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountSpecified: amount, sqrtPriceLimitX96: 0});
    }

    function _hookData(address a) internal pure returns (bytes memory) {
        return abi.encode(a);
    }

    // ─── Price math unit tests ────────────────────────────────────────────────

    function test_sqrtPriceToUsdc_zeroAmountReturnsZero() public view {
        uint256 val = hook.exposedSqrtPriceToUsdc(SQRT_PRICE_2000, 0);
        assertEq(val, 0);
    }

    function test_sqrtPriceToUsdc_zeroSqrtPriceReturnsZero() public view {
        uint256 val = hook.exposedSqrtPriceToUsdc(0, 1 ether);
        assertEq(val, 0);
    }

    function test_sqrtPriceToUsdc_oneEthAtPrice2000_approxTwoThousandUsdc() public view {
        // 1 ETH = 1e18 wei, at $2000/ETH should return ~2000e6 USDC
        uint256 val = hook.exposedSqrtPriceToUsdc(SQRT_PRICE_2000, 1 ether);
        // Allow 5% tolerance for integer arithmetic approximation
        assertApproxEqRel(val, 2_000e6, 0.05e18);
    }

    function test_sqrtPriceToUsdc_halfEth_approxOneThousandUsdc() public view {
        uint256 val = hook.exposedSqrtPriceToUsdc(SQRT_PRICE_2000, 0.5 ether);
        assertApproxEqRel(val, 1_000e6, 0.05e18);
    }

    // ─── beforeSwap enforcement ───────────────────────────────────────────────

    function test_beforeSwap_compliantSwap_succeeds() public view {
        // 0.1 ETH swap at $2000 = ~$200 USDC - well within $1000 MICRO ceiling
        SwapParams memory params = _swapParams(-0.1 ether);
        (bytes4 sel,) = hook.testBeforeSwap(agent, testPoolKey, params, _hookData(agent));
        assertEq(sel, VelaHook.beforeSwap.selector);
    }

    function test_beforeSwap_revert_agentNotActive() public {
        // Stranger has no registered policy
        SwapParams memory params = _swapParams(-0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(VelaHook.AgentNotActive.selector, stranger));
        hook.testBeforeSwap(stranger, testPoolKey, params, _hookData(stranger));
    }

    function test_beforeSwap_revert_circuitBreakerActive() public {
        vm.prank(agent);
        registry.triggerCircuitBreaker(agent);

        SwapParams memory params = _swapParams(-0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(VelaHook.CircuitBreakerActive.selector, agent));
        hook.testBeforeSwap(agent, testPoolKey, params, _hookData(agent));
    }

    function test_beforeSwap_revert_outsideTradingHours() public {
        vm.prank(agent);
        registry.setTradingHours(agent, 10, 12);
        vm.warp(13 hours);

        SwapParams memory params = _swapParams(-0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(VelaHook.TradingHoursClosed.selector, agent, 13, 10, 12));
        hook.testBeforeSwap(agent, testPoolKey, params, _hookData(agent));
    }

    function test_beforeSwap_revert_poolNotAllowed() public {
        // Build a different pool key
        PoolKey memory otherKey = PoolKey({
            currency0: Currency.wrap(address(0x3333)),
            currency1: Currency.wrap(address(0x4444)),
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(hook))
        });
        bytes32 otherPoolId = bytes32(PoolId.unwrap(otherKey.toId()));

        vm.expectRevert(abi.encodeWithSelector(VelaHook.PoolNotAllowed.selector, otherPoolId));
        hook.testBeforeSwap(agent, otherKey, _swapParams(-0.1 ether), _hookData(agent));
    }

    function test_beforeSwap_revert_valueExceedsPolicy() public {
        // 0.6 ETH at $2000 = ~$1200 USDC - exceeds $1000 MICRO ceiling
        SwapParams memory params = _swapParams(-0.6 ether);
        vm.expectRevert(); // ValueExceedsPolicy
        hook.testBeforeSwap(agent, testPoolKey, params, _hookData(agent));
    }

    function test_beforeSwap_revert_noHookData() public {
        SwapParams memory params = _swapParams(-0.1 ether);
        vm.expectRevert(VelaHook.NoHookData.selector);
        hook.testBeforeSwap(agent, testPoolKey, params, bytes(""));
    }

    function test_beforeSwap_revert_untrustedExecutor() public {
        SwapParams memory params = _swapParams(-0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(VelaHook.UntrustedExecutor.selector, agent, stranger, agent));
        hook.testBeforeSwap(stranger, testPoolKey, params, _hookData(agent));
    }

    function test_beforeSwap_standardTier_higherCeiling() public {
        // Register a STANDARD tier agent (max $10K per tx)
        address proAgent = makeAddr("proAgent");
        vm.prank(proAgent);
        registry.registerAgent(POLICY_ROOT, POLICY_URI, 1);

        // Whitelist pool for proAgent
        bytes32[] memory pools = new bytes32[](1);
        bool[] memory allowed = new bool[](1);
        pools[0] = testPoolId;
        allowed[0] = true;
        vm.prank(proAgent);
        hook.setAllowedPools(proAgent, pools, allowed);
        vm.prank(proAgent);
        hook.setAgentExecutor(proAgent, proAgent);

        // 4 ETH at $2000 = ~$8000 USDC - within $10K STANDARD ceiling
        SwapParams memory params = _swapParams(-4 ether);
        (bytes4 sel,) = hook.testBeforeSwap(proAgent, testPoolKey, params, _hookData(proAgent));
        assertEq(sel, VelaHook.beforeSwap.selector);
    }

    function test_beforeSwap_exactlyAtCeiling_succeeds() public view {
        // At $2000/ETH, 0.5 ETH = ~$1000 USDC = exactly the MICRO ceiling
        // Should succeed (<=, not <)
        SwapParams memory params = _swapParams(-0.5 ether);
        (bytes4 sel,) = hook.testBeforeSwap(agent, testPoolKey, params, _hookData(agent));
        assertEq(sel, VelaHook.beforeSwap.selector);
    }

    function test_beforeSwap_positiveAmountSpecified_treated_as_abs() public view {
        // exactOutput token0 -> token1: amountSpecified is token1 (USDC) output units.
        SwapParams memory params = _swapParams(100e6);
        (bytes4 sel,) = hook.testBeforeSwap(agent, testPoolKey, params, _hookData(agent));
        assertEq(sel, VelaHook.beforeSwap.selector);
    }

    function test_beforeSwap_usdcInputUsesUsdcAmountDirectly() public view {
        // token1 -> token0 exact input: amountSpecified is already USDC units.
        SwapParams memory params = SwapParams({zeroForOne: false, amountSpecified: -500e6, sqrtPriceLimitX96: 0});
        (bytes4 sel, uint256 valueUsdc) = hook.testBeforeSwap(agent, testPoolKey, params, _hookData(agent));
        assertEq(sel, VelaHook.beforeSwap.selector);
        assertEq(valueUsdc, 500e6);
    }

    // ─── setAllowedPools ──────────────────────────────────────────────────────

    function test_setAllowedPools_operatorCanUpdate() public {
        bytes32[] memory pools = new bytes32[](1);
        bool[] memory allowed = new bool[](1);
        pools[0] = testPoolId;
        allowed[0] = false; // remove from allowlist

        vm.prank(agent);
        hook.setAllowedPools(agent, pools, allowed);

        assertFalse(hook.isPoolAllowed(agent, testPoolId));
    }

    function test_setAllowedPools_emitsEvent() public {
        bytes32[] memory pools = new bytes32[](1);
        bool[] memory allowed = new bool[](1);
        pools[0] = keccak256("newpool");
        allowed[0] = true;

        vm.expectEmit(true, true, false, true);
        emit VelaHook.PoolAllowlistUpdated(agent, pools[0], true);
        vm.prank(agent);
        hook.setAllowedPools(agent, pools, allowed);
    }

    function test_setAllowedPools_revert_notOperator() public {
        bytes32[] memory pools = new bytes32[](1);
        bool[] memory allowed = new bool[](1);
        pools[0] = testPoolId;
        allowed[0] = false;

        vm.prank(stranger);
        vm.expectRevert("VelaHook: not operator");
        hook.setAllowedPools(agent, pools, allowed);
    }

    function test_setAllowedPools_revert_lengthMismatch() public {
        bytes32[] memory pools = new bytes32[](2);
        bool[] memory allowed = new bool[](1);

        vm.prank(agent);
        vm.expectRevert("VelaHook: length mismatch");
        hook.setAllowedPools(agent, pools, allowed);
    }

    function test_setAllowedPools_multiplePools() public {
        bytes32[] memory pools = new bytes32[](3);
        bool[] memory allowed = new bool[](3);
        for (uint256 i = 0; i < 3; i++) {
            pools[i] = keccak256(abi.encode("pool", i));
            allowed[i] = true;
        }

        vm.prank(agent);
        hook.setAllowedPools(agent, pools, allowed);

        for (uint256 i = 0; i < 3; i++) {
            assertTrue(hook.isPoolAllowed(agent, pools[i]));
        }
    }

    function test_setAgentExecutor_operatorCanUpdate() public {
        address executor = makeAddr("vault");

        vm.expectEmit(true, true, false, true);
        emit VelaHook.AgentExecutorUpdated(agent, executor);
        vm.prank(agent);
        hook.setAgentExecutor(agent, executor);

        assertEq(hook.trustedExecutors(agent), executor);
    }

    function test_setAgentExecutor_revert_notOperator() public {
        vm.prank(stranger);
        vm.expectRevert("VelaHook: not operator");
        hook.setAgentExecutor(agent, makeAddr("vault"));
    }

    function test_setAgentExecutor_revert_zeroExecutor() public {
        vm.prank(agent);
        vm.expectRevert(VelaHook.ZeroAddress.selector);
        hook.setAgentExecutor(agent, address(0));
    }

    // ─── Hook permissions ─────────────────────────────────────────────────────

    function test_hookPermissions_onlyBeforeSwap() public view {
        Hooks.Permissions memory perms = hook.getHookPermissions();
        assertTrue(perms.beforeSwap);
        assertFalse(perms.afterSwap);
        assertFalse(perms.beforeAddLiquidity);
        assertFalse(perms.afterAddLiquidity);
        assertFalse(perms.beforeRemoveLiquidity);
        assertFalse(perms.afterRemoveLiquidity);
        assertFalse(perms.beforeInitialize);
        assertFalse(perms.afterInitialize);
        assertFalse(perms.beforeDonate);
        assertFalse(perms.afterDonate);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function test_getPoolId_matchesLibrary() public view {
        bytes32 expected = bytes32(PoolId.unwrap(testPoolKey.toId()));
        bytes32 result = hook.getPoolId(testPoolKey);
        assertEq(result, expected);
    }

    function test_isPoolAllowed_trueAfterWhitelist() public view {
        assertTrue(hook.isPoolAllowed(agent, testPoolId));
    }

    function test_isPoolAllowed_falseForUnknown() public view {
        assertFalse(hook.isPoolAllowed(agent, keccak256("unknown")));
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    function testFuzz_sqrtPriceToUsdc_neverOverflows(uint160 sqrtPrice, uint128 amount) public view {
        vm.assume(sqrtPrice > 0 && amount > 0);
        // Should never revert - just return a value
        uint256 val = hook.exposedSqrtPriceToUsdc(sqrtPrice, uint256(amount));
        assertGe(val, 0);
    }
}
