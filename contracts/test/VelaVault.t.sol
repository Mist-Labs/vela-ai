// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {VelaVault} from "../src/VelaVault.sol";
import {VelaHook} from "../src/hooks/VelaHook.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";

/// @dev Minimal ERC-20 for testing
contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract MockPositionToken is ERC20 {
    constructor() ERC20("Mock WETH", "mWETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockStateView {
    mapping(bytes32 => uint160) public sqrtPrices;

    function setSqrtPrice(PoolId poolId, uint160 sqrtPriceX96) external {
        sqrtPrices[PoolId.unwrap(poolId)] = sqrtPriceX96;
    }

    function getSlot0(PoolId poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)
    {
        return (sqrtPrices[PoolId.unwrap(poolId)], 0, 0, 0);
    }
}

contract MockSwapPoolManager {
    mapping(bytes32 => uint160) public sqrtPrices;
    uint256 public amountOut = 0.1 ether;

    function setSqrtPrice(PoolId poolId, uint160 sqrtPriceX96) external {
        sqrtPrices[PoolId.unwrap(poolId)] = sqrtPriceX96;
    }

    function setAmountOut(uint256 nextAmountOut) external {
        amountOut = nextAmountOut;
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        return IUnlockCallback(msg.sender).unlockCallback(data);
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (BalanceDelta)
    {
        key.hooks.beforeSwap(address(this), key, params, hookData);
        uint256 amountIn =
            params.amountSpecified < 0 ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);

        if (params.zeroForOne) {
            return toBalanceDelta(-int128(int256(amountIn)), int128(int256(amountOut)));
        }
        return toBalanceDelta(int128(int256(amountOut)), -int128(int256(amountIn)));
    }

    function sync(Currency) external {}

    function settle() external payable returns (uint256) {
        return 0;
    }

    function take(Currency currency, address to, uint256 amount) external {
        IERC20(Currency.unwrap(currency)).transfer(to, amount);
    }

    function extsload(bytes32) external view returns (bytes32) {
        return bytes32(uint256(SQRT_PRICE_2000_USDC_PER_ETH));
    }

    uint160 private constant SQRT_PRICE_2000_USDC_PER_ETH = 3_543_191_142_285_914_205_922_034;
}

contract VelaVaultTest is Test {
    MockERC20 public asset;
    MockPositionToken public positionToken;
    MockStateView public stateView;
    MockSwapPoolManager public poolManager;
    PolicyRegistry public registry;
    VelaVault public vault;
    VelaHook public hook;

    address public owner = makeAddr("owner");
    address public agentAddr = makeAddr("agent");
    address public attestation = makeAddr("attestation");
    address public user1 = makeAddr("user1");
    address public stranger = makeAddr("stranger");

    bytes32 constant POLICY_ROOT = keccak256("policy");
    string constant POLICY_URI = "0g://abc";
    bytes32 constant DECISION_HASH = keccak256("decision-0");
    string constant EXPLANATION = "Swap 1000 USDC for WETH - yield opportunity detected";
    string constant EVIDENCE_CID = "0g://evidence-cid-abc123";
    PoolId constant ETH_USDC_POOL_ID = PoolId.wrap(bytes32(uint256(1)));
    uint160 constant SQRT_PRICE_2000_USDC_PER_ETH = 3_543_191_142_285_914_205_922_034;
    uint160 constant MAX_SQRT_PRICE_MINUS_ONE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;

    function setUp() public {
        asset = new MockERC20();
        positionToken = new MockPositionToken();
        stateView = new MockStateView();
        poolManager = new MockSwapPoolManager();
        registry = new PolicyRegistry(owner);
        hook = new VelaHook(IPoolManager(address(poolManager)), address(registry));

        vault =
            new VelaVault(asset, agentAddr, address(registry), attestation, address(poolManager), address(stateView));
        stateView.setSqrtPrice(ETH_USDC_POOL_ID, SQRT_PRICE_2000_USDC_PER_ETH);
        poolManager.setSqrtPrice(ETH_USDC_POOL_ID, SQRT_PRICE_2000_USDC_PER_ETH);

        vm.prank(owner);
        registry.setContracts(attestation);

        // Register the agent
        vm.prank(agentAddr);
        registry.registerAgent(POLICY_ROOT, POLICY_URI, 0);

        // Fund users
        asset.mint(user1, 10_000e6);
        vm.prank(user1);
        asset.approve(address(vault), type(uint256).max);
    }

    // ─── commitDecision ───────────────────────────────────────────────────────

    function test_commitDecision_byAgent() public {
        vm.prank(agentAddr);
        uint256 id = vault.commitDecision(DECISION_HASH, EXPLANATION, EVIDENCE_CID);

        assertEq(id, 0);
        assertEq(vault.totalDecisions(), 1);

        VelaVault.DecisionRecord memory d = vault.getDecision(0);
        assertEq(d.decisionHash, DECISION_HASH);
        assertEq(d.explanation, EXPLANATION);
        assertEq(d.evidenceCID, EVIDENCE_CID);
        assertEq(d.timestamp, block.timestamp);
        assertEq(uint8(d.status), uint8(VelaVault.AttestationStatus.Pending));
        assertEq(d.attestationHash, bytes32(0));
    }

    function test_commitDecision_incrementsId() public {
        vm.startPrank(agentAddr);
        uint256 id0 = vault.commitDecision(keccak256("d0"), EXPLANATION, EVIDENCE_CID);
        uint256 id1 = vault.commitDecision(keccak256("d1"), EXPLANATION, EVIDENCE_CID);
        uint256 id2 = vault.commitDecision(keccak256("d2"), EXPLANATION, EVIDENCE_CID);
        vm.stopPrank();

        assertEq(id0, 0);
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(vault.totalDecisions(), 3);
    }

    function test_commitDecision_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit VelaVault.DecisionCommitted(0, DECISION_HASH, EXPLANATION, EVIDENCE_CID);
        vm.prank(agentAddr);
        vault.commitDecision(DECISION_HASH, EXPLANATION, EVIDENCE_CID);
    }

    function test_commitDecision_revert_notAgent() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VelaVault.OnlyAgent.selector, stranger));
        vault.commitDecision(DECISION_HASH, EXPLANATION, EVIDENCE_CID);
    }

    function test_commitDecision_revert_circuitBreakerActive() public {
        vm.prank(agentAddr);
        registry.triggerCircuitBreaker(agentAddr);

        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(VelaVault.CircuitBreakerActive.selector, agentAddr));
        vault.commitDecision(DECISION_HASH, EXPLANATION, EVIDENCE_CID);
    }

    function test_commitDecision_revert_emptyExplanation() public {
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(VelaVault.EmptyString.selector, "explanation"));
        vault.commitDecision(DECISION_HASH, "", EVIDENCE_CID);
    }

    function test_commitDecision_revert_emptyEvidenceCID() public {
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(VelaVault.EmptyString.selector, "evidenceCID"));
        vault.commitDecision(DECISION_HASH, EXPLANATION, "");
    }

    // ─── markAttested ─────────────────────────────────────────────────────────

    function test_markAttested_bySettlement() public {
        vm.prank(agentAddr);
        vault.commitDecision(DECISION_HASH, EXPLANATION, EVIDENCE_CID);

        bytes32 attestHash = keccak256("attestation-proof");
        vm.prank(attestation);
        vault.markAttested(0, attestHash);

        VelaVault.DecisionRecord memory d = vault.getDecision(0);
        assertEq(uint8(d.status), uint8(VelaVault.AttestationStatus.Attested));
        assertEq(d.attestationHash, attestHash);
    }

    function test_markAttested_emitsEvent() public {
        vm.prank(agentAddr);
        vault.commitDecision(DECISION_HASH, EXPLANATION, EVIDENCE_CID);

        bytes32 attestHash = keccak256("proof");
        vm.expectEmit(true, false, false, true);
        emit VelaVault.DecisionAttested(0, attestHash);
        vm.prank(attestation);
        vault.markAttested(0, attestHash);
    }

    function test_markAttested_revert_notSettlement() public {
        vm.prank(agentAddr);
        vault.commitDecision(DECISION_HASH, EXPLANATION, EVIDENCE_CID);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VelaVault.OnlyAttestation.selector, stranger));
        vault.markAttested(0, keccak256("proof"));
    }

    function test_markAttested_revert_invalidId() public {
        vm.prank(attestation);
        vm.expectRevert(abi.encodeWithSelector(VelaVault.DecisionNotFound.selector, 99));
        vault.markAttested(99, keccak256("proof"));
    }

    function test_markAttested_revert_alreadyAttested() public {
        vm.prank(agentAddr);
        vault.commitDecision(DECISION_HASH, EXPLANATION, EVIDENCE_CID);
        vm.prank(attestation);
        vault.markAttested(0, keccak256("proof"));

        vm.prank(attestation);
        vm.expectRevert(abi.encodeWithSelector(VelaVault.AlreadyAttested.selector, 0));
        vault.markAttested(0, keccak256("proof2"));
    }

    // ─── ERC-4626 Deposit / Withdraw ──────────────────────────────────────────

    function test_deposit_mintsShares() public {
        uint256 amount = 1_000e6;
        vm.prank(user1);
        uint256 shares = vault.deposit(amount, user1);

        assertGt(shares, 0);
        assertEq(vault.balanceOf(user1), shares);
        assertEq(asset.balanceOf(address(vault)), amount);
    }

    function test_withdraw_returnsAsset() public {
        uint256 amount = 1_000e6;
        vm.prank(user1);
        vault.deposit(amount, user1);

        uint256 shares = vault.balanceOf(user1);
        vm.prank(user1);
        uint256 withdrawn = vault.redeem(shares, user1, user1);

        assertEq(withdrawn, amount);
        assertEq(vault.balanceOf(user1), 0);
        assertEq(asset.balanceOf(user1), 10_000e6);
    }

    // ─── Multi-Asset NAV ─────────────────────────────────────────────────────

    function test_addPosition_byOwner() public {
        uint256 index = vault.addPosition(ETH_USDC_POOL_ID, address(positionToken), true);

        assertEq(index, 0);
        assertEq(vault.positionCount(), 1);

        VelaVault.PoolPosition memory position = vault.getPosition(0);
        assertEq(PoolId.unwrap(position.poolId), PoolId.unwrap(ETH_USDC_POOL_ID));
        assertEq(position.token, address(positionToken));
        assertTrue(position.tokenIsCurrency0);
        assertTrue(position.active);
        assertEq(position.balance, 0);
    }

    function test_addPosition_revert_notOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VelaVault.OnlyOwner.selector, stranger));
        vault.addPosition(ETH_USDC_POOL_ID, address(positionToken), true);
    }

    function test_addPosition_revert_vaultAssetWouldDoubleCount() public {
        vm.expectRevert(VelaVault.InvalidPosition.selector);
        vault.addPosition(ETH_USDC_POOL_ID, address(asset), true);
    }

    function test_addPosition_revert_uninitializedPool() public {
        PoolId uninitializedPool = PoolId.wrap(bytes32(uint256(2)));

        vm.expectRevert(VelaVault.InvalidPosition.selector);
        vault.addPosition(uninitializedPool, address(positionToken), true);
    }

    function test_totalAssets_includesConfiguredPositionValue() public {
        asset.mint(address(vault), 1_000e6);
        positionToken.mint(address(vault), 1 ether);

        vault.addPosition(ETH_USDC_POOL_ID, address(positionToken), true);

        assertApproxEqAbs(vault.totalAssets(), 3_000e6, 2);
    }

    function test_totalAssets_usesLivePositionBalanceBeforeSync() public {
        vault.addPosition(ETH_USDC_POOL_ID, address(positionToken), true);
        positionToken.mint(address(vault), 1 ether);

        VelaVault.PoolPosition memory position = vault.getPosition(0);
        assertEq(position.balance, 0);
        assertApproxEqAbs(vault.totalAssets(), 2_000e6, 2);
    }

    function test_syncPositionBalance_updatesSnapshot() public {
        vault.addPosition(ETH_USDC_POOL_ID, address(positionToken), true);
        positionToken.mint(address(vault), 2 ether);

        uint256 balance = vault.syncPositionBalance(0);

        assertEq(balance, 2 ether);
        assertEq(vault.getPosition(0).balance, 2 ether);
    }

    // ─── Hook-Enforced Trading ───────────────────────────────────────────────

    function test_executeHookSwap_usesVaultCapitalAndVelaHook() public {
        PoolKey memory key = _hookPoolKey();
        bytes32 poolId = hook.getPoolId(key);
        bytes32[] memory pools = new bytes32[](1);
        bool[] memory allowed = new bool[](1);
        pools[0] = poolId;
        allowed[0] = true;

        vm.prank(agentAddr);
        hook.setAllowedPools(agentAddr, pools, allowed);

        vault.setTrustedHook(address(hook));
        asset.mint(address(vault), 500e6);
        positionToken.mint(address(poolManager), 1 ether);

        VelaVault.HookSwapParams memory params = VelaVault.HookSwapParams({
            key: key,
            zeroForOne: false,
            amountIn: 200e6,
            minAmountOut: 0.09 ether,
            sqrtPriceLimitX96: MAX_SQRT_PRICE_MINUS_ONE
        });

        vm.prank(agentAddr);
        uint256 amountOut = vault.executeHookSwap(params);

        assertEq(amountOut, 0.1 ether);
        assertEq(asset.balanceOf(address(vault)), 300e6);
        assertEq(positionToken.balanceOf(address(vault)), 0.1 ether);
    }

    function test_executeHookSwap_revert_untrustedHook() public {
        VelaVault.HookSwapParams memory params = VelaVault.HookSwapParams({
            key: _hookPoolKey(),
            zeroForOne: false,
            amountIn: 200e6,
            minAmountOut: 0,
            sqrtPriceLimitX96: MAX_SQRT_PRICE_MINUS_ONE
        });

        vm.prank(agentAddr);
        vm.expectRevert(VelaVault.HookNotConfigured.selector);
        vault.executeHookSwap(params);
    }

    function test_executeHookSwap_revert_onlyAgent() public {
        vault.setTrustedHook(address(hook));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VelaVault.OnlyAgent.selector, stranger));
        vault.executeHookSwap(
            VelaVault.HookSwapParams({
                key: _hookPoolKey(),
                zeroForOne: false,
                amountIn: 200e6,
                minAmountOut: 0,
                sqrtPriceLimitX96: MAX_SQRT_PRICE_MINUS_ONE
            })
        );
    }

    // ─── Circuit Breaker: ERC-20 Transfer Blocking ────────────────────────────

    function test_circuitBreaker_blocksDeposit() public {
        vm.prank(agentAddr);
        registry.triggerCircuitBreaker(agentAddr);

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(VelaVault.CircuitBreakerActive.selector, agentAddr));
        vault.deposit(1_000e6, user1);
    }

    function test_circuitBreaker_blocksTransfer() public {
        vm.prank(user1);
        vault.deposit(1_000e6, user1);

        vm.prank(agentAddr);
        registry.triggerCircuitBreaker(agentAddr);

        address user2 = makeAddr("user2");
        uint256 shares = vault.balanceOf(user1);
        vm.startPrank(user1);
        vm.expectRevert(abi.encodeWithSelector(VelaVault.CircuitBreakerActive.selector, agentAddr));
        vault.transfer(user2, shares);
        vm.stopPrank();
    }

    function test_circuitBreaker_allowsWithdrawal() public {
        vm.prank(user1);
        vault.deposit(1_000e6, user1);

        vm.prank(agentAddr);
        registry.triggerCircuitBreaker(agentAddr);

        // Withdrawal (burn) must succeed - users must always be able to exit
        uint256 shares = vault.balanceOf(user1);
        vm.prank(user1);
        uint256 withdrawn = vault.redeem(shares, user1, user1);
        assertEq(withdrawn, 1_000e6);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function test_getDecisionHash_returnsCommittedHash() public {
        vm.prank(agentAddr);
        vault.commitDecision(DECISION_HASH, EXPLANATION, EVIDENCE_CID);
        assertEq(vault.getDecisionHash(0), DECISION_HASH);
    }

    function test_recentDecisions_correctOrder() public {
        vm.startPrank(agentAddr);
        for (uint256 i = 0; i < 5; i++) {
            vault.commitDecision(keccak256(abi.encode(i)), EXPLANATION, EVIDENCE_CID);
        }
        vm.stopPrank();

        VelaVault.DecisionRecord[] memory recent = vault.recentDecisions(3);
        assertEq(recent.length, 3);
        // Most recent first: id 4, 3, 2
        assertEq(recent[0].decisionHash, keccak256(abi.encode(uint256(4))));
        assertEq(recent[1].decisionHash, keccak256(abi.encode(uint256(3))));
        assertEq(recent[2].decisionHash, keccak256(abi.encode(uint256(2))));
    }

    function test_recentDecisions_capsAt50() public {
        vm.startPrank(agentAddr);
        for (uint256 i = 0; i < 60; i++) {
            vault.commitDecision(keccak256(abi.encode(i)), EXPLANATION, EVIDENCE_CID);
        }
        vm.stopPrank();

        VelaVault.DecisionRecord[] memory recent = vault.recentDecisions(100);
        assertEq(recent.length, 50);
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    function testFuzz_commitDecision_anyHash(bytes32 hash) public {
        vm.assume(hash != bytes32(0));
        vm.prank(agentAddr);
        uint256 id = vault.commitDecision(hash, EXPLANATION, EVIDENCE_CID);
        assertEq(vault.getDecision(id).decisionHash, hash);
    }

    function testFuzz_depositAndRedeem_roundtrip(uint256 amount) public {
        amount = bound(amount, 1e6, 5_000e6); // 1 to 5000 USDC
        asset.mint(user1, amount);
        vm.prank(user1);
        asset.approve(address(vault), amount);
        vm.prank(user1);
        vault.deposit(amount, user1);

        uint256 shares = vault.balanceOf(user1);
        vm.prank(user1);
        uint256 out = vault.redeem(shares, user1, user1);

        // Allow 1 wei rounding error
        assertApproxEqAbs(out, amount, 1);
    }

    function _hookPoolKey() private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(positionToken)),
            currency1: Currency.wrap(address(asset)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }
}
