// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockQUSDC} from "./MockQUSDC.sol";

/// A token that, while a transfer is in progress, calls back into a target contract and records whether
/// that call was refused with the router's Reentrancy error. Tests use it to prove the reentrancy guard
/// on deposit, withdraw and refund. Tests only; never deployed.
contract ReentrantToken is MockQUSDC {
    address public target;
    bytes public payload;
    bool public armed;
    bool public attempted;
    bytes4 public lastRefusal;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
        attempted = false;
        lastRefusal = bytes4(0);
    }

    function _move(address from, address to, uint256 amount) internal override {
        if (armed) {
            armed = false; // call back once
            attempted = true;
            (bool ok, bytes memory ret) = target.call(payload);
            if (!ok && ret.length >= 4) {
                bytes4 sel;
                assembly {
                    sel := mload(add(ret, 32))
                }
                lastRefusal = sel;
            } else if (ok) {
                lastRefusal = bytes4(0xffffffff); // the call went through: the guard did not hold
            }
        }
        super._move(from, to, amount);
    }
}
