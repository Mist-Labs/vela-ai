// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {SlashingModule}  from "../src/SlashingModule.sol";
import {PolicyRegistry}  from "../src/PolicyRegistry.sol";

/// @dev Minimal ETH receiver for testing
contract ETHReceiver {
    uint256 public received;
    receive() external payable { received += msg.value; }
}

contract SlashingModuleTest is Test {

    PolicyRegistry public registry;
    SlashingModule public slashing;

    address public owner      = makeAddr("owner");
    address public settlement = makeAddr("settlement");
    address public treasury;
    address public challenger = makeAddr("challenger");
    address public operator   = makeAddr("operator");
    address public stranger   = makeAddr("stranger");

    bytes32 constant POLICY_ROOT   = keccak256("policy-root");
    string  constant POLICY_URI    = "0g://abc";
    bytes32 constant DECISION_HASH = keccak256("violating-decision");

    function setUp() public {
        treasury = address(new ETHReceiver());
        registry = new PolicyRegistry(owner);
        slashing = new SlashingModule(address(registry), treasury, owner);

        vm.prank(owner);
        registry.setContracts(settlement, address(slashing));

        // Fund and register the operator/agent
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        registry.registerAgent{value: 0.05 ether}(POLICY_ROOT, POLICY_URI, 0);
    }

    // ─── Helper ───────────────────────────────────────────────────────────────

    function _buildProof(
        bytes32 decisionHash,
        bytes32 policyRoot
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(decisionHash, policyRoot);
    }

    // ─── slash() ──────────────────────────────────────────────────────────────

    function test_slash_distributesCorrectly() public {
        uint256 bond         = 0.05 ether;
        uint256 expectedChallenger = (bond * 8_000) / 10_000; // 0.04 ETH
        uint256 expectedTreasury   = bond - expectedChallenger; // 0.01 ETH

        bytes memory proof = _buildProof(DECISION_HASH, POLICY_ROOT);

        uint256 challengerBefore = challenger.balance;
        uint256 treasuryBefore   = treasury.balance;

        vm.prank(challenger);
        slashing.slash(operator, proof);

        assertEq(challenger.balance - challengerBefore, expectedChallenger);
        assertEq(treasury.balance - treasuryBefore,     expectedTreasury);
    }

    function test_slash_deactivatesAgent() public {
        bytes memory proof = _buildProof(DECISION_HASH, POLICY_ROOT);
        vm.prank(challenger);
        slashing.slash(operator, proof);

        assertFalse(registry.getPolicy(operator).active);
        assertEq(registry.getPolicy(operator).bondAmount, 0);
    }

    function test_slash_marksAgentSlashed() public {
        bytes memory proof = _buildProof(DECISION_HASH, POLICY_ROOT);
        vm.prank(challenger);
        slashing.slash(operator, proof);
        assertTrue(slashing.slashed(operator));
    }

    function test_slash_emitsEvent() public {
        bytes memory proof = _buildProof(DECISION_HASH, POLICY_ROOT);
        uint256 bond = 0.05 ether;
        uint256 challengerReward = (bond * 8_000) / 10_000;
        uint256 treasuryCut = bond - challengerReward;

        vm.expectEmit(true, true, false, true);
        emit SlashingModule.Slashed(
            operator,
            challenger,
            bond,
            challengerReward,
            treasuryCut,
            DECISION_HASH
        );

        vm.prank(challenger);
        slashing.slash(operator, proof);
    }

    function test_slash_revert_agentNotActive() public {
        // First slash deactivates
        bytes memory proof = _buildProof(DECISION_HASH, POLICY_ROOT);
        vm.prank(challenger);
        slashing.slash(operator, proof);

        // Register a new agent and try to slash the deactivated one
        address newOp = makeAddr("newOp");
        vm.deal(newOp, 1 ether);
        vm.prank(newOp);
        registry.registerAgent{value: 0.05 ether}(POLICY_ROOT, POLICY_URI, 0);

        // Slash on original operator — already slashed flag
        vm.prank(challenger);
        vm.expectRevert(
            abi.encodeWithSelector(SlashingModule.AlreadySlashed.selector, operator)
        );
        slashing.slash(operator, proof);
    }

    function test_slash_revert_agentNeverRegistered() public {
        bytes memory proof = _buildProof(DECISION_HASH, POLICY_ROOT);
        vm.prank(challenger);
        vm.expectRevert(
            abi.encodeWithSelector(SlashingModule.AgentNotActive.selector, stranger)
        );
        slashing.slash(stranger, proof);
    }

    function test_slash_revert_proofTooShort() public {
        vm.prank(challenger);
        vm.expectRevert(SlashingModule.InvalidProof.selector);
        slashing.slash(operator, bytes("short"));
    }

    function test_slash_revert_wrongPolicyRoot() public {
        bytes32 wrongRoot = keccak256("wrong-root");
        bytes memory proof = _buildProof(DECISION_HASH, wrongRoot);
        vm.prank(challenger);
        vm.expectRevert(SlashingModule.InvalidProof.selector);
        slashing.slash(operator, proof);
    }

    function test_slash_revert_zeroDecisionHash() public {
        bytes memory proof = _buildProof(bytes32(0), POLICY_ROOT);
        vm.prank(challenger);
        vm.expectRevert(SlashingModule.InvalidProof.selector);
        slashing.slash(operator, proof);
    }

    function test_slash_anyoneCanChallenge() public {
        // Permissionless — any address can slash
        address random = makeAddr("random");
        bytes memory proof = _buildProof(DECISION_HASH, POLICY_ROOT);
        vm.prank(random);
        slashing.slash(operator, proof);
        assertTrue(slashing.slashed(operator));
    }

    function test_slash_largerBond_correctSplit() public {
        // Register PRO tier agent with 1 ETH bond
        address proAgent = makeAddr("proAgent");
        vm.deal(proAgent, 2 ether);
        vm.prank(proAgent);
        registry.registerAgent{value: 1 ether}(POLICY_ROOT, POLICY_URI, 2);

        uint256 bond             = 1 ether;
        uint256 expectedChall    = (bond * 8_000) / 10_000; // 0.8 ETH
        uint256 expectedTreasury = bond - expectedChall;     // 0.2 ETH

        bytes memory proof = _buildProof(DECISION_HASH, POLICY_ROOT);
        uint256 challBefore = challenger.balance;
        uint256 tresBefore  = treasury.balance;

        vm.prank(challenger);
        slashing.slash(proAgent, proof);

        assertEq(challenger.balance - challBefore, expectedChall);
        assertEq(treasury.balance - tresBefore,    expectedTreasury);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function test_setTreasury() public {
        address newTreasury = makeAddr("newTreasury");
        vm.prank(owner);
        slashing.setTreasury(newTreasury);
        assertEq(slashing.treasury(), newTreasury);
    }

    function test_setTreasury_emitsEvent() public {
        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(true, true, false, false);
        emit SlashingModule.TreasuryUpdated(treasury, newTreasury);
        vm.prank(owner);
        slashing.setTreasury(newTreasury);
    }

    function test_setTreasury_revert_zeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(SlashingModule.ZeroAddress.selector);
        slashing.setTreasury(address(0));
    }

    function test_setTreasury_revert_nonOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        slashing.setTreasury(makeAddr("new"));
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    function testFuzz_slash_split_always_sums_to_bond(uint256 bondExtra) public {
        bondExtra = bound(bondExtra, 0, 10 ether);
        uint256 bond = 0.05 ether + bondExtra;

        address richAgent = makeAddr("richAgent");
        vm.deal(richAgent, bond + 1 ether);
        vm.prank(richAgent);
        registry.registerAgent{value: bond}(POLICY_ROOT, POLICY_URI, 0);

        uint256 challBefore = challenger.balance;
        uint256 tresBefore  = treasury.balance;

        bytes memory proof = _buildProof(DECISION_HASH, POLICY_ROOT);
        vm.prank(challenger);
        slashing.slash(richAgent, proof);

        uint256 challGot    = challenger.balance - challBefore;
        uint256 treasuryGot = treasury.balance   - tresBefore;
        assertEq(challGot + treasuryGot, bond);
    }
}
