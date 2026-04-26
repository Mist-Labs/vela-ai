// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626}  from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20}    from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20}   from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PolicyRegistry}  from "./PolicyRegistry.sol";

/// @title  VelaVault
/// @notice ERC-4626 tokenised vault for a single Vela agent.
///         Stores an append-only feed of agent decisions with attestation state.
///         Circuit breaker from PolicyRegistry blocks deposits and transfers;
///         withdrawals (burns) are always permitted so users can always exit.
contract VelaVault is ERC4626, ReentrancyGuard {

    // ─── Errors ───────────────────────────────────────────────────────────────

    error OnlyAgent(address caller);
    error OnlySettlement(address caller);
    error CircuitBreakerActive(address agent);
    error DecisionNotFound(uint256 id);
    error AlreadyAttested(uint256 id);
    error ChallengeWindowClosed(uint256 id);
    error EmptyString(string field);

    // ─── Types ────────────────────────────────────────────────────────────────

    enum AttestationStatus { Pending, Attested, Challenged }

    struct DecisionRecord {
        bytes32           decisionHash;
        string            explanation;    // plain-English reason
        string            evidenceCID;    // 0G DA content address
        uint256           timestamp;
        uint256           challengeDeadline;
        AttestationStatus status;
        bytes32           attestationHash; // set on attestation
    }

    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant CHALLENGE_WINDOW = 24 hours;

    // ─── State ────────────────────────────────────────────────────────────────

    PolicyRegistry public immutable registry;
    address        public immutable agent;
    address        public immutable settlementContract;

    uint256                           public totalDecisions;
    mapping(uint256 => DecisionRecord) private _decisions;

    // ─── Events ───────────────────────────────────────────────────────────────

    event DecisionCommitted(
        uint256 indexed id,
        bytes32         decisionHash,
        string          explanation,
        string          evidenceCID,
        uint256         challengeDeadline
    );
    event DecisionAttested(
        uint256 indexed id,
        bytes32         attestationHash
    );
    event DecisionChallenged(
        uint256 indexed id,
        address indexed challenger
    );

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @param asset_              ERC-20 deposited by users (e.g. USDC, WETH).
    /// @param agent_              Hot wallet / contract that executes decisions.
    /// @param registry_           Deployed PolicyRegistry.
    /// @param settlementContract_ Deployed SettlementContract (can attest decisions).
    constructor(
        IERC20  asset_,
        address agent_,
        address registry_,
        address settlementContract_
    )
        ERC4626(asset_)
        ERC20("Vela Vault Share", "vlSHARE")
    {
        require(agent_              != address(0), "VelaVault: zero agent");
        require(registry_           != address(0), "VelaVault: zero registry");
        require(settlementContract_ != address(0), "VelaVault: zero settlement");

        agent              = agent_;
        registry           = PolicyRegistry(registry_);
        settlementContract = settlementContract_;
    }

    // ─── Decision Feed ────────────────────────────────────────────────────────

    /// @notice Agent commits a decision hash before executing the trade.
    ///         The 0G DA content address is stored for permissionless verification.
    /// @return id  Auto-incremented decision identifier.
    function commitDecision(
        bytes32        decisionHash,
        string calldata explanation,
        string calldata evidenceCID
    ) external nonReentrant returns (uint256 id) {
        if (msg.sender != agent) revert OnlyAgent(msg.sender);
        if (registry.circuitBreakerTriggered(agent)) revert CircuitBreakerActive(agent);
        if (bytes(explanation).length == 0) revert EmptyString("explanation");
        if (bytes(evidenceCID).length  == 0) revert EmptyString("evidenceCID");

        id = totalDecisions++;
        _decisions[id] = DecisionRecord({
            decisionHash:      decisionHash,
            explanation:       explanation,
            evidenceCID:       evidenceCID,
            timestamp:         block.timestamp,
            challengeDeadline: block.timestamp + CHALLENGE_WINDOW,
            status:            AttestationStatus.Pending,
            attestationHash:   bytes32(0)
        });

        emit DecisionCommitted(id, decisionHash, explanation, evidenceCID, block.timestamp + CHALLENGE_WINDOW);
    }

    /// @notice SettlementContract marks a decision as cryptographically attested.
    function markAttested(uint256 id, bytes32 attestationHash) external {
        if (msg.sender != settlementContract) revert OnlySettlement(msg.sender);
        if (id >= totalDecisions) revert DecisionNotFound(id);

        DecisionRecord storage d = _decisions[id];
        if (d.status != AttestationStatus.Pending) revert AlreadyAttested(id);
        if (block.timestamp > d.challengeDeadline) revert ChallengeWindowClosed(id);

        d.status          = AttestationStatus.Attested;
        d.attestationHash = attestationHash;

        emit DecisionAttested(id, attestationHash);
    }

    /// @notice SettlementContract marks a decision as challenged (violation detected).
    function markChallenged(uint256 id) external {
        if (msg.sender != settlementContract) revert OnlySettlement(msg.sender);
        if (id >= totalDecisions) revert DecisionNotFound(id);

        DecisionRecord storage d = _decisions[id];
        if (d.status == AttestationStatus.Attested) revert AlreadyAttested(id);

        d.status = AttestationStatus.Challenged;
        emit DecisionChallenged(id, tx.origin);
    }

    // ─── ERC-4626 Overrides ───────────────────────────────────────────────────

    /// @dev Block deposits and share transfers when circuit breaker is active.
    ///      Burns (withdrawals) are always permitted — users must always be able to exit.
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

    /// @notice Returns true if the decision's challenge window is still open.
    function isChallengeable(uint256 id) external view returns (bool) {
        if (id >= totalDecisions) return false;
        DecisionRecord storage d = _decisions[id];
        return (
            d.status == AttestationStatus.Pending &&
            block.timestamp <= d.challengeDeadline
        );
    }

    /// @notice Convenience: latest N decisions (most-recent first). Cap at 50.
    function recentDecisions(uint256 count)
        external view
        returns (DecisionRecord[] memory records)
    {
        uint256 n   = totalDecisions;
        uint256 cap = count > 50 ? 50 : count;
        if (cap > n) cap = n;

        records = new DecisionRecord[](cap);
        for (uint256 i = 0; i < cap; i++) {
            records[i] = _decisions[n - 1 - i];
        }
    }
}
