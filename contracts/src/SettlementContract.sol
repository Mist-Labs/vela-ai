// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PolicyRegistry} from "./PolicyRegistry.sol";
import {VelaVault} from "./VelaVault.sol";

/// @title  SettlementContract
/// @notice Settles Vela agent decisions using 0G Sealed Inference TEE attestation.
///
/// @dev    Settlement flow:
///         1. Owner registers the 0G enclave public key after off-chain DCAP
///            verification (the enclave key is generated inside Intel TDX;
///            the DCAP report binds it to genuine hardware).
///         2. After each trade, the agent submits: (contentHash, enclaveSignature)
///            where contentHash = keccak256(full decision JSON uploaded to 0G DA).
///         3. settle() recovers the signer from (contentHash, sig) and confirms
///            it matches a registered enclave key.
///         4. contentHash is verified against the committed decisionHash stored
///            in VelaVault - proving the settled response IS the committed record.
///         5. On success: VelaVault.markAttested(), PolicyRegistry.recordDecision().
///
///         Production upgrade path: replace registered key check with on-chain
///         Intel DCAP verification (quote verification library) to remove the
///         trusted-registration step entirely.
contract SettlementContract is Ownable, ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ─── Errors ───────────────────────────────────────────────────────────────

    error UnregisteredEnclave(address recovered);
    error HashMismatch(bytes32 expected, bytes32 provided);
    error AlreadySettled(uint256 decisionId);
    error ChallengeWindowClosed(uint256 decisionId);
    error ChallengeWindowStillOpen(uint256 decisionId);
    error NotChallengeable(uint256 decisionId);
    error ZeroAddress();
    error ZeroHash();
    error ContractsAlreadySet();
    error InvalidSignatureLength();
    error EnclaveKeyAlreadyRegistered(address key);
    error EnclaveKeyNotRegistered(address key);

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice Enclave public keys verified off-chain via Intel DCAP.
    mapping(address => bool) public registeredEnclaveKeys;

    /// @notice Tracks settled decisions to prevent double-settlement.
    /// vault -> decisionId -> settled
    mapping(address => mapping(uint256 => bool)) public settled;

    PolicyRegistry public registry;
    VelaVault public vault; // single-vault MVP; multi-vault in production

    bool private _contractsSet;

    // ─── Events ───────────────────────────────────────────────────────────────

    event EnclaveKeyRegistered(address indexed key, address indexed registeredBy);
    event EnclaveKeyRevoked(address indexed key, address indexed revokedBy);
    event DecisionSettled(
        address indexed vaultAddr, uint256 indexed decisionId, address indexed enclaveKey, bytes32 contentHash
    );
    event TimeoutChallengeAccepted(address indexed vaultAddr, uint256 indexed decisionId);
    event TamperChallengeAccepted(
        address indexed vaultAddr, uint256 indexed decisionId, bytes32 committedHash, bytes32 providedHash
    );

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Wire sibling contracts. Can only be called once.
    function setContracts(address registry_, address vault_) external onlyOwner {
        if (_contractsSet) revert ContractsAlreadySet();
        if (registry_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        registry = PolicyRegistry(registry_);
        vault = VelaVault(vault_);
        _contractsSet = true;
    }

    /// @notice Register a 0G Sealed Inference enclave public key.
    ///         Call this after verifying the TDX attestation report off-chain via DCAP.
    ///         The enclave key is an ECDSA secp256k1 key generated inside the enclave.
    function registerEnclaveKey(address enclaveKey) external onlyOwner {
        if (enclaveKey == address(0)) revert ZeroAddress();
        if (registeredEnclaveKeys[enclaveKey]) revert EnclaveKeyAlreadyRegistered(enclaveKey);
        registeredEnclaveKeys[enclaveKey] = true;
        emit EnclaveKeyRegistered(enclaveKey, msg.sender);
    }

    /// @notice Revoke a compromised or rotated enclave key.
    function revokeEnclaveKey(address enclaveKey) external onlyOwner {
        if (!registeredEnclaveKeys[enclaveKey]) revert EnclaveKeyNotRegistered(enclaveKey);
        registeredEnclaveKeys[enclaveKey] = false;
        emit EnclaveKeyRevoked(enclaveKey, msg.sender);
    }

    // ─── Core: Settlement ─────────────────────────────────────────────────────

    /// @notice Settle a decision with a 0G enclave signature.
    ///
    /// @param  vaultAddr    Address of the VelaVault that committed this decision.
    /// @param  decisionId   Decision index in VelaVault.decisions mapping.
    /// @param  contentHash  keccak256 of the full decision JSON stored on 0G DA.
    ///                      Must match the decisionHash committed in VelaVault.
    /// @param  sig          ECDSA signature from the 0G enclave key over contentHash.
    ///                      Enclave signs: keccak256("\x19Ethereum Signed Message:\n32" || contentHash)
    function settle(address vaultAddr, uint256 decisionId, bytes32 contentHash, bytes calldata sig)
        external
        nonReentrant
    {
        // ── Input validation ─────────────────────────────────────────────────
        if (vaultAddr == address(0)) revert ZeroAddress();
        if (contentHash == bytes32(0)) revert ZeroHash();
        if (sig.length != 65) revert InvalidSignatureLength();

        // ── Fetch committed decision ─────────────────────────────────────────
        VelaVault vaultContract = VelaVault(vaultAddr);
        VelaVault.DecisionRecord memory d = vaultContract.getDecision(decisionId);

        // ── State checks ─────────────────────────────────────────────────────
        if (settled[vaultAddr][decisionId]) revert AlreadySettled(decisionId);
        if (block.timestamp > d.challengeDeadline) revert ChallengeWindowClosed(decisionId);

        // ── Binding check: contentHash must match committed decisionHash ─────
        // The agent commits keccak256(decision JSON) as decisionHash when calling
        // commitDecision(). The same JSON is uploaded to 0G DA. The enclave signs
        // the same hash. These three must be identical.
        if (contentHash != d.decisionHash) {
            revert HashMismatch(d.decisionHash, contentHash);
        }

        // ── Enclave signature verification ───────────────────────────────────
        // The 0G enclave signs the Ethereum prefixed hash so that standard
        // tools (ethers.js, cast) can produce and verify signatures.
        bytes32 ethSignedHash = contentHash.toEthSignedMessageHash();
        address recovered = ethSignedHash.recover(sig);

        if (!registeredEnclaveKeys[recovered]) {
            revert UnregisteredEnclave(recovered);
        }

        // ── Effects ──────────────────────────────────────────────────────────
        settled[vaultAddr][decisionId] = true;

        bytes32 attestationHash = keccak256(abi.encodePacked(recovered, contentHash));
        vaultContract.markAttested(decisionId, attestationHash);
        registry.recordDecision(vaultContract.agent(), true);

        emit DecisionSettled(vaultAddr, decisionId, recovered, contentHash);
    }

    // ─── Challenges ───────────────────────────────────────────────────────────

    /// @notice Submit a timeout challenge: the 24hr window passed with no settlement.
    ///         Anyone can call this. Triggers circuit breaker on the agent.
    /// @param  vaultAddr   Address of the VelaVault.
    /// @param  decisionId  Decision index.
    function challengeTimeout(address vaultAddr, uint256 decisionId) external nonReentrant {
        VelaVault vaultContract = VelaVault(vaultAddr);
        VelaVault.DecisionRecord memory d = vaultContract.getDecision(decisionId);

        if (settled[vaultAddr][decisionId]) revert AlreadySettled(decisionId);
        if (block.timestamp <= d.challengeDeadline) revert ChallengeWindowStillOpen(decisionId);
        if (d.status != VelaVault.AttestationStatus.Pending) revert NotChallengeable(decisionId);

        settled[vaultAddr][decisionId] = true;

        emit TimeoutChallengeAccepted(vaultAddr, decisionId);

        vaultContract.markChallenged(decisionId);
        registry.recordDecision(vaultContract.agent(), false);
        registry.triggerCircuitBreaker(vaultContract.agent());
    }

    /// @notice Submit a tamper challenge: the provided contentHash does not match
    ///         the committed decisionHash. Proves the agent submitted an altered record.
    ///         Anyone can call this with a valid mismatch. Triggers circuit breaker.
    ///
    /// @param  vaultAddr      Address of the VelaVault.
    /// @param  decisionId     Decision index.
    /// @param  fetchedHash    keccak256 of the actual 0G DA record (what's in storage).
    ///                        Must differ from committed decisionHash to succeed.
    function challengeTamperedRecord(address vaultAddr, uint256 decisionId, bytes32 fetchedHash) external nonReentrant {
        VelaVault vaultContract = VelaVault(vaultAddr);
        VelaVault.DecisionRecord memory d = vaultContract.getDecision(decisionId);

        if (settled[vaultAddr][decisionId]) revert AlreadySettled(decisionId);
        if (d.status != VelaVault.AttestationStatus.Pending) revert NotChallengeable(decisionId);
        if (fetchedHash == bytes32(0)) revert ZeroHash();

        // fetchedHash must genuinely differ from what was committed on-chain
        if (fetchedHash == d.decisionHash) revert HashMismatch(d.decisionHash, fetchedHash);

        settled[vaultAddr][decisionId] = true;

        emit TamperChallengeAccepted(vaultAddr, decisionId, d.decisionHash, fetchedHash);

        vaultContract.markChallenged(decisionId);
        registry.recordDecision(vaultContract.agent(), false);
        registry.triggerCircuitBreaker(vaultContract.agent());
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Returns true if the given address is a registered enclave key.
    function isRegisteredEnclave(address key) external view returns (bool) {
        return registeredEnclaveKeys[key];
    }

    /// @notice Returns true if the decision has been settled (attested or challenged).
    function isSettled(address vaultAddr, uint256 decisionId) external view returns (bool) {
        return settled[vaultAddr][decisionId];
    }
}
