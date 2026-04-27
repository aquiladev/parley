// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Settlement} from "../src/Settlement.sol";

contract Deploy is Script {
    function run() external returns (Settlement settlement) {
        vm.startBroadcast();
        settlement = new Settlement();
        vm.stopBroadcast();
        console.log("Settlement deployed:", address(settlement));
    }
}
