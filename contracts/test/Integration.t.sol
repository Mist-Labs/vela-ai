// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {VelaVault} from "../src/VelaVault.sol";
import {AttestationContract} from "../src/AttestationContract.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @title  IntegrationTest
/// @notice Exercises the real-time Vela attestation and watchtower pause paths.
contract IntegrationTest is Test {
    MockERC20 asset;
    PolicyRegistry registry;
    VelaVault vault;
    AttestationContract attestation;

    uint256 internal constant ENCLAVE_PRIVKEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal enclaveKey;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address user1 = makeAddr("user1");

    bytes32 POLICY_ROOT = keccak256("real-policy-root");
    string POLICY_URI = "0g://policy-cid-abc";
    bytes32 DECISION_HASH = keccak256("decision-0");

    function setUp() public {
        asset = new MockERC20();
        registry = new PolicyRegistry(owner);
        attestation = new AttestationContract(address(registry));
        vault = new VelaVault(asset, agent, address(registry), address(attestation));

        enclaveKey = vm.addr(ENCLAVE_PRIVKEY);
        attestation.registerEnclaveKey(enclaveKey);

        vm.prank(owner);
        registry.setContracts(address(attestation));

        vm.prank(agent);
        registry.registerAgent(POLICY_ROOT, POLICY_URI, 1);

        asset.mint(user1, 100_000e6);
        vm.prank(user1);
        asset.approve(address(vault), type(uint256).max);
    }

    function _sign(bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ENCLAVE_PRIVKEY, hash);
        return abi.encodePacked(r, s, v);
    }

    // ─── Happy Path ───────────────────────────────────────────────────────────

    /// @notice Full compliant decision lifecycle: deposit → commit → TEE attest → record.
    function test_integration_happyPath() public {
        vm.prank(user1);
        uint256 shares = vault.deposit(10_000e6, user1);
        assertGt(shares, 0);

        string memory explanation = "Swap 5000 USDC to WETH - detected 8.2% APY opportunity";
        string memory cid = "0g://evidence-abc123";

        vm.prank(agent);
        uint256 decisionId = vault.commitDecision(DECISION_HASH, explanation, cid);
        assertEq(decisionId, 0);

        attestation.verifyAndSettle(address(vault), agent, decisionId, DECISION_HASH, _sign(DECISION_HASH));

        VelaVault.DecisionRecord memory d = vault.getDecision(decisionId);
        assertEq(uint8(d.status), uint8(VelaVault.AttestationStatus.Attested));
        assertEq(d.attestationHash, DECISION_HASH);

        PolicyRegistry.PolicyCommitment memory p = registry.getPolicy(agent);
        assertEq(p.complianceScore, 1000);
        assertEq(p.totalDecisions, 1);
        assertTrue(registry.isActive(agent));
        assertTrue(attestation.isSettled(address(vault), decisionId));

        vm.prank(user1);
        vault.redeem(shares, user1, user1);
    }

    // ─── Watchtower Pause Path ────────────────────────────────────────────────

    /// @notice Watchtower reports a real-time attestation failure and locks new inflows.
    function test_integration_watchtowerFailurePausesVault() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);

        vm.prank(agent);
        uint256 decisionId = vault.commitDecision(
            DECISION_HASH, "Attempting to swap 50000 USDC - exceeds policy limit", "0g://evidence-xyz"
        );

        attestation.reportFailure(address(vault), agent, decisionId, "TEE signature mismatch");

        assertTrue(registry.circuitBreakerTriggered(agent));
        assertFalse(registry.isActive(agent));
        assertEq(registry.getPolicy(agent).totalDecisions, 1);
        assertEq(registry.getPolicy(agent).compliantDecisions, 0);

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(VelaVault.CircuitBreakerActive.selector, agent));
        vault.deposit(1_000e6, user1);

        uint256 shares = vault.balanceOf(user1);
        vm.prank(user1);
        uint256 withdrawn = vault.redeem(shares, user1, user1);
        assertEq(withdrawn, 10_000e6);

        assertEq(uint8(vault.getDecision(decisionId).status), uint8(VelaVault.AttestationStatus.Pending));
    }

    // ─── Missing Attestation Path ─────────────────────────────────────────────

    /// @notice Missing attestation is handled by the watchtower immediately, not a challenge window.
    function test_integration_missingAttestationPausesVault() public {
        vm.prank(agent);
        uint256 decisionId = vault.commitDecision(DECISION_HASH, "some decision", "0g://cid");

        attestation.reportFailure(address(vault), agent, decisionId, "missing TEE attestation");

        assertTrue(registry.circuitBreakerTriggered(agent));
        assertFalse(registry.isActive(agent));

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(VelaVault.CircuitBreakerActive.selector, agent));
        vault.deposit(1_000e6, user1);
    }

    // ─── Multiple Decisions ───────────────────────────────────────────────────

    function test_integration_multipleDecisions_scoreTracking() public {
        for (uint256 i = 0; i < 5; i++) {
            bytes32 hash = keccak256(abi.encode(i));
            vm.prank(agent);
            uint256 decisionId = vault.commitDecision(hash, "compliant", "0g://cid");
            attestation.verifyAndSettle(address(vault), agent, decisionId, hash, _sign(hash));
        }

        PolicyRegistry.PolicyCommitment memory p = registry.getPolicy(agent);
        assertEq(p.totalDecisions, 5);
        assertEq(p.compliantDecisions, 5);
        assertEq(p.complianceScore, 1000);
        assertTrue(registry.isActive(agent));
    }

    function test_integration_recentDecisions_view() public {
        vm.startPrank(agent);
        for (uint256 i = 0; i < 8; i++) {
            vault.commitDecision(keccak256(abi.encode(i)), "decision", "0g://cid");
        }
        vm.stopPrank();

        VelaVault.DecisionRecord[] memory recent = vault.recentDecisions(5);
        assertEq(recent.length, 5);
        assertEq(recent[0].decisionHash, keccak256(abi.encode(uint256(7))));
        assertEq(recent[4].decisionHash, keccak256(abi.encode(uint256(3))));
    }
}
