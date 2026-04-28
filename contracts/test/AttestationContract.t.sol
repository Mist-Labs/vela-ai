// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AttestationContract.sol";

// ─────────────────────────────── mocks ───────────────────────────────────────

contract MockVault {
    mapping(uint256 => bytes32) private _hashes;
    mapping(uint256 => bool) private _attested;
    address public agent = address(0xBEEF);

    function setDecisionHash(uint256 id, bytes32 h) external {
        _hashes[id] = h;
    }

    function getDecisionHash(uint256 id) external view returns (bytes32) {
        return _hashes[id];
    }

    function markAttested(uint256 id, bytes32) external {
        _attested[id] = true;
    }

    function isAttested(uint256 id) external view returns (bool) {
        return _attested[id];
    }
}

contract MockRegistry {
    bool public circuitBroken;
    uint256 public validAttestations;
    uint256 public invalidAttestations;

    function recordAttestation(address, bool valid) external {
        if (valid) validAttestations++;
        else invalidAttestations++;
    }

    function triggerCircuitBreaker(address) external {
        circuitBroken = true;
    }
}

// ─────────────────────────────── test suite ──────────────────────────────────

contract AttestationContractTest is Test {
    AttestationContract internal ac;
    MockVault internal vault;
    MockRegistry internal registry;

    // Simulated 0G enclave key - generated deterministically for tests.
    uint256 internal constant ENCLAVE_PRIVKEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal enclaveAddr;

    uint256 internal constant UNREGISTERED_PRIVKEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    address internal unregisteredAddr;

    address internal constant AGENT = address(0xBEEF);
    uint256 internal constant DECISION_ID = 1;

    function setUp() public {
        vault = new MockVault();
        registry = new MockRegistry();
        ac = new AttestationContract(address(registry));

        enclaveAddr = vm.addr(ENCLAVE_PRIVKEY);
        unregisteredAddr = vm.addr(UNREGISTERED_PRIVKEY);

        // Register the simulated enclave key.
        ac.registerEnclaveKey(enclaveAddr);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    /**
     * @dev Sign contentHash with the given private key.
     *      The enclave signs the raw keccak256 - NOT the Ethereum
     *      personal_sign prefixed hash.
     */
    function _sign(uint256 privKey, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privKey, hash);
        return abi.encodePacked(r, s, v);
    }

    function _setupDecision(bytes32 contentHash) internal {
        vault.setDecisionHash(DECISION_ID, contentHash);
    }

    // ── test: valid enclave signature settles successfully ────────────────────

    function test_verifyAndSettle_validSignature() public {
        bytes32 contentHash = keccak256("decision-record-json-cid-42");
        _setupDecision(contentHash);

        bytes memory sig = _sign(ENCLAVE_PRIVKEY, contentHash);

        vm.expectEmit(true, true, true, true);
        emit AttestationContract.DecisionSettled(address(vault), DECISION_ID, enclaveAddr, contentHash);

        ac.verifyAndSettle(address(vault), DECISION_ID, contentHash, sig);

        // Vault marked attested.
        assertTrue(vault.isAttested(DECISION_ID));
        // Registry received a valid attestation.
        assertEq(registry.validAttestations(), 1);
        assertEq(registry.invalidAttestations(), 0);
        // Settled flag set.
        assertTrue(ac.isSettled(address(vault), DECISION_ID));
        // Circuit breaker not triggered.
        assertFalse(registry.circuitBroken());
    }

    // ── test: unregistered signer reverts ─────────────────────────────────────

    function test_verifyAndSettle_unregisteredSigner_reverts() public {
        bytes32 contentHash = keccak256("decision-record-json-cid-43");
        _setupDecision(contentHash);

        // Sign with a key that is NOT registered.
        bytes memory sig = _sign(UNREGISTERED_PRIVKEY, contentHash);

        vm.expectRevert(abi.encodeWithSelector(AttestationContract.UnregisteredEnclave.selector, unregisteredAddr));
        ac.verifyAndSettle(address(vault), DECISION_ID, contentHash, sig);

        // Nothing should have changed.
        assertFalse(vault.isAttested(DECISION_ID));
        assertFalse(ac.isSettled(address(vault), DECISION_ID));
        assertFalse(registry.circuitBroken());
    }

    // ── test: contentHash mismatch reverts ────────────────────────────────────

    function test_verifyAndSettle_hashMismatch_reverts() public {
        bytes32 committedHash = keccak256("original-decision-record");
        bytes32 tamperedHash = keccak256("tampered-decision-record");

        // Vault stores the original hash.
        _setupDecision(committedHash);

        // Enclave signs the tampered hash (attacker submits different content).
        bytes memory sig = _sign(ENCLAVE_PRIVKEY, tamperedHash);

        vm.expectRevert(abi.encodeWithSelector(AttestationContract.HashMismatch.selector, committedHash, tamperedHash));
        ac.verifyAndSettle(address(vault), DECISION_ID, tamperedHash, sig);

        assertFalse(vault.isAttested(DECISION_ID));
        assertFalse(ac.isSettled(address(vault), DECISION_ID));
    }

    // ── test: cannot settle the same decision twice ───────────────────────────

    function test_verifyAndSettle_alreadySettled_reverts() public {
        bytes32 contentHash = keccak256("decision-record-json-cid-44");
        _setupDecision(contentHash);
        bytes memory sig = _sign(ENCLAVE_PRIVKEY, contentHash);

        // First call succeeds.
        ac.verifyAndSettle(address(vault), DECISION_ID, contentHash, sig);

        // Second call must revert.
        vm.expectRevert(
            abi.encodeWithSelector(AttestationContract.AlreadySettled.selector, address(vault), DECISION_ID)
        );
        ac.verifyAndSettle(address(vault), DECISION_ID, contentHash, sig);
    }

    // ── test: reportFailure triggers circuit breaker ──────────────────────────

    function test_reportFailure_triggersCircuitBreaker() public {
        assertFalse(registry.circuitBroken());
        assertEq(registry.invalidAttestations(), 0);

        vm.expectEmit(true, true, false, true);
        emit AttestationContract.AttestationFailure(address(vault), DECISION_ID, "TEE signature mismatch");

        ac.reportFailure(address(vault), DECISION_ID, "TEE signature mismatch");

        assertTrue(registry.circuitBroken());
        assertEq(registry.invalidAttestations(), 1);
    }

    // ── test: admin key management ────────────────────────────────────────────

    function test_registerEnclaveKey() public {
        address newKey = address(0x1234);
        assertFalse(ac.isRegisteredEnclave(newKey));

        ac.registerEnclaveKey(newKey);
        assertTrue(ac.isRegisteredEnclave(newKey));
    }

    function test_revokeEnclaveKey() public {
        assertTrue(ac.isRegisteredEnclave(enclaveAddr));

        ac.revokeEnclaveKey(enclaveAddr);
        assertFalse(ac.isRegisteredEnclave(enclaveAddr));
    }

    function test_registerEnclaveKey_zeroAddress_reverts() public {
        vm.expectRevert(AttestationContract.ZeroAddress.selector);
        ac.registerEnclaveKey(address(0));
    }

    function test_onlyOwner_canRegisterKey() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        ac.registerEnclaveKey(address(0x9999));
    }

    // ── test: revoked key can no longer settle ────────────────────────────────

    function test_revokedKey_cannotSettle() public {
        bytes32 contentHash = keccak256("decision-record-json-cid-45");
        _setupDecision(contentHash);
        bytes memory sig = _sign(ENCLAVE_PRIVKEY, contentHash);

        // Revoke before settling.
        ac.revokeEnclaveKey(enclaveAddr);

        vm.expectRevert(abi.encodeWithSelector(AttestationContract.UnregisteredEnclave.selector, enclaveAddr));
        ac.verifyAndSettle(address(vault), DECISION_ID, contentHash, sig);
    }

    // ── test: zero address registry reverts in constructor ───────────────────

    function test_constructor_zeroRegistry_reverts() public {
        vm.expectRevert(AttestationContract.ZeroAddress.selector);
        new AttestationContract(address(0));
    }
}
