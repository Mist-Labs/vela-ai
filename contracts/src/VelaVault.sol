// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/types/BalanceDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {PolicyRegistry} from "./PolicyRegistry.sol";

interface IV4StateView {
    function getSlot0(PoolId poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

/// @title  VelaVault
/// @notice ERC-4626 tokenised vault for a single Vela agent.
///         Stores an append-only feed of agent decisions with attestation state.
///         Circuit breaker from PolicyRegistry blocks deposits and transfers;
///         withdrawals (burns) are always permitted so users can always exit.
contract VelaVault is ERC4626, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    // ─── Errors ───────────────────────────────────────────────────────────────

    error OnlyAgent(address caller);
    error OnlyAttestation(address caller);
    error CircuitBreakerActive(address agent);
    error DecisionNotFound(uint256 id);
    error AlreadyAttested(uint256 id);
    error EmptyString(string field);
    error OnlyOwner(address caller);
    error ZeroAddress(string field);
    error InvalidPosition();
    error PositionNotFound(uint256 index);
    error OnlyPoolManager(address caller);
    error HookNotConfigured();
    error UntrustedHook(address hook);
    error NativeCurrencyUnsupported();
    error ExactInputOnly();
    error InsufficientSwapOutput(uint256 received, uint256 minimum);
    error UnsupportedSwapCurrency(address token);

    // ─── Types ────────────────────────────────────────────────────────────────

    enum AttestationStatus {
        Pending,
        Attested
    }

    struct DecisionRecord {
        bytes32 decisionHash;
        string explanation; // plain-English reason
        string evidenceCID; // 0G DA content address
        uint256 timestamp;
        AttestationStatus status;
        bytes32 attestationHash; // set on attestation
    }

    struct PoolPosition {
        PoolId poolId;
        address token;
        bool tokenIsCurrency0;
        bool active;
        uint256 balance; // last synced token balance; NAV reads live balances for safety.
    }

    struct HookSwapParams {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        uint256 minAmountOut;
        uint160 sqrtPriceLimitX96;
    }

    // ─── State ────────────────────────────────────────────────────────────────

    PolicyRegistry public immutable registry;
    address public immutable agent;
    address public immutable attestationContract;
    address public immutable owner;
    IPoolManager public immutable poolManager;
    IV4StateView public immutable poolStateView;
    address public trustedHook;

    uint256 public totalDecisions;
    mapping(uint256 => DecisionRecord) private _decisions;
    PoolPosition[] private _positions;
    mapping(bytes32 positionKey => bool configured) private _positionConfigured;
    mapping(address token => bool supported) public supportedSwapToken;

    // ─── Events ───────────────────────────────────────────────────────────────

    event DecisionCommitted(uint256 indexed id, bytes32 decisionHash, string explanation, string evidenceCID);
    event DecisionAttested(uint256 indexed id, bytes32 attestationHash);
    event PositionAdded(
        uint256 indexed index, PoolId indexed poolId, address indexed token, bool tokenIsCurrency0, uint256 balance
    );
    event PositionSynced(uint256 indexed index, address indexed token, uint256 balance);
    event TrustedHookUpdated(address indexed hook);
    event HookSwapExecuted(
        PoolId indexed poolId, address indexed agent, bool zeroForOne, uint256 amountIn, uint256 amountOut, address hook
    );

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @param asset_              ERC-20 deposited by users (e.g. USDC, WETH).
    /// @param agent_              Hot wallet / contract that executes decisions.
    /// @param registry_           Deployed PolicyRegistry.
    /// @param attestationContract_ Deployed AttestationContract (can attest decisions).
    /// @param poolManager_        Uniswap v4 PoolManager used for all vault swaps.
    /// @param poolStateView_       Official Uniswap v4 StateView reader for pool slot0.
    constructor(
        IERC20 asset_,
        address agent_,
        address registry_,
        address attestationContract_,
        address poolManager_,
        address poolStateView_
    ) ERC4626(asset_) ERC20("Vela Vault Share", "vlSHARE") {
        if (agent_ == address(0)) revert ZeroAddress("agent");
        if (registry_ == address(0)) revert ZeroAddress("registry");
        if (attestationContract_ == address(0)) revert ZeroAddress("attestation");
        if (poolManager_ == address(0)) revert ZeroAddress("poolManager");
        if (poolStateView_ == address(0)) revert ZeroAddress("poolStateView");

        owner = msg.sender;
        agent = agent_;
        registry = PolicyRegistry(registry_);
        attestationContract = attestationContract_;
        poolManager = IPoolManager(poolManager_);
        poolStateView = IV4StateView(poolStateView_);
        supportedSwapToken[address(asset_)] = true;
    }

    // ─── Decision Feed ────────────────────────────────────────────────────────

    /// @notice Agent commits a decision hash before executing the trade.
    ///         The 0G DA content address is stored for permissionless verification.
    /// @return id  Auto-incremented decision identifier.
    function commitDecision(bytes32 decisionHash, string calldata explanation, string calldata evidenceCID)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (msg.sender != agent) revert OnlyAgent(msg.sender);
        if (registry.circuitBreakerTriggered(agent)) revert CircuitBreakerActive(agent);
        if (bytes(explanation).length == 0) revert EmptyString("explanation");
        if (bytes(evidenceCID).length == 0) revert EmptyString("evidenceCID");

        id = totalDecisions++;
        _decisions[id] = DecisionRecord({
            decisionHash: decisionHash,
            explanation: explanation,
            evidenceCID: evidenceCID,
            timestamp: block.timestamp,
            status: AttestationStatus.Pending,
            attestationHash: bytes32(0)
        });

        emit DecisionCommitted(id, decisionHash, explanation, evidenceCID);
    }

