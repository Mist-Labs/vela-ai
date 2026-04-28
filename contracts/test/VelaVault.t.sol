// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {VelaVault} from "../src/VelaVault.sol";
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

contract VelaVaultTest is Test {
    MockERC20 public asset;
    PolicyRegistry public registry;
    VelaVault public vault;

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

    function setUp() public {
        asset = new MockERC20();
        registry = new PolicyRegistry(owner);

        vault = new VelaVault(asset, agentAddr, address(registry), attestation);

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
}
