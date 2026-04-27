// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Parley Settlement
/// @notice Atomic two-sided escrow for off-chain-negotiated DeFi trades.
/// @dev See SPEC.md §6 for the full state machine, EIP-712 domain, and
///      security notes. This is a skeleton — body intentionally empty.
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

    function dealHash(Deal calldata d) external pure returns (bytes32);
    function getState(bytes32 h) external view returns (DealState);

    function lockUserSide(Deal calldata deal, bytes calldata userSig) external;
    function lockMMSide(Deal calldata deal, bytes calldata mmSig) external;
    function settle(bytes32 h) external;
    function refund(bytes32 h) external;
}

contract Settlement is ISettlement {
    // TODO: EIP-712 domain (name="Parley", version="1", chainId, address(this))
    // TODO: ECDSA.recover for userSig / mmSig vs. deal.user / deal.mm
    // TODO: SafeERC20 transfers, nonce replay guard, deadline check, ReentrancyGuard

    function dealHash(Deal calldata) external pure returns (bytes32) {
        revert("not implemented");
    }

    function getState(bytes32) external pure returns (DealState) {
        revert("not implemented");
    }

    function lockUserSide(Deal calldata, bytes calldata) external pure {
        revert("not implemented");
    }

    function lockMMSide(Deal calldata, bytes calldata) external pure {
        revert("not implemented");
    }

    function settle(bytes32) external pure {
        revert("not implemented");
    }

    function refund(bytes32) external pure {
        revert("not implemented");
    }
}
