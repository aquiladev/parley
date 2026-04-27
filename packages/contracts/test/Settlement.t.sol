// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Settlement} from "../src/Settlement.sol";

contract SettlementTest is Test {
    Settlement internal settlement;

    function setUp() public {
        settlement = new Settlement();
    }

    function test_skeleton() public {
        assertTrue(address(settlement) != address(0));
    }

    // TODO: happy-path lock-lock-settle, deadline refund, signature recovery,
    // replay protection via nonce, reentrancy.
}
