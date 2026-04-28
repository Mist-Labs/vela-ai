// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2}      from "forge-std/Test.sol";
import {ERC20}               from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils}    from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SettlementContract}  from "../src/SettlementContract.sol";
import {PolicyRegistry}      from "../src/PolicyRegistry.sol";
import {VelaVault}           from "../src/VelaVault.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

contract SettlementContractTest is Test {
    using MessageHashUtils for bytes32;

    SettlementContract public settlement;
    PolicyRegistry     public registry;
    VelaVault          public vault;
    MockERC20          public asset;

    address public owner     = makeAddr("owner");
    address public treasury  = makeAddr("treasury");
    address public agentAddr = makeAddr("agent");
    address public challenger = makeAddr("challenger");
    address public stranger   = makeAddr("stranger");

    // Enclave key: derived from a known private key so we can produce valid sigs
    uint256 constant ENCLAVE_PRIVKEY = 0xA1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2;
    address public  enclaveKey;

    bytes32 constant POLICY_ROOT   = keccak256("policy-root");
    string  constant POLICY_URI    = "0g://policy";
    bytes32 constant DECISION_HASH = keccak256("decision-json-content");
    string  constant EXPLANATION   = "Swap 2000 USDC for WETH — detected 7.1% APY";
    string  constant EVIDENCE_CID  = "0g://evidence-cid-abc";

    function setUp() public {
        enclaveKey = vm.addr(ENCLAVE_PRIVKEY);

        asset      = new MockERC20();
        registry   = new PolicyRegistry(owner);
        settlement = new SettlementContract(owner);
        vault      = new VelaVault(asset, agentAddr, address(registry), address(settlement));

        // Wire contracts
        vm.prank(owner);
        registry.setContracts(address(settlement), treasury);

        vm.prank(owner);
        settlement.setContracts(address(registry), address(vault));

        // Register enclave key
        vm.prank(owner);
        settlement.registerEnclaveKey(enclaveKey);

        // Register agent
        vm.deal(agentAddr, 1 ether);
        vm.prank(agentAddr);
        registry.registerAgent{value: 0.05 ether}(POLICY_ROOT, POLICY_URI, 0);
    }

    // ─── Helper ───────────────────────────────────────────────────────────────

    /// @dev Sign contentHash with the enclave private key using Ethereum prefix
    function _sign(bytes32 contentHash) internal pure returns (bytes memory sig) {
        bytes32 ethHash = contentHash.toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ENCLAVE_PRIVKEY, ethHash);
        sig = abi.encodePacked(r, s, v);
    }

    function _commitDecision() internal returns (uint256 decisionId) {
        vm.prank(agentAddr);
        decisionId = vault.commitDecision(DECISION_HASH, EXPLANATION, EVIDENCE_CID);
    }

    // ─── registerEnclaveKey ───────────────────────────────────────────────────

    function test_registerEnclaveKey_setsKey() public view {
        assertTrue(settlement.isRegisteredEnclave(enclaveKey));
    }

    function test_registerEnclaveKey_emitsEvent() public {
        address newKey = makeAddr("newKey");
        vm.expectEmit(true, true, false, false);
        emit SettlementContract.EnclaveKeyRegistered(newKey, owner);
        vm.prank(owner);
        settlement.registerEnclaveKey(newKey);
    }

    function test_registerEnclaveKey_revert_duplicate() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementContract.EnclaveKeyAlreadyRegistered.selector,
                enclaveKey
            )
        );
        settlement.registerEnclaveKey(enclaveKey);
    }

    function test_registerEnclaveKey_revert_zeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(SettlementContract.ZeroAddress.selector);
        settlement.registerEnclaveKey(address(0));
    }

    function test_registerEnclaveKey_revert_nonOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        settlement.registerEnclaveKey(makeAddr("k"));
    }

    // ─── revokeEnclaveKey ─────────────────────────────────────────────────────

    function test_revokeEnclaveKey() public {
        vm.prank(owner);
        settlement.revokeEnclaveKey(enclaveKey);
        assertFalse(settlement.isRegisteredEnclave(enclaveKey));
    }

    function test_revokeEnclaveKey_revert_notRegistered() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementContract.EnclaveKeyNotRegistered.selector,
                stranger
            )
        );
        settlement.revokeEnclaveKey(stranger);
    }

    // ─── settle() ─────────────────────────────────────────────────────────────

    function test_settle_validEnclaveSignature() public {
        uint256 id = _commitDecision();
        bytes memory sig = _sign(DECISION_HASH);

        vm.prank(stranger); // anyone can call settle
        settlement.settle(address(vault), id, DECISION_HASH, sig);

        // Decision is attested
        VelaVault.DecisionRecord memory d = vault.getDecision(id);
        assertEq(uint8(d.status), uint8(VelaVault.AttestationStatus.Attested));

        // Compliance score updated (1 compliant decision: score = 1000)
        assertEq(registry.getPolicy(agentAddr).complianceScore, 1000);

        // Marked as settled
        assertTrue(settlement.isSettled(address(vault), id));
    }

    function test_settle_emitsEvent() public {
        uint256 id  = _commitDecision();
        bytes memory sig = _sign(DECISION_HASH);

        vm.expectEmit(true, true, true, false);
        emit SettlementContract.DecisionSettled(address(vault), id, enclaveKey, DECISION_HASH);
        settlement.settle(address(vault), id, DECISION_HASH, sig);
    }

    function test_settle_revert_unregisteredEnclave() public {
        uint256 id = _commitDecision();

        // Sign with a random private key (not the registered enclave)
        uint256 randomKey = 0xDEADBEEF;
        bytes32 ethHash   = DECISION_HASH.toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(randomKey, ethHash);
        bytes memory badSig = abi.encodePacked(r, s, v);

        address badSigner = vm.addr(randomKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementContract.UnregisteredEnclave.selector,
                badSigner
            )
        );
        settlement.settle(address(vault), id, DECISION_HASH, badSig);
    }

    function test_settle_revert_hashMismatch() public {
        uint256 id   = _commitDecision();
        bytes32 wrong = keccak256("wrong-hash");
        bytes memory sig = _sign(wrong);

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementContract.HashMismatch.selector,
                DECISION_HASH,
                wrong
            )
        );
        settlement.settle(address(vault), id, wrong, sig);
    }

    function test_settle_revert_alreadySettled() public {
        uint256 id  = _commitDecision();
        bytes memory sig = _sign(DECISION_HASH);
        settlement.settle(address(vault), id, DECISION_HASH, sig);

        vm.expectRevert(
            abi.encodeWithSelector(SettlementContract.AlreadySettled.selector, id)
        );
        settlement.settle(address(vault), id, DECISION_HASH, sig);
    }

    function test_settle_revert_windowClosed() public {
        uint256 id  = _commitDecision();
        vm.warp(block.timestamp + 25 hours);

        bytes memory sig = _sign(DECISION_HASH);
        vm.expectRevert(
            abi.encodeWithSelector(SettlementContract.ChallengeWindowClosed.selector, id)
        );
        settlement.settle(address(vault), id, DECISION_HASH, sig);
    }

    function test_settle_revert_zeroVaultAddress() public {
        bytes memory sig = _sign(DECISION_HASH);
        vm.expectRevert(SettlementContract.ZeroAddress.selector);
        settlement.settle(address(0), 0, DECISION_HASH, sig);
    }

    function test_settle_revert_zeroContentHash() public {
        uint256 id  = _commitDecision();
        bytes memory sig = _sign(bytes32(0));
        vm.expectRevert(SettlementContract.ZeroHash.selector);
        settlement.settle(address(vault), id, bytes32(0), sig);
    }

    function test_settle_revert_invalidSigLength() public {
        uint256 id = _commitDecision();
        vm.expectRevert(SettlementContract.InvalidSignatureLength.selector);
        settlement.settle(address(vault), id, DECISION_HASH, bytes("short"));
    }

    function test_settle_revert_revokedEnclaveKey() public {
        uint256 id  = _commitDecision();
        bytes memory sig = _sign(DECISION_HASH);

        // Revoke the key before settling
        vm.prank(owner);
        settlement.revokeEnclaveKey(enclaveKey);

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementContract.UnregisteredEnclave.selector,
                enclaveKey
            )
        );
        settlement.settle(address(vault), id, DECISION_HASH, sig);
    }

    // ─── challengeTimeout() ───────────────────────────────────────────────────

    function test_challengeTimeout_triggersCircuitBreaker() public {
        uint256 id = _commitDecision();

        // Fast-forward past window
        vm.warp(block.timestamp + 25 hours);

        vm.prank(challenger);
        settlement.challengeTimeout(address(vault), id);

        assertTrue(registry.circuitBreakerTriggered(agentAddr));
        assertTrue(settlement.isSettled(address(vault), id));

        VelaVault.DecisionRecord memory d = vault.getDecision(id);
        assertEq(uint8(d.status), uint8(VelaVault.AttestationStatus.Challenged));
    }

    function test_challengeTimeout_emitsEvent() public {
        uint256 id = _commitDecision();
        vm.warp(block.timestamp + 25 hours);

        vm.expectEmit(true, true, false, false);
        emit SettlementContract.TimeoutChallengeAccepted(address(vault), id);
        settlement.challengeTimeout(address(vault), id);
    }

    function test_challengeTimeout_revert_windowStillOpen() public {
        uint256 id = _commitDecision();
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementContract.ChallengeWindowStillOpen.selector,
                id
            )
        );
        settlement.challengeTimeout(address(vault), id);
    }

    function test_challengeTimeout_revert_alreadySettled() public {
        uint256 id  = _commitDecision();
        bytes memory sig = _sign(DECISION_HASH);
        settlement.settle(address(vault), id, DECISION_HASH, sig);

        vm.warp(block.timestamp + 25 hours);
        vm.expectRevert(
            abi.encodeWithSelector(SettlementContract.AlreadySettled.selector, id)
        );
        settlement.challengeTimeout(address(vault), id);
    }

    function test_challengeTimeout_permissionless() public {
        uint256 id = _commitDecision();
        vm.warp(block.timestamp + 25 hours);

        // Anyone can call
        address random = makeAddr("random");
        vm.prank(random);
        settlement.challengeTimeout(address(vault), id);
        assertTrue(registry.circuitBreakerTriggered(agentAddr));
    }

    // ─── challengeTamperedRecord() ────────────────────────────────────────────

    function test_challengeTamperedRecord_succeeds() public {
        uint256 id = _commitDecision();

        bytes32 alteredHash = keccak256("altered-json-content");
        vm.prank(challenger);
        settlement.challengeTamperedRecord(address(vault), id, alteredHash);

        assertTrue(registry.circuitBreakerTriggered(agentAddr));
        assertTrue(settlement.isSettled(address(vault), id));

        VelaVault.DecisionRecord memory d = vault.getDecision(id);
        assertEq(uint8(d.status), uint8(VelaVault.AttestationStatus.Challenged));
    }

    function test_challengeTamperedRecord_emitsEvent() public {
        uint256 id = _commitDecision();
        bytes32 alteredHash = keccak256("altered");

        vm.expectEmit(true, true, false, true);
        emit SettlementContract.TamperChallengeAccepted(
            address(vault), id, DECISION_HASH, alteredHash
        );
        settlement.challengeTamperedRecord(address(vault), id, alteredHash);
    }

    function test_challengeTamperedRecord_revert_matchingHash() public {
        uint256 id = _commitDecision();

        // Providing the SAME hash as committed should revert
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementContract.HashMismatch.selector,
                DECISION_HASH,
                DECISION_HASH
            )
        );
        settlement.challengeTamperedRecord(address(vault), id, DECISION_HASH);
    }

    function test_challengeTamperedRecord_revert_zeroHash() public {
        uint256 id = _commitDecision();
        vm.expectRevert(SettlementContract.ZeroHash.selector);
        settlement.challengeTamperedRecord(address(vault), id, bytes32(0));
    }

    function test_challengeTamperedRecord_revert_alreadySettled() public {
        uint256 id  = _commitDecision();
        bytes memory sig = _sign(DECISION_HASH);
        settlement.settle(address(vault), id, DECISION_HASH, sig);

        vm.expectRevert(
            abi.encodeWithSelector(SettlementContract.AlreadySettled.selector, id)
        );
        settlement.challengeTamperedRecord(address(vault), id, keccak256("altered"));
    }

    // ─── setContracts ─────────────────────────────────────────────────────────

    function test_setContracts_revert_alreadySet() public {
        vm.prank(owner);
        vm.expectRevert(SettlementContract.ContractsAlreadySet.selector);
        settlement.setContracts(address(registry), address(vault));
    }

    function test_setContracts_revert_zeroRegistry() public {
        SettlementContract fresh = new SettlementContract(owner);
        vm.prank(owner);
        vm.expectRevert(SettlementContract.ZeroAddress.selector);
        fresh.setContracts(address(0), address(vault));
    }

    // ─── Multi-decision compliance scoring ────────────────────────────────────

    function test_settle_multipleDecisions_scoreTracking() public {
        // 3 compliant settlements
        for (uint256 i = 0; i < 3; i++) {
            bytes32 hash = keccak256(abi.encode("decision", i));
            vm.prank(agentAddr);
            uint256 id = vault.commitDecision(hash, EXPLANATION, EVIDENCE_CID);
            bytes memory sig = _sign(hash);
            settlement.settle(address(vault), id, hash, sig);
        }

        PolicyRegistry.PolicyCommitment memory p = registry.getPolicy(agentAddr);
        assertEq(p.totalDecisions, 3);
        assertEq(p.compliantDecisions, 3);
        assertEq(p.complianceScore, 1000);
    }

    function test_settle_mixedOutcomes_correctScore() public {
        // 2 compliant, 1 timeout
        for (uint256 i = 0; i < 2; i++) {
            bytes32 hash = keccak256(abi.encode("ok", i));
            vm.prank(agentAddr);
            uint256 id = vault.commitDecision(hash, EXPLANATION, EVIDENCE_CID);
            bytes memory sig = _sign(hash);
            settlement.settle(address(vault), id, hash, sig);
        }

        // 1 timeout
        bytes32 badHash = keccak256("timeout-decision");
        vm.prank(agentAddr);
        uint256 badId = vault.commitDecision(badHash, EXPLANATION, EVIDENCE_CID);
        vm.warp(block.timestamp + 25 hours);
        settlement.challengeTimeout(address(vault), badId);

        PolicyRegistry.PolicyCommitment memory p = registry.getPolicy(agentAddr);
        assertEq(p.totalDecisions, 3);
        assertEq(p.compliantDecisions, 2);
        assertEq(p.complianceScore, (2 * 1000) / 3); // 666
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    function testFuzz_settle_anyValidHash(bytes32 decisionHash) public {
        vm.assume(decisionHash != bytes32(0));

        vm.prank(agentAddr);
        uint256 id = vault.commitDecision(decisionHash, EXPLANATION, EVIDENCE_CID);

        bytes memory sig = _sign(decisionHash);
        settlement.settle(address(vault), id, decisionHash, sig);

        assertTrue(settlement.isSettled(address(vault), id));
    }
}
