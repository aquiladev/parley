// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TestERC20} from "../src/TestERC20.sol";

/// @notice Phase 1 only. Deploys mock USDC + WETH on Sepolia and mints a
///         healthy starting balance to the deployer. Anyone can subsequently
///         self-mint via TestERC20.mint().
/// @dev Archived as of Phase 5 — the live demo runs against real Sepolia
///      USDC and WETH (see docs/deployment.md). Don't run this script for
///      a fresh deploy; fund from faucets instead.
contract DeployTestTokens is Script {
    function run() external returns (TestERC20 usdc, TestERC20 weth) {
        uint256 mintUsdc = 1_000_000 * 1e6; // 1,000,000 mUSDC (6dp)
        uint256 mintWeth = 1_000 * 1e18; // 1,000 mWETH (18dp)

        vm.startBroadcast();
        usdc = new TestERC20("Mock USDC", "mUSDC", 6);
        weth = new TestERC20("Mock WETH", "mWETH", 18);
        usdc.mint(msg.sender, mintUsdc);
        weth.mint(msg.sender, mintWeth);
        vm.stopBroadcast();

        console.log("USDC deployed:", address(usdc));
        console.log("WETH deployed:", address(weth));
        console.log("Minted to deployer:", msg.sender);
    }
}
