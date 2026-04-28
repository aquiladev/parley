// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Settlement, ISettlement} from "../src/Settlement.sol";

contract MockERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev ERC-20 that calls back into Settlement during transferFrom. Used to
///      verify the ReentrancyGuard prevents nested entry on lock paths.
contract ReenteringERC20 is ERC20 {
    Settlement public target;
    bytes public payload;
    bool public armed;

    constructor() ERC20("RE", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(Settlement t, bytes calldata p) external {
        target = t;
        payload = p;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 amount)
        public
        override
        returns (bool)
    {
        bool ok = super.transferFrom(from, to, amount);
        if (armed) {
            armed = false;
            (bool success,) = address(target).call(payload);
            require(!success, "reentrancy guard should have rejected");
        }
        return ok;
    }
}

contract SettlementTest is Test {
    Settlement internal settlement;
    MockERC20 internal tokenA; // user → mm
    MockERC20 internal tokenB; // mm → user

    uint256 internal constant USER_PK = 0xA11CE;
    uint256 internal constant MM_PK = 0xB0B;
    address internal user;
    address internal mm;

    uint256 internal constant AMOUNT_A = 50e6; // 50 USDC-equivalent (6dp)
    uint256 internal constant AMOUNT_B = 0.02 ether; // 0.02 WETH-equivalent

    function setUp() public {
        settlement = new Settlement();
        tokenA = new MockERC20("USDC-mock", "USDC");
        tokenB = new MockERC20("WETH-mock", "WETH");

        user = vm.addr(USER_PK);
        mm = vm.addr(MM_PK);

        tokenA.mint(user, AMOUNT_A);
        tokenB.mint(mm, AMOUNT_B);

        vm.prank(user);
        tokenA.approve(address(settlement), type(uint256).max);
        vm.prank(mm);
        tokenB.approve(address(settlement), type(uint256).max);
    }

    // ----- helpers ---------------------------------------------------------

    function _buildDeal() internal view returns (ISettlement.Deal memory) {
        return ISettlement.Deal({
            user: user,
            mm: mm,
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            amountA: AMOUNT_A,
            amountB: AMOUNT_B,
            deadline: block.timestamp + 1 hours,
            nonce: 1
        });
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _expectedDigest(ISettlement.Deal memory d) internal view returns (bytes32) {
        bytes32 typehash = keccak256(
            "Deal(address user,address mm,address tokenA,address tokenB,uint256 amountA,uint256 amountB,uint256 deadline,uint256 nonce)"
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typehash,
                d.user,
                d.mm,
                d.tokenA,
                d.tokenB,
                d.amountA,
                d.amountB,
                d.deadline,
                d.nonce
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("Parley")),
                keccak256(bytes("1")),
                block.chainid,
                address(settlement)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    // ----- dealHash --------------------------------------------------------

    function test_dealHash_matchesOffchainDigest() public view {
        ISettlement.Deal memory d = _buildDeal();
        ISettlement.Deal memory dCalldata = d;
        bytes32 onchain = settlement.dealHash(dCalldata);
        bytes32 offchain = _expectedDigest(d);
        assertEq(onchain, offchain, "EIP-712 digest must match off-chain computation");
    }

    // ----- happy path ------------------------------------------------------

    function test_happyPath_lockLockSettle() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);

        // user side
        vm.expectEmit(true, true, false, false);
        emit ISettlement.UserLocked(h, user);
        settlement.lockUserSide(d, _sign(USER_PK, h));

        assertEq(uint8(settlement.getState(h)), uint8(ISettlement.DealState.UserLocked));
        assertEq(tokenA.balanceOf(address(settlement)), AMOUNT_A);
        assertEq(tokenA.balanceOf(user), 0);

        // mm side
        vm.expectEmit(true, true, false, false);
        emit ISettlement.MMLocked(h, mm);
        settlement.lockMMSide(d, _sign(MM_PK, h));

        assertEq(uint8(settlement.getState(h)), uint8(ISettlement.DealState.BothLocked));
        assertEq(tokenB.balanceOf(address(settlement)), AMOUNT_B);
        assertEq(tokenB.balanceOf(mm), 0);

        // settle
        vm.expectEmit(true, false, false, false);
        emit ISettlement.Settled(h);
        settlement.settle(h);

        assertEq(uint8(settlement.getState(h)), uint8(ISettlement.DealState.Settled));
        assertEq(tokenA.balanceOf(mm), AMOUNT_A, "MM receives tokenA");
        assertEq(tokenB.balanceOf(user), AMOUNT_B, "user receives tokenB");
        assertEq(tokenA.balanceOf(address(settlement)), 0);
        assertEq(tokenB.balanceOf(address(settlement)), 0);
    }

    // ----- refund paths ----------------------------------------------------

    function test_refund_userOnlyLocked() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);
        settlement.lockUserSide(d, _sign(USER_PK, h));

        // MM never locks; deadline passes
        vm.warp(d.deadline);
        // refund is callable by anyone; use a third-party caller
        address relayer = address(0xCAFE);
        vm.expectEmit(true, true, false, false);
        emit ISettlement.Refunded(h, relayer);
        vm.prank(relayer);
        settlement.refund(h);

        assertEq(uint8(settlement.getState(h)), uint8(ISettlement.DealState.Refunded));
        assertEq(tokenA.balanceOf(user), AMOUNT_A, "user gets tokenA back");
        assertEq(tokenB.balanceOf(mm), AMOUNT_B, "MM never lost tokenB");
    }

    function test_refund_bothLocked() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);
        settlement.lockUserSide(d, _sign(USER_PK, h));
        settlement.lockMMSide(d, _sign(MM_PK, h));

        vm.warp(d.deadline);
        settlement.refund(h);

        assertEq(uint8(settlement.getState(h)), uint8(ISettlement.DealState.Refunded));
        assertEq(tokenA.balanceOf(user), AMOUNT_A);
        assertEq(tokenB.balanceOf(mm), AMOUNT_B);
        assertEq(tokenA.balanceOf(address(settlement)), 0);
        assertEq(tokenB.balanceOf(address(settlement)), 0);
    }

    function test_refund_revertsBeforeDeadline() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);
        settlement.lockUserSide(d, _sign(USER_PK, h));

        vm.warp(d.deadline - 1);
        vm.expectRevert(Settlement.NotYetExpired.selector);
        settlement.refund(h);
    }

    function test_refund_revertsBeforeAnyLock() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);
        vm.warp(d.deadline);

        vm.expectRevert(
            abi.encodeWithSelector(
                Settlement.WrongState.selector,
                ISettlement.DealState.UserLocked,
                ISettlement.DealState.None
            )
        );
        settlement.refund(h);
    }

    // ----- deadline edges --------------------------------------------------

    function test_lockUserSide_revertsAtExactDeadline() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);
        vm.warp(d.deadline);
        vm.expectRevert(Settlement.DeadlineExpired.selector);
        settlement.lockUserSide(d, _sign(USER_PK, h));
    }

    function test_lockUserSide_succeedsOneSecondBefore() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);
        vm.warp(d.deadline - 1);
        settlement.lockUserSide(d, _sign(USER_PK, h));
        assertEq(uint8(settlement.getState(h)), uint8(ISettlement.DealState.UserLocked));
    }

    function test_lockMMSide_revertsAtExactDeadline() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);
        settlement.lockUserSide(d, _sign(USER_PK, h));
        vm.warp(d.deadline);
        vm.expectRevert(Settlement.DeadlineExpired.selector);
        settlement.lockMMSide(d, _sign(MM_PK, h));
    }

    // ----- signature checks ------------------------------------------------

    function test_lockUserSide_revertsOnInvalidSig() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);
        // sign with the MM's key, claim it's the user
        bytes memory wrongSig = _sign(MM_PK, h);
        vm.expectRevert(Settlement.InvalidSignature.selector);
        settlement.lockUserSide(d, wrongSig);
    }

    function test_lockMMSide_revertsOnInvalidSig() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);
        settlement.lockUserSide(d, _sign(USER_PK, h));
        bytes memory wrongSig = _sign(USER_PK, h); // user signing instead of MM
        vm.expectRevert(Settlement.InvalidSignature.selector);
        settlement.lockMMSide(d, wrongSig);
    }

    // ----- replay ----------------------------------------------------------

    function test_lockUserSide_revertsOnReplay() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);
        settlement.lockUserSide(d, _sign(USER_PK, h));

        // try to lock again — same deal already in UserLocked state
        vm.expectRevert(
            abi.encodeWithSelector(
                Settlement.WrongState.selector,
                ISettlement.DealState.None,
                ISettlement.DealState.UserLocked
            )
        );
        settlement.lockUserSide(d, _sign(USER_PK, h));
    }

    function test_settle_revertsBeforeBothLocked() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);
        settlement.lockUserSide(d, _sign(USER_PK, h));

        vm.expectRevert(
            abi.encodeWithSelector(
                Settlement.WrongState.selector,
                ISettlement.DealState.BothLocked,
                ISettlement.DealState.UserLocked
            )
        );
        settlement.settle(h);
    }

    function test_settleAfterRefund_reverts() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);
        settlement.lockUserSide(d, _sign(USER_PK, h));
        vm.warp(d.deadline);
        settlement.refund(h);

        vm.expectRevert(
            abi.encodeWithSelector(
                Settlement.WrongState.selector,
                ISettlement.DealState.BothLocked,
                ISettlement.DealState.Refunded
            )
        );
        settlement.settle(h);
    }

    function test_refundAfterSettle_reverts() public {
        ISettlement.Deal memory d = _buildDeal();
        bytes32 h = settlement.dealHash(d);
        settlement.lockUserSide(d, _sign(USER_PK, h));
        settlement.lockMMSide(d, _sign(MM_PK, h));
        settlement.settle(h);

        vm.warp(d.deadline);
        vm.expectRevert(
            abi.encodeWithSelector(
                Settlement.WrongState.selector,
                ISettlement.DealState.UserLocked,
                ISettlement.DealState.Settled
            )
        );
        settlement.refund(h);
    }

    // ----- reentrancy ------------------------------------------------------

    function test_reentrancy_blockedOnLockUserSide() public {
        ReenteringERC20 evil = new ReenteringERC20();
        evil.mint(user, AMOUNT_A);
        vm.prank(user);
        evil.approve(address(settlement), type(uint256).max);

        ISettlement.Deal memory d = ISettlement.Deal({
            user: user,
            mm: mm,
            tokenA: address(evil),
            tokenB: address(tokenB),
            amountA: AMOUNT_A,
            amountB: AMOUNT_B,
            deadline: block.timestamp + 1 hours,
            nonce: 99
        });
        bytes32 h = settlement.dealHash(d);
        bytes memory userSig = _sign(USER_PK, h);

        // arm the malicious token to call settle() on the SAME deal during transferFrom
        evil.arm(settlement, abi.encodeWithSelector(Settlement.settle.selector, h));

        // outer call should still succeed; the reentrant settle() must revert
        // and the malicious token's require(!success) gets triggered if guard fails.
        // If the guard works, success=false inside transferFrom, so the require holds
        // and the outer lockUserSide completes normally.
        settlement.lockUserSide(d, userSig);
        assertEq(uint8(settlement.getState(h)), uint8(ISettlement.DealState.UserLocked));
    }
}
