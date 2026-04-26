// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable}         from "@openzeppelin/contracts/access/Ownable.sol";
import {PolicyRegistry}  from "./PolicyRegistry.sol";

/// @title  SlashingModule
/// @notice Permissionless bond slashing for Vela policy violations.
///         Anyone who can produce a valid violation proof (currently a signed
///         attestation of the violating decision hash) can claim 80% of the
///         agent's bond. The remaining 20% flows to the protocol treasury.
///
/// @dev    Proof format (MVP): abi.encode(bytes32 violatingDecisionHash, bytes32 policyRoot)
///         Production upgrade: replace _verifyViolation with SP1 Groth16 proof verification.
contract SlashingModule is ReentrancyGuard, Ownable {

    // ─── Errors ───────────────────────────────────────────────────────────────

    error AgentNotActive(address agent);
    error NoBondToSlash(address agent);
    error InvalidProof();
    error TransferFailed(address to, uint256 amount);
    error ZeroAddress();
    error AlreadySlashed(address agent);

    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant CHALLENGER_BPS  = 8_000; // 80%
    uint256 public constant TREASURY_BPS    = 2_000; // 20%
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ─── State ────────────────────────────────────────────────────────────────

    PolicyRegistry public immutable registry;
    address        public           treasury;

    // Track slashed agents to prevent double-slash attempts on stale state
    mapping(address => bool) public slashed;

    // ─── Events ───────────────────────────────────────────────────────────────

    event Slashed(
        address indexed agent,
        address indexed challenger,
        uint256         totalBond,
        uint256         challengerReward,
        uint256         treasuryCut,
        bytes32         violatingDecisionHash
    );
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address registry_, address treasury_, address initialOwner)
        Ownable(initialOwner)
    {
        if (registry_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        registry = PolicyRegistry(registry_);
        treasury = treasury_;
    }

    // ─── Core: Slash ──────────────────────────────────────────────────────────

    /// @notice Permissionlessly slash an agent by providing a violation proof.
    ///         Caller receives 80% of the agent's bond; treasury receives 20%.
    ///
    /// @param  agent          Address of the registered agent to slash.
    /// @param  violationProof ABI-encoded violation evidence.
    ///                        MVP: abi.encode(bytes32 decisionHash, bytes32 policyRoot)
    ///                        Production: SP1 Groth16 proof bytes.
    function slash(address agent, bytes calldata violationProof)
        external
        nonReentrant
    {
        // ── Pre-conditions ───────────────────────────────────────────────────
        if (slashed[agent]) revert AlreadySlashed(agent);

        PolicyRegistry.PolicyCommitment memory policy = registry.getPolicy(agent);
        if (!policy.active) revert AgentNotActive(agent);
        if (policy.bondAmount == 0) revert NoBondToSlash(agent);

        // ── Verify proof ─────────────────────────────────────────────────────
        bytes32 violatingHash = _verifyViolation(policy.policyRoot, violationProof);

        // ── Mark slashed (CEI: effects before interactions) ──────────────────
        slashed[agent] = true;

        // ── Seize bond (triggers deactivation inside registry) ───────────────
        // registry.seizeBond transfers the ETH to this contract
        uint256 totalBond = registry.seizeBond(agent);

        // ── Distribute ───────────────────────────────────────────────────────
        uint256 challengerReward = (totalBond * CHALLENGER_BPS) / BPS_DENOMINATOR;
        uint256 treasuryCut      = totalBond - challengerReward; // avoids rounding dust going to challenger

        _safeTransferETH(msg.sender, challengerReward);
        _safeTransferETH(treasury,   treasuryCut);

        emit Slashed(
            agent,
            msg.sender,
            totalBond,
            challengerReward,
            treasuryCut,
            violatingHash
        );
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Update the treasury address. Only owner.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    // ─── Receive ETH (from registry.seizeBond) ────────────────────────────────

    receive() external payable {}

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev MVP proof verification: decodes (decisionHash, policyRoot) and
    ///      confirms the policyRoot matches the agent's committed root.
    ///
    ///      UPGRADE PATH: replace with SP1 Groth16 verifier call once the
    ///      policy compliance guest program is compiled and the VKEY is known.
    ///      The public outputs are: abi.encode(bytes32 decisionHash, bytes32 policyRoot, bool compliant)
    ///      where compliant == false indicates a violation.
    function _verifyViolation(bytes32 policyRoot, bytes calldata proof)
        internal
        pure
        returns (bytes32 violatingDecisionHash)
    {
        if (proof.length < 64) revert InvalidProof();

        bytes32 proofDecisionHash;
        bytes32 proofPolicyRoot;

        assembly {
            proofDecisionHash := calldataload(proof.offset)
            proofPolicyRoot   := calldataload(add(proof.offset, 32))
        }

        // The proof must reference the agent's exact committed policy root
        if (proofPolicyRoot != policyRoot) revert InvalidProof();
        // Decision hash must be non-zero
        if (proofDecisionHash == bytes32(0)) revert InvalidProof();

        violatingDecisionHash = proofDecisionHash;
    }

    /// @dev Safe ETH transfer that reverts with a typed error on failure.
    function _safeTransferETH(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);
    }
}
