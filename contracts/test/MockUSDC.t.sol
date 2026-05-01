// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC token;

    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    uint256 constant DAILY_CAP = 1_000 * 10 ** 6; // 1,000 mUSDC
    uint256 constant ONE_DAY   = 1 days;

    // ─────────────────────────────────────────────────────────
    // Setup
    // ─────────────────────────────────────────────────────────

    function setUp() public {
        vm.prank(owner);
        token = new MockUSDC(owner);
    }

    // ─────────────────────────────────────────────────────────
    // Metadata
    // ─────────────────────────────────────────────────────────

    function test_metadata() public view {
        assertEq(token.name(),     "Mock USDC");
        assertEq(token.symbol(),   "mUSDC");
        assertEq(token.decimals(), 6);
        assertEq(token.DAILY_CAP(), DAILY_CAP);
    }

    // ─────────────────────────────────────────────────────────
    // Public mint — happy path
    // ─────────────────────────────────────────────────────────

    function test_publicMint_basic() public {
        uint256 amount = 100 * 10 ** 6; // 100 mUSDC
        vm.prank(alice);
        token.mint(alice, amount);

        assertEq(token.balanceOf(alice), amount);
        assertEq(token.remainingToday(alice), DAILY_CAP - amount);
    }

    function test_publicMint_exactCap() public {
        vm.prank(alice);
        token.mint(alice, DAILY_CAP);

        assertEq(token.balanceOf(alice), DAILY_CAP);
        assertEq(token.remainingToday(alice), 0);
    }

    function test_publicMint_toSomeoneElse() public {
        uint256 amount = 50 * 10 ** 6;
        vm.prank(alice);
        token.mint(bob, amount); // alice mints to bob

        assertEq(token.balanceOf(bob), amount);
        // cap is tracked against msg.sender (alice), not recipient
        assertEq(token.remainingToday(alice), DAILY_CAP - amount);
        assertEq(token.remainingToday(bob),   DAILY_CAP); // bob hasn't minted
    }

    function test_publicMint_splitAcrossMultipleCalls() public {
        uint256 first  = 600 * 10 ** 6;
        uint256 second = 400 * 10 ** 6;

        vm.startPrank(alice);
        token.mint(alice, first);
        token.mint(alice, second);
        vm.stopPrank();

        assertEq(token.balanceOf(alice), DAILY_CAP);
        assertEq(token.remainingToday(alice), 0);
    }

    function test_publicMint_emitsEvent() public {
        uint256 amount = 200 * 10 ** 6;
        uint256 day    = block.timestamp / 1 days;

        vm.expectEmit(true, false, false, true);
        emit MockUSDC.PublicMint(alice, amount, day);

        vm.prank(alice);
        token.mint(alice, amount);
    }

    // ─────────────────────────────────────────────────────────
    // Public mint — daily cap enforcement
    // ─────────────────────────────────────────────────────────

    function test_publicMint_revertsWhenCapExceeded() public {
        vm.startPrank(alice);
        token.mint(alice, DAILY_CAP);

        vm.expectRevert(
            abi.encodeWithSelector(MockUSDC.DailyCapExceeded.selector, 1, 0)
        );
        token.mint(alice, 1);
        vm.stopPrank();
    }

    function test_publicMint_revertsOnPartialOverflow() public {
        uint256 first = 800 * 10 ** 6;
        vm.startPrank(alice);
        token.mint(alice, first);

        uint256 overBy = 300 * 10 ** 6; // 800 + 300 > 1000
        uint256 remaining = DAILY_CAP - first;

        vm.expectRevert(
            abi.encodeWithSelector(MockUSDC.DailyCapExceeded.selector, overBy, remaining)
        );
        token.mint(alice, overBy);
        vm.stopPrank();
    }

    /// @dev Cap resets after 24 hours — warp forward and mint again.
    function test_publicMint_capResetsNextDay() public {
        vm.startPrank(alice);
        token.mint(alice, DAILY_CAP);

        // Warp to next day
        vm.warp(block.timestamp + ONE_DAY);

        // Should succeed — new day bucket
        token.mint(alice, DAILY_CAP);
        vm.stopPrank();

        assertEq(token.balanceOf(alice), DAILY_CAP * 2);
    }

    function test_publicMint_independentCapPerCaller() public {
        vm.prank(alice);
        token.mint(alice, DAILY_CAP);

        // Bob has his own fresh cap
        vm.prank(bob);
        token.mint(bob, DAILY_CAP);

        assertEq(token.balanceOf(alice), DAILY_CAP);
        assertEq(token.balanceOf(bob),   DAILY_CAP);
    }

    // ─────────────────────────────────────────────────────────
    // Public mint — input validation
    // ─────────────────────────────────────────────────────────

    function test_publicMint_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(MockUSDC.ZeroAmount.selector);
        token.mint(alice, 0);
    }

    function test_publicMint_revertsOnZeroAddress() public {
        vm.prank(alice);
        vm.expectRevert(MockUSDC.ZeroAddress.selector);
        token.mint(address(0), 100);
    }

    // ─────────────────────────────────────────────────────────
    // Owner mint
    // ─────────────────────────────────────────────────────────

    function test_ownerMint_unlimited() public {
        uint256 bigAmount = 1_000_000 * 10 ** 6; // 1M mUSDC
        vm.prank(owner);
        token.ownerMint(alice, bigAmount);

        assertEq(token.balanceOf(alice), bigAmount);
    }

    function test_ownerMint_doesNotAffectPublicCap() public {
        uint256 seedAmount = 500_000 * 10 ** 6;
        vm.prank(owner);
        token.ownerMint(alice, seedAmount);

        // Alice can still mint her full public daily cap
        vm.prank(alice);
        token.mint(alice, DAILY_CAP);

        assertEq(token.balanceOf(alice), seedAmount + DAILY_CAP);
    }

    function test_ownerMint_emitsEvent() public {
        uint256 amount = 999 * 10 ** 6;
        vm.expectEmit(true, false, false, true);
        emit MockUSDC.OwnerMint(bob, amount);

        vm.prank(owner);
        token.ownerMint(bob, amount);
    }

    function test_ownerMint_revertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(); // OZ Ownable reverts with OwnableUnauthorizedAccount
        token.ownerMint(alice, 1);
    }

    function test_ownerMint_revertsOnZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(MockUSDC.ZeroAmount.selector);
        token.ownerMint(alice, 0);
    }

    function test_ownerMint_revertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(MockUSDC.ZeroAddress.selector);
        token.ownerMint(address(0), 1);
    }

    // ─────────────────────────────────────────────────────────
    // remainingToday view
    // ─────────────────────────────────────────────────────────

    function test_remainingToday_fullCapOnFreshAddress() public view {
        assertEq(token.remainingToday(alice), DAILY_CAP);
    }

    function test_remainingToday_decreasesAfterMint() public {
        uint256 amount = 250 * 10 ** 6;
        vm.prank(alice);
        token.mint(alice, amount);

        assertEq(token.remainingToday(alice), DAILY_CAP - amount);
    }

    function test_remainingToday_zeroWhenExhausted() public {
        vm.prank(alice);
        token.mint(alice, DAILY_CAP);
        assertEq(token.remainingToday(alice), 0);
    }

    function test_remainingToday_resetsAfterDay() public {
        vm.prank(alice);
        token.mint(alice, DAILY_CAP);

        vm.warp(block.timestamp + ONE_DAY);
        assertEq(token.remainingToday(alice), DAILY_CAP);
    }

    // ─────────────────────────────────────────────────────────
    // Fuzz
    // ─────────────────────────────────────────────────────────

    function testFuzz_publicMint_withinCap(uint256 amount) public {
        amount = bound(amount, 1, DAILY_CAP);
        vm.prank(alice);
        token.mint(alice, amount);
        assertEq(token.balanceOf(alice), amount);
    }

    function testFuzz_publicMint_exceedingCapReverts(uint256 excess) public {
        excess = bound(excess, 1, type(uint128).max);
        uint256 amount = DAILY_CAP + excess;

        vm.prank(alice);
        vm.expectRevert();
        token.mint(alice, amount);
    }

    function testFuzz_ownerMint_anyAmount(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);
        vm.prank(owner);
        token.ownerMint(alice, amount);
        assertEq(token.balanceOf(alice), amount);
    }
}
