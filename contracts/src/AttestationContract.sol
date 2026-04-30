// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IVelaVault {
    function agent() external view returns (address);
    function getDecisionHash(uint256 decisionId) external view returns (bytes32);
    function markAttested(uint256 decisionId, bytes32 attestationHash) external;
}

interface IPolicyRegistry {
    function recordAttestation(address agent, bool valid) external;
    function triggerCircuitBreaker(address agent) external;
}

/**
 * @title AttestationContract
 * @notice Verifies that each trade decision was produced by a registered
 *         0G Sealed Inference enclave. No challenge window - verification
 *         is immediate. Failures trigger instant circuit break via
 *         PolicyRegistry.
 *
 * Trust model:
 *   1. Owner verifies the 0G enclave's Intel TDX attestation report once
 *      off-chain using DCAP, then registers the enclave public key here.
 *   2. verifyAndSettle() recovers the signer from the EIP-191 digest
 *      of the provider-signed payload. Signer must be a registered enclave key.
 *   3. contentHash must match the signed payload digest committed on-chain in
 *      VelaVault - proves the settled response is the committed 0G DA record.
 *   4. On any failure the watchtower calls reportFailure() which triggers
 *      the circuit breaker on PolicyRegistry instantly.
 */
contract AttestationContract is Ownable {
    using ECDSA for bytes32;

    // ─────────────────────────────── storage ────────────────────────────────

    /// @dev Enclave public keys verified off-chain via Intel DCAP.
    mapping(address => bool) public registeredEnclaveKeys;

    /// @dev Tracks which (vault, decisionId) pairs have been settled.
    mapping(address => mapping(uint256 => bool)) public settled;

    /// @dev Watchtower accounts authorized to report integrity failures.
    mapping(address => bool) public watchtowers;

    IPolicyRegistry public immutable registry;

    // ─────────────────────────────── errors ─────────────────────────────────

    error UnregisteredEnclave(address recovered);
    error HashMismatch(bytes32 expected, bytes32 provided);
    error AlreadySettled(address vault, uint256 decisionId);
    error ZeroAddress();
    error UnauthorizedReporter(address reporter);

    // ─────────────────────────────── events ─────────────────────────────────

    event EnclaveKeyRegistered(address indexed enclaveKey);
    event EnclaveKeyRevoked(address indexed enclaveKey);
    event WatchtowerUpdated(address indexed watchtower, bool authorized);
    event DecisionSettled(
        address indexed vault, uint256 indexed decisionId, address indexed enclave, bytes32 contentHash
    );
    event AttestationFailure(address indexed vault, uint256 indexed decisionId, string reason);

    // ─────────────────────────────── constructor ─────────────────────────────

    constructor(address _registry) Ownable(msg.sender) {
        if (_registry == address(0)) revert ZeroAddress();
        registry = IPolicyRegistry(_registry);
    }

    // ─────────────────────────── admin functions ─────────────────────────────

    /**
     * @notice Register a 0G enclave public key after off-chain DCAP verification.
     * @param enclaveKey The address derived from the enclave's signing key.
     */
    function registerEnclaveKey(address enclaveKey) external onlyOwner {
        if (enclaveKey == address(0)) revert ZeroAddress();
        registeredEnclaveKeys[enclaveKey] = true;
        emit EnclaveKeyRegistered(enclaveKey);
    }

    /**
     * @notice Revoke a previously registered enclave key (e.g. key rotation).
     */
    function revokeEnclaveKey(address enclaveKey) external onlyOwner {
        registeredEnclaveKeys[enclaveKey] = false;
        emit EnclaveKeyRevoked(enclaveKey);
    }

    /**
     * @notice Authorize or revoke a watchtower account that can report
     *         integrity failures and trigger the circuit breaker.
     */
    function setWatchtower(address watchtower, bool authorized) external onlyOwner {
        if (watchtower == address(0)) revert ZeroAddress();
        watchtowers[watchtower] = authorized;
        emit WatchtowerUpdated(watchtower, authorized);
    }

    // ─────────────────────────── core verification ───────────────────────────

    /**
     * @notice Verify and settle a TEE-attested decision.
     *
     * @param vault       Address of the VelaVault that committed the decision.
     * @param decisionId  ID returned by VelaVault.commitDecision().
     * @param contentHash EIP-191 digest of the exact 0G provider-signed
     *                    payload. Must match the digest committed on-chain
     *                    in VelaVault.
     * @param sig         65-byte ECDSA signature produced by the 0G enclave
     *                    over contentHash.
     *
     * Reverts on:
     *   - Already settled
     *   - Unregistered enclave signer
     *   - contentHash != committed decisionHash
     */
    function verifyAndSettle(address vault, uint256 decisionId, bytes32 contentHash, bytes calldata sig) external {
        if (vault == address(0)) revert ZeroAddress();
        if (settled[vault][decisionId]) {
            revert AlreadySettled(vault, decisionId);
        }

        // 1. Recover signer from the EIP-191 digest of the signed payload.
        address signer = contentHash.recover(sig);

        if (!registeredEnclaveKeys[signer]) {
            revert UnregisteredEnclave(signer);
        }

        // 2. Verify contentHash matches what was committed on-chain.
        bytes32 committed = IVelaVault(vault).getDecisionHash(decisionId);
        if (committed != contentHash) {
            revert HashMismatch(committed, contentHash);
        }

        // 3. Mark settled, update vault and registry.
        settled[vault][decisionId] = true;

        IVelaVault(vault).markAttested(decisionId, contentHash);
        address agent = IVelaVault(vault).agent();
        registry.recordAttestation(agent, true);

        emit DecisionSettled(vault, decisionId, signer, contentHash);
    }

    /**
     * @notice Report an attestation failure (called by the watchtower).
     *         Triggers an immediate circuit break on the agent's vault.
     *
     * @param vault      The affected vault.
     * @param decisionId The decision ID that failed.
     * @param reason     Human-readable failure reason for the event log.
     */
    function reportFailure(address vault, uint256 decisionId, string calldata reason) external {
        if (vault == address(0)) revert ZeroAddress();
        if (msg.sender != owner() && !watchtowers[msg.sender]) {
            revert UnauthorizedReporter(msg.sender);
        }
        emit AttestationFailure(vault, decisionId, reason);
        address agent = IVelaVault(vault).agent();
        registry.recordAttestation(agent, false);
        registry.triggerCircuitBreaker(agent);
    }

    // ─────────────────────────────── views ──────────────────────────────────

    /**
     * @notice Returns true if a decision has been successfully settled.
     */
    function isSettled(address vault, uint256 decisionId) external view returns (bool) {
        return settled[vault][decisionId];
    }

    /**
     * @notice Returns true if the given key belongs to a registered enclave.
     */
    function isRegisteredEnclave(address key) external view returns (bool) {
        return registeredEnclaveKeys[key];
    }
}
