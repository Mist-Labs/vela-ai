// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PolicyRegistry} from "../src/PolicyRegistry.sol";

contract PolicyRegistryActor {
    function register(PolicyRegistry registry, bytes32 policyRoot, string calldata policyURI, uint256 tier) external {
        registry.registerAgent(policyRoot, policyURI, tier);
    }

    function triggerCircuitBreaker(PolicyRegistry registry, address agent) external {
        registry.triggerCircuitBreaker(agent);
    }

    function recordDecision(PolicyRegistry registry, address agent, bool compliant) external {
        registry.recordDecision(agent, compliant);
    }
}

contract PolicyRegistryTest {
    PolicyRegistry private registry;

    bytes32 private constant POLICY_ROOT = keccak256("policy-root");
    string private constant POLICY_URI = "0g://policy";

    function setUp() public {
        registry = new PolicyRegistry(address(this));
    }

    function testRegisterAgentStoresPolicy() public {
        registry.registerAgent(POLICY_ROOT, POLICY_URI, 0);

        PolicyRegistry.PolicyCommitment memory policy = registry.getPolicy(address(this));

        _assertEq(policy.owner, address(this));
        _assertEq(policy.policyRoot, POLICY_ROOT);
        _assertEq(policy.policyURI, POLICY_URI);
        _assertEq(uint256(policy.tier), 0);
        _assertEq(policy.maxValuePerTxUsdc, 1_000);
        _assertEq(policy.complianceScore, registry.MAX_COMPLIANCE_SCORE());
        _assertTrue(policy.active);
        _assertFalse(policy.circuitBreaker);
    }

    function testIsActiveReturnsTrueForRegisteredAgent() public {
        registry.registerAgent(POLICY_ROOT, POLICY_URI, 0);

        _assertTrue(registry.isActive(address(this)));
    }

    function testCircuitBreakerDeactivatesAgent() public {
        PolicyRegistryActor agent = new PolicyRegistryActor();
        agent.register(registry, POLICY_ROOT, POLICY_URI, 0);

        registry.triggerCircuitBreaker(address(agent));

        PolicyRegistry.PolicyCommitment memory policy = registry.getPolicy(address(agent));
        _assertFalse(registry.isActive(address(agent)));
        _assertFalse(policy.active);
        _assertTrue(policy.circuitBreaker);
    }

    function testPolicyOwnerCanSelfTriggerCircuitBreaker() public {
        PolicyRegistryActor agent = new PolicyRegistryActor();
        agent.register(registry, POLICY_ROOT, POLICY_URI, 0);

        agent.triggerCircuitBreaker(registry, address(agent));

        _assertFalse(registry.isActive(address(agent)));
    }

    function testRecordDecisionTracksComplianceScore() public {
        registry.registerAgent(POLICY_ROOT, POLICY_URI, 0);

        registry.recordDecision(address(this), true);
        registry.recordDecision(address(this), false);

        PolicyRegistry.PolicyCommitment memory policy = registry.getPolicy(address(this));
        _assertEq(policy.totalDecisions, 2);
        _assertEq(policy.compliantDecisions, 1);
        _assertEq(policy.complianceScore, 500);
        _assertTrue(registry.isActive(address(this)));
    }

    function testAutoBreakAfterTenLowComplianceDecisions() public {
        registry.registerAgent(POLICY_ROOT, POLICY_URI, 0);

        for (uint256 i = 0; i < registry.AUTO_BREAK_MIN_DECISIONS(); i++) {
            registry.recordDecision(address(this), false);
        }

        PolicyRegistry.PolicyCommitment memory policy = registry.getPolicy(address(this));
        _assertEq(policy.totalDecisions, registry.AUTO_BREAK_MIN_DECISIONS());
        _assertEq(policy.complianceScore, 0);
        _assertFalse(policy.active);
        _assertTrue(policy.circuitBreaker);
        _assertFalse(registry.isActive(address(this)));
    }

    function testRejectsUnauthorizedCircuitBreaker() public {
        PolicyRegistryActor agent = new PolicyRegistryActor();
        PolicyRegistryActor attacker = new PolicyRegistryActor();
        agent.register(registry, POLICY_ROOT, POLICY_URI, 0);

        try attacker.triggerCircuitBreaker(registry, address(agent)) {
            revert("expected unauthorized circuit breaker revert");
        } catch (bytes memory reason) {
            _assertEq(_selector(reason), PolicyRegistry.NotCircuitBreaker.selector);
        }
    }

    function testRejectsUnauthorizedDecisionRecorder() public {
        registry.registerAgent(POLICY_ROOT, POLICY_URI, 0);
        PolicyRegistryActor attacker = new PolicyRegistryActor();

        try attacker.recordDecision(registry, address(this), true) {
            revert("expected unauthorized recorder revert");
        } catch (bytes memory reason) {
            _assertEq(_selector(reason), PolicyRegistry.NotDecisionRecorder.selector);
        }
    }

    function _selector(bytes memory reason) private pure returns (bytes4 selector) {
        if (reason.length < 4) {
            return bytes4(0);
        }

        assembly {
            selector := mload(add(reason, 32))
        }
    }

    function _assertTrue(bool value) private pure {
        if (!value) revert("assert true failed");
    }

    function _assertFalse(bool value) private pure {
        if (value) revert("assert false failed");
    }

    function _assertEq(address actual, address expected) private pure {
        if (actual != expected) revert("address assertion failed");
    }

    function _assertEq(bytes32 actual, bytes32 expected) private pure {
        if (actual != expected) revert("bytes32 assertion failed");
    }

    function _assertEq(string memory actual, string memory expected) private pure {
        if (keccak256(bytes(actual)) != keccak256(bytes(expected))) {
            revert("string assertion failed");
        }
    }

    function _assertEq(uint256 actual, uint256 expected) private pure {
        if (actual != expected) revert("uint256 assertion failed");
    }
}
