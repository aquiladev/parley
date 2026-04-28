// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mintable ERC20 for the Phase 1 testnet demo. Public mint — anyone
///         can mint to themselves so users + MMs can fund themselves without
///         needing external faucet flows. Decimals are configurable to match
///         USDC (6) or WETH (18).
/// @dev Not for mainnet use.
contract TestERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
