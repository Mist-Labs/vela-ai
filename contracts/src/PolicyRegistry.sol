// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract PolicyRegistry {
    enum Tier {
        MICRO,
        STANDARD,
        PRO,
        INSTITUTIONAL
    }

    struct TierConfig {
        uint256 bond;
        uint256 maxValuePerTxUsdc;
        bool enabled;
    }

    struct PolicyCommitment {
        address owner;
        bytes32 policyRoot;
        string policyURI;
        Tier tier;
        uint256 bond;
        uint256 maxValuePerTxUsdc;
        uint256 totalDecisions;
        uint256 compliantDecisions;
        uint256 complianceScore;
        bool active;
        bool circuitBreaker;
    }

    uint256 public constant MAX_COMPLIANCE_SCORE = 1000;
    uint256 public constant AUTO_BREAK_SCORE = 200;
    uint256 public constant AUTO_BREAK_MIN_DECISIONS = 10;

    address public owner;

    mapping(address agent => PolicyCommitment policy) private policies;
    mapping(uint256 tier => TierConfig config) private tierConfigs;
    mapping(address recorder => bool authorized) public decisionRecorders;
    mapping(address breaker => bool authorized) public circuitBreakers;

    event AgentRegistered(
        address indexed agent,
        address indexed owner,
        bytes32 indexed policyRoot,
        Tier tier,
        uint256 bond,
        uint256 maxValuePerTxUsdc,
        string policyURI
    );
    event DecisionRecorded(address indexed agent, bool compliant, uint256 totalDecisions, uint256 complianceScore);
    event CircuitBreakerTriggered(address indexed agent, address indexed caller);
    event DecisionRecorderSet(address indexed recorder, bool authorized);
    event CircuitBreakerSet(address indexed breaker, bool authorized);

    error NotOwner();
    error NotDecisionRecorder();
    error NotCircuitBreaker();
    error InvalidPolicyRoot();
    error TierDisabled();
    error IncorrectBond(uint256 expected, uint256 actual);
    error AgentNotRegistered(address agent);
    error AgentAlreadyRegistered(address agent);
    error AgentInactive(address agent);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        decisionRecorders[msg.sender] = true;
        circuitBreakers[msg.sender] = true;

        tierConfigs[uint256(Tier.MICRO)] = TierConfig({bond: 0.05 ether, maxValuePerTxUsdc: 1_000, enabled: true});
        tierConfigs[uint256(Tier.STANDARD)] = TierConfig({bond: 0.2 ether, maxValuePerTxUsdc: 10_000, enabled: true});
        tierConfigs[uint256(Tier.PRO)] = TierConfig({bond: 1 ether, maxValuePerTxUsdc: 100_000, enabled: true});
        tierConfigs[uint256(Tier.INSTITUTIONAL)] =
            TierConfig({bond: 5 ether, maxValuePerTxUsdc: 1_000_000, enabled: true});
    }

    function registerAgent(bytes32 policyRoot, string calldata policyURI, uint256 tier) external payable {
        if (policyRoot == bytes32(0)) revert InvalidPolicyRoot();
        if (policies[msg.sender].owner != address(0)) {
            revert AgentAlreadyRegistered(msg.sender);
        }

        TierConfig memory config = tierConfigs[tier];
        if (!config.enabled) revert TierDisabled();
        if (msg.value != config.bond) {
            revert IncorrectBond(config.bond, msg.value);
        }

        policies[msg.sender] = PolicyCommitment({
            owner: msg.sender,
            policyRoot: policyRoot,
            policyURI: policyURI,
            tier: Tier(tier),
            bond: msg.value,
            maxValuePerTxUsdc: config.maxValuePerTxUsdc,
            totalDecisions: 0,
            compliantDecisions: 0,
            complianceScore: MAX_COMPLIANCE_SCORE,
            active: true,
            circuitBreaker: false
        });

        emit AgentRegistered(
            msg.sender, msg.sender, policyRoot, Tier(tier), msg.value, config.maxValuePerTxUsdc, policyURI
        );
    }

    function triggerCircuitBreaker(address agent) external {
        PolicyCommitment storage policy = _requirePolicy(agent);
        if (msg.sender != policy.owner && !circuitBreakers[msg.sender]) {
            revert NotCircuitBreaker();
        }

        policy.active = false;
        policy.circuitBreaker = true;

        emit CircuitBreakerTriggered(agent, msg.sender);
    }

    function recordDecision(address agent, bool compliant) external {
        if (!decisionRecorders[msg.sender]) revert NotDecisionRecorder();

        PolicyCommitment storage policy = _requirePolicy(agent);
        if (!policy.active) revert AgentInactive(agent);

        policy.totalDecisions += 1;
        if (compliant) {
            policy.compliantDecisions += 1;
        }

        policy.complianceScore = (policy.compliantDecisions * MAX_COMPLIANCE_SCORE) / policy.totalDecisions;

        if (policy.totalDecisions >= AUTO_BREAK_MIN_DECISIONS && policy.complianceScore < AUTO_BREAK_SCORE) {
            policy.active = false;
            policy.circuitBreaker = true;
            emit CircuitBreakerTriggered(agent, msg.sender);
        }

        emit DecisionRecorded(agent, compliant, policy.totalDecisions, policy.complianceScore);
    }

    function setDecisionRecorder(address recorder, bool authorized) external onlyOwner {
        decisionRecorders[recorder] = authorized;
        emit DecisionRecorderSet(recorder, authorized);
    }

    function setCircuitBreaker(address breaker, bool authorized) external onlyOwner {
        circuitBreakers[breaker] = authorized;
        emit CircuitBreakerSet(breaker, authorized);
    }

    function isActive(address agent) external view returns (bool) {
        PolicyCommitment storage policy = policies[agent];
        return policy.owner != address(0) && policy.active && !policy.circuitBreaker;
    }

    function getPolicy(address agent) external view returns (PolicyCommitment memory) {
        if (policies[agent].owner == address(0)) {
            revert AgentNotRegistered(agent);
        }
        return policies[agent];
    }

    function getTierConfig(uint256 tier) external view returns (TierConfig memory) {
        return tierConfigs[tier];
    }

    function _requirePolicy(address agent) private view returns (PolicyCommitment storage) {
        PolicyCommitment storage policy = policies[agent];
        if (policy.owner == address(0)) revert AgentNotRegistered(agent);
        return policy;
    }
}
