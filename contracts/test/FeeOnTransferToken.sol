// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockQUSDC} from "./MockQUSDC.sol";

/// A token that keeps 1% of every transfer. Tests use it to show the router refuses a deposit that
/// delivers less than was asked. Tests only; never deployed.
contract FeeOnTransferToken is MockQUSDC {
    function _move(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }
}