    /// @notice AttestationContract marks a decision as cryptographically attested.
    function markAttested(uint256 id, bytes32 attestationHash) external {
        if (msg.sender != attestationContract) revert OnlyAttestation(msg.sender);
        if (id >= totalDecisions) revert DecisionNotFound(id);

        DecisionRecord storage d = _decisions[id];
        if (d.status != AttestationStatus.Pending) revert AlreadyAttested(id);

        d.status = AttestationStatus.Attested;
        d.attestationHash = attestationHash;

        emit DecisionAttested(id, attestationHash);
    }

    // ─── Multi-Asset Position Registry ───────────────────────────────────────

    /// @notice Register a token position priced by a Uniswap v4 pool against the vault asset.
    /// @dev If tokenIsCurrency0 is true, slot0 prices token -> asset directly.
    ///      If false, slot0 is inverted so currency1 token value is returned in currency0 asset units.
    function addPosition(PoolId poolId, address token, bool tokenIsCurrency0) external returns (uint256 index) {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        if (PoolId.unwrap(poolId) == bytes32(0)) revert InvalidPosition();
        if (token == address(0)) revert ZeroAddress("token");
        if (token == asset()) revert InvalidPosition();

        (uint160 sqrtPriceX96,,,) = poolStateView.getSlot0(poolId);
        if (sqrtPriceX96 == 0) revert InvalidPosition();

        bytes32 key = keccak256(abi.encode(poolId, token, tokenIsCurrency0));
        if (_positionConfigured[key]) revert InvalidPosition();

        uint256 balance = IERC20(token).balanceOf(address(this));
        index = _positions.length;
        _positions.push(
            PoolPosition({
                poolId: poolId, token: token, tokenIsCurrency0: tokenIsCurrency0, active: true, balance: balance
            })
        );
        _positionConfigured[key] = true;
        supportedSwapToken[token] = true;

        emit PositionAdded(index, poolId, token, tokenIsCurrency0, balance);
    }

    /// @notice Refresh the stored balance snapshot for UI/demo display.
    /// @dev NAV uses live ERC-20 balances even if this function has not been called.
    function syncPositionBalance(uint256 index) external returns (uint256 balance) {
        if (index >= _positions.length) revert PositionNotFound(index);

        PoolPosition storage position = _positions[index];
        balance = IERC20(position.token).balanceOf(address(this));
        position.balance = balance;

        emit PositionSynced(index, position.token, balance);
    }

    // ─── Hook-Enforced Trading ───────────────────────────────────────────────

