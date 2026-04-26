// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2}  from "forge-std/Test.sol";
import {ERC20}           from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PolicyRegistry}  from "../src/PolicyRegistry.sol";
import {VelaVault}       from "../src/VelaVault.sol";
import {SlashingModule}  from "../src/SlashingModule.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

/// @title  IntegrationTest
/// @notice Exercises the full Vela happy path and violation path end-to-end.
contract IntegrationTest is Test {

    MockERC20      asset;
    PolicyRegistry registry;
    VelaVault      vault;
    SlashingModule slashingModule;

    address owner      = makeAddr("owner");
    address treasury   = makeAddr("treasury");
    address agent      = makeAddr("agent");
    address settlement = makeAddr("settlement");
    address user1      = makeAddr("user1");
    address challenger = makeAddr("challenger");

    bytes32 POLICY_ROOT   = keccak256("real-policy-root");
    string  POLICY_URI    = "0g://policy-cid-abc";
    bytes32 DECISION_HASH = keccak256("decision-0");

    function setUp() public {
        asset  = new MockERC20();

        // Deploy all contracts
        registry       = new PolicyRegistry(owner);
        slashingModule = new SlashingModule(address(registry), treasury, owner);
        vault          = new VelaVault(asset, agent, address(registry), settlement);

        // Wire contracts
        vm.prank(owner);
        registry.setContracts(settlement, address(slashingModule));

        // Fund agent and register
        vm.deal(agent, 1 ether);
        vm.prank(agent);
        registry.registerAgent{value: 0.2 ether}(POLICY_ROOT, POLICY_URI, 1); // STANDARD tier

        // Fund user
        asset.mint(user1, 100_000e6);
        vm.prank(user1);
        asset.approve(address(vault), type(uint256).max);
    }

    // ─── Happy Path ───────────────────────────────────────────────────────────

    /// @notice Full compliant decision lifecycle: deposit → commit → attest → record
    function test_integration_happyPath() public {
        // 1. User deposits
        vm.prank(user1);
        uint256 shares = vault.deposit(10_000e6, user1);
        assertGt(shares, 0);

        // 2. Agent commits a decision
        string memory explanation = "Swap 5000 USDC to WETH — detected 8.2% APY opportunity";
        string memory cid         = "0g://evidence-abc123";

        vm.prank(agent);
        uint256 decisionId = vault.commitDecision(DECISION_HASH, explanation, cid);
        assertEq(decisionId, 0);

        // 3. Settlement attests the decision
        bytes32 attestHash = keccak256("sp1-groth16-proof-hash");
        vm.prank(settlement);
        vault.markAttested(decisionId, attestHash);

        // 4. Registry records the decision as compliant
        vm.prank(settlement);
        registry.recordDecision(agent, true);

        // 5. Verify final state
        VelaVault.DecisionRecord memory d = vault.getDecision(decisionId);
        assertEq(uint8(d.status), uint8(VelaVault.AttestationStatus.Attested));
        assertEq(d.attestationHash, attestHash);

        PolicyRegistry.PolicyCommitment memory p = registry.getPolicy(agent);
        assertEq(p.complianceScore, 1000);
        assertEq(p.totalDecisions, 1);
        assertTrue(registry.isActive(agent));

        // 6. User can still withdraw
        vm.prank(user1);
        vault.redeem(shares, user1, user1);
    }

    // ─── Violation Path ───────────────────────────────────────────────────────

    /// @notice Full violation lifecycle: commit → watchtower detects → slash → vault locked
    function test_integration_violationPath() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);

        // Agent commits a decision
        vm.prank(agent);
        uint256 decisionId = vault.commitDecision(
            DECISION_HASH,
            "Attempting to swap 50000 USDC — exceeds policy limit",
            "0g://evidence-xyz"
        );

        // Watchtower detects violation, challenger submits slash
        bytes memory proof = abi.encodePacked(DECISION_HASH, POLICY_ROOT);

        uint256 challBefore    = challenger.balance;
        uint256 treasuryBefore = treasury.balance;
        uint256 bondAmount     = 0.2 ether;

        vm.prank(challenger);
        slashingModule.slash(agent, proof);

        // Challenger got 80%, treasury got 20%
        assertEq(challenger.balance - challBefore,    (bondAmount * 8_000) / 10_000);
        assertEq(treasury.balance   - treasuryBefore, (bondAmount * 2_000) / 10_000);

        // Agent is deactivated
        assertFalse(registry.getPolicy(agent).active);
        assertTrue(slashingModule.slashed(agent));

        // Vault deposits are blocked
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(VelaVault.CircuitBreakerActive.selector, agent)
        );
        vault.deposit(1_000e6, user1);

        // But withdrawals are permitted — users can always exit
        uint256 shares = vault.balanceOf(user1);
        vm.prank(user1);
        uint256 withdrawn = vault.redeem(shares, user1, user1);
        assertEq(withdrawn, 10_000e6);

        // Mark decision as challenged for record-keeping
        vm.prank(settlement);
        vault.markChallenged(decisionId);
        assertEq(
            uint8(vault.getDecision(decisionId).status),
            uint8(VelaVault.AttestationStatus.Challenged)
        );
    }

    // ─── Timeout Path ─────────────────────────────────────────────────────────

    /// @notice Attestation timeout: 24hr passes without attestation → circuit break
    function test_integration_timeoutPath() public {
        vm.prank(agent);
        vault.commitDecision(DECISION_HASH, "some decision", "0g://cid");

        // 24 hours pass — watchtower triggers timeout challenge
        vm.warp(block.timestamp + 25 hours);

        // Settlement triggers circuit breaker (timeout)
        vm.prank(settlement);
        registry.triggerCircuitBreaker(agent);

        assertTrue(registry.circuitBreakerTriggered(agent));
        assertFalse(registry.isActive(agent));

        // New deposits blocked
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(VelaVault.CircuitBreakerActive.selector, agent)
        );
        vault.deposit(1_000e6, user1);
    }

    // ─── Multiple Decisions ───────────────────────────────────────────────────

    function test_integration_multipleDecisions_scoreTracking() public {
        // 5 compliant, 2 non-compliant → score = 714
        for (uint i = 0; i < 5; i++) {
            vm.prank(agent);
            vault.commitDecision(keccak256(abi.encode(i)), "compliant", "0g://cid");
            vm.prank(settlement);
            registry.recordDecision(agent, true);
        }
        for (uint i = 5; i < 7; i++) {
            vm.prank(agent);
            vault.commitDecision(keccak256(abi.encode(i)), "violation", "0g://cid");
            vm.prank(settlement);
            registry.recordDecision(agent, false);
        }

        PolicyRegistry.PolicyCommitment memory p = registry.getPolicy(agent);
        assertEq(p.totalDecisions, 7);
        assertEq(p.compliantDecisions, 5);
        assertEq(p.complianceScore, (5 * 1000) / 7); // 714
        assertTrue(registry.isActive(agent)); // score still > 200
    }

    function test_integration_recentDecisions_view() public {
        vm.startPrank(agent);
        for (uint i = 0; i < 8; i++) {
            vault.commitDecision(
                keccak256(abi.encode(i)),
                "decision",
                "0g://cid"
            );
        }
        vm.stopPrank();

        VelaVault.DecisionRecord[] memory recent = vault.recentDecisions(5);
        assertEq(recent.length, 5);
        // Most recent first: id 7, 6, 5, 4, 3
        assertEq(recent[0].decisionHash, keccak256(abi.encode(uint256(7))));
        assertEq(recent[4].decisionHash, keccak256(abi.encode(uint256(3))));
    }
}
