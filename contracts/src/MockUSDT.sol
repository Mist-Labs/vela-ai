// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockUSDT
/// @notice Testnet faucet token mimicking USDT (6 decimals).
///         Anyone can call mint() up to DAILY_CAP per address per day.
///         Owner can call ownerMint() without restriction for vault seeding.
contract MockUSDT is ERC20, Ownable {
    uint8 private constant DECIMALS = 6;

    /// @notice Max tokens a single address can mint per 24-hour window (1,000 USDT)
    uint256 public constant DAILY_CAP = 1_000 * 10 ** 6;

    /// @dev wallet => UTC-day bucket => amount minted that day
    mapping(address => mapping(uint256 => uint256)) private _mintedToday;

    event PublicMint(address indexed to, uint256 amount, uint256 dayBucket);
    event OwnerMint(address indexed to, uint256 amount);

    error DailyCapExceeded(uint256 requested, uint256 remaining);
    error ZeroAmount();
    error ZeroAddress();

    constructor(address initialOwner)
        ERC20("Mock USDT", "mUSDT")
        Ownable(initialOwner)
    {}

    // ─────────────────────────────────────────────────────────
    // Public faucet
    // ─────────────────────────────────────────────────────────

    /// @notice Mint up to DAILY_CAP tokens per 24-hour window.
    /// @param to      Recipient address.
    /// @param amount  Amount in raw token units (6 decimals). Max DAILY_CAP per day.
    function mint(address to, uint256 amount) external {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 day = _today();
        uint256 alreadyMinted = _mintedToday[msg.sender][day];
        uint256 remaining = DAILY_CAP - alreadyMinted;

        if (amount > remaining) revert DailyCapExceeded(amount, remaining);

        _mintedToday[msg.sender][day] += amount;
        _mint(to, amount);

        emit PublicMint(to, amount, day);
    }

    /// @notice Owner-only unrestricted mint for vault seeding and deploy scripts.
    /// @param to      Recipient address.
    /// @param amount  Amount in raw token units (6 decimals).
    function ownerMint(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _mint(to, amount);
        emit OwnerMint(to, amount);
    }

    /// @notice How many tokens `minter` can still mint today.
    function remainingToday(address minter) external view returns (uint256) {
        uint256 used = _mintedToday[minter][_today()];
        return used >= DAILY_CAP ? 0 : DAILY_CAP - used;
    }

    // ─────────────────────────────────────────────────────────
    // ERC20 overrides
    // ─────────────────────────────────────────────────────────

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    // ─────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────

    /// @dev Returns the current UTC day as an integer bucket (seconds / 86400).
    function _today() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }
}