    function setTrustedHook(address hook) external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        if (hook == address(0)) revert ZeroAddress("hook");
        trustedHook = hook;
        emit TrustedHookUpdated(hook);
    }

    /// @notice Execute an exact-input Uniswap v4 swap through the configured VelaHook only.
    /// @dev Fails closed if the hook is unset or the PoolKey does not target the trusted hook.
    function executeHookSwap(HookSwapParams calldata params) external nonReentrant returns (uint256 amountOut) {
        if (msg.sender != agent) revert OnlyAgent(msg.sender);
        if (registry.circuitBreakerTriggered(agent)) revert CircuitBreakerActive(agent);
        if (trustedHook == address(0)) revert HookNotConfigured();
        if (address(params.key.hooks) != trustedHook) revert UntrustedHook(address(params.key.hooks));
        if (Currency.unwrap(params.key.currency0) == address(0) || Currency.unwrap(params.key.currency1) == address(0))
        {
            revert NativeCurrencyUnsupported();
        }
        _requireSupportedCurrency(params.key.currency0);
        _requireSupportedCurrency(params.key.currency1);
        if (params.amountIn == 0) revert ExactInputOnly();

        amountOut = abi.decode(poolManager.unlock(abi.encode(params)), (uint256));
        emit HookSwapExecuted(
            params.key.toId(), agent, params.zeroForOne, params.amountIn, amountOut, address(params.key.hooks)
        );
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager(msg.sender);

        HookSwapParams memory params = abi.decode(data, (HookSwapParams));
        BalanceDelta delta = poolManager.swap(
            params.key,
            SwapParams({
                zeroForOne: params.zeroForOne,
                amountSpecified: -int256(params.amountIn),
                sqrtPriceLimitX96: params.sqrtPriceLimitX96
            }),
            abi.encode(agent)
        );

        _settleIfDebt(params.key.currency0, delta.amount0());
        _settleIfDebt(params.key.currency1, delta.amount1());

        uint256 amountOut = params.zeroForOne
            ? _takeIfCredit(params.key.currency1, delta.amount1())
            : _takeIfCredit(params.key.currency0, delta.amount0());
        if (amountOut < params.minAmountOut) revert InsufficientSwapOutput(amountOut, params.minAmountOut);

        return abi.encode(amountOut);
    }

    function transfer(address to, uint256 value) public override(ERC20, IERC20) returns (bool) {
        if (registry.circuitBreakerTriggered(agent)) {
            revert CircuitBreakerActive(agent);
        }
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override(ERC20, IERC20) returns (bool) {
        if (registry.circuitBreakerTriggered(agent)) {
            revert CircuitBreakerActive(agent);
        }
        return super.transferFrom(from, to, value);
    }

    // ─── ERC-4626 Overrides ───────────────────────────────────────────────────

    /// @notice Live NAV in vault-asset units: idle asset balance + configured asset positions.
    function totalAssets() public view override returns (uint256 total) {
        total = IERC20(asset()).balanceOf(address(this));

        for (uint256 i = 0; i < _positions.length; i++) {
            PoolPosition memory position = _positions[i];
            if (!position.active) continue;

            uint256 tokenBalance = IERC20(position.token).balanceOf(address(this));
            if (tokenBalance == 0) continue;

            (uint160 sqrtPriceX96,,,) = poolStateView.getSlot0(position.poolId);
            total += _valueInAssetUnits(sqrtPriceX96, tokenBalance, position.tokenIsCurrency0);
        }
    }

    /// @dev Block deposits and share transfers when circuit breaker is active.
    ///      Burns (withdrawals) are always permitted - users must always be able to exit.
    function _update(address from, address to, uint256 value) internal override {
        bool isBurn = (to == address(0));
        if (!isBurn && registry.circuitBreakerTriggered(agent)) {
            revert CircuitBreakerActive(agent);
        }
        super._update(from, to, value);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getDecision(uint256 id) external view returns (DecisionRecord memory) {
        if (id >= totalDecisions) revert DecisionNotFound(id);
        return _decisions[id];
    }

    function getDecisionHash(uint256 id) external view returns (bytes32) {
        if (id >= totalDecisions) revert DecisionNotFound(id);
        return _decisions[id].decisionHash;
    }

    function positionCount() external view returns (uint256) {
        return _positions.length;
    }

    function getPosition(uint256 index) external view returns (PoolPosition memory) {
        if (index >= _positions.length) revert PositionNotFound(index);
        return _positions[index];
    }

    function positionBalance(uint256 index) external view returns (uint256) {
        if (index >= _positions.length) revert PositionNotFound(index);
        return IERC20(_positions[index].token).balanceOf(address(this));
    }

    /// @notice Convenience: latest N decisions (most-recent first). Cap at 50.
    function recentDecisions(uint256 count) external view returns (DecisionRecord[] memory records) {
        uint256 n = totalDecisions;
        uint256 cap = count > 50 ? 50 : count;
        if (cap > n) cap = n;

        records = new DecisionRecord[](cap);
        for (uint256 i = 0; i < cap; i++) {
            records[i] = _decisions[n - 1 - i];
        }
    }

    function _valueInAssetUnits(uint160 sqrtPriceX96, uint256 amount, bool tokenIsCurrency0)
        private
        pure
        returns (uint256)
    {
        if (sqrtPriceX96 == 0 || amount == 0) return 0;

        if (tokenIsCurrency0) {
            uint256 token1PerToken0 = FullMath.mulDiv(amount, sqrtPriceX96, 2 ** 96);
            return FullMath.mulDiv(token1PerToken0, sqrtPriceX96, 2 ** 96);
        }

        uint256 token0PerToken1 = FullMath.mulDiv(amount, 2 ** 96, sqrtPriceX96);
        return FullMath.mulDiv(token0PerToken1, 2 ** 96, sqrtPriceX96);
    }

    function _settleIfDebt(Currency currency, int128 delta) private {
        if (delta >= 0) return;
        _requireSupportedCurrency(currency);
        uint256 amount = uint256(uint128(-delta));
        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
        poolManager.settle();
    }

    function _takeIfCredit(Currency currency, int128 delta) private returns (uint256 amount) {
        if (delta <= 0) return 0;
        _requireSupportedCurrency(currency);
        amount = uint256(uint128(delta));
        poolManager.take(currency, address(this), amount);
    }

    function _requireSupportedCurrency(Currency currency) private view {
        address token = Currency.unwrap(currency);
        if (!supportedSwapToken[token]) revert UnsupportedSwapCurrency(token);
    }
}
