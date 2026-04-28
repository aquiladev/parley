// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Parley Settlement
/// @notice Atomic two-sided escrow for off-chain-negotiated DeFi trades.
/// @dev See SPEC.md §6 for the state machine and EIP-712 details.
interface ISettlement {
    struct Deal {
        address user;
        address mm;
        address tokenA; // user → mm
        address tokenB; // mm → user
        uint256 amountA;
        uint256 amountB;
        uint256 deadline;
        uint256 nonce;
    }

    enum DealState {
        None,
        UserLocked,
        BothLocked,
        Settled,
        Refunded
    }

    event UserLocked(bytes32 indexed dealHash, address indexed user);
    event MMLocked(bytes32 indexed dealHash, address indexed mm);
    event Settled(bytes32 indexed dealHash);
    event Refunded(bytes32 indexed dealHash, address indexed party);

    function dealHash(Deal calldata d) external view returns (bytes32);
    function getState(bytes32 h) external view returns (DealState);

    function lockUserSide(Deal calldata deal, bytes calldata userSig) external;
    function lockMMSide(Deal calldata deal, bytes calldata mmSig) external;
    function settle(bytes32 h) external;
    function refund(bytes32 h) external;
}

contract Settlement is ISettlement, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev keccak256("Deal(address user,address mm,address tokenA,address tokenB,uint256 amountA,uint256 amountB,uint256 deadline,uint256 nonce)")
    bytes32 public constant DEAL_TYPEHASH = keccak256(
        "Deal(address user,address mm,address tokenA,address tokenB,uint256 amountA,uint256 amountB,uint256 deadline,uint256 nonce)"
    );

    mapping(bytes32 => DealState) private _states;
    mapping(bytes32 => Deal) private _deals;

    error InvalidSignature();
    error DeadlineExpired();
    error WrongState(DealState expected, DealState actual);
    error NotYetExpired();

    constructor() EIP712("Parley", "1") {}

    function _structHash(Deal calldata d) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DEAL_TYPEHASH,
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
    }

    /// @notice Returns the EIP-712 typed-data digest of `d`. Both signers
    ///         (user + MM) sign this value off-chain; the contract uses it
    ///         as the deal's storage key.
    function dealHash(Deal calldata d) public view returns (bytes32) {
        return _hashTypedDataV4(_structHash(d));
    }

    function getState(bytes32 h) external view returns (DealState) {
        return _states[h];
    }

    function lockUserSide(Deal calldata d, bytes calldata userSig) external nonReentrant {
        if (block.timestamp >= d.deadline) revert DeadlineExpired();
        bytes32 h = dealHash(d);
        DealState st = _states[h];
        if (st != DealState.None) revert WrongState(DealState.None, st);
        if (ECDSA.recover(h, userSig) != d.user) revert InvalidSignature();

        _states[h] = DealState.UserLocked;
        _deals[h] = d;
        IERC20(d.tokenA).safeTransferFrom(d.user, address(this), d.amountA);
        emit UserLocked(h, d.user);
    }

    function lockMMSide(Deal calldata d, bytes calldata mmSig) external nonReentrant {
        if (block.timestamp >= d.deadline) revert DeadlineExpired();
        bytes32 h = dealHash(d);
        DealState st = _states[h];
        if (st != DealState.UserLocked) revert WrongState(DealState.UserLocked, st);
        if (ECDSA.recover(h, mmSig) != d.mm) revert InvalidSignature();

        _states[h] = DealState.BothLocked;
        IERC20(d.tokenB).safeTransferFrom(d.mm, address(this), d.amountB);
        emit MMLocked(h, d.mm);
    }

    function settle(bytes32 h) external nonReentrant {
        DealState st = _states[h];
        if (st != DealState.BothLocked) revert WrongState(DealState.BothLocked, st);

        Deal memory d = _deals[h];
        _states[h] = DealState.Settled;

        IERC20(d.tokenA).safeTransfer(d.mm, d.amountA);
        IERC20(d.tokenB).safeTransfer(d.user, d.amountB);
        emit Settled(h);
    }

    function refund(bytes32 h) external nonReentrant {
        DealState st = _states[h];
        if (st != DealState.UserLocked && st != DealState.BothLocked) {
            revert WrongState(DealState.UserLocked, st);
        }

        Deal memory d = _deals[h];
        if (block.timestamp < d.deadline) revert NotYetExpired();

        _states[h] = DealState.Refunded;
        IERC20(d.tokenA).safeTransfer(d.user, d.amountA);
        if (st == DealState.BothLocked) {
            IERC20(d.tokenB).safeTransfer(d.mm, d.amountB);
        }
        emit Refunded(h, msg.sender);
    }
}
