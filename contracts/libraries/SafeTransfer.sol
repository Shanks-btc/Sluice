// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";
import {ISluiceErrors} from "../interfaces/ISluiceErrors.sol";

/// Token transfers that fail loudly. A token that returns false, reverts, or has no code at all makes
/// the whole call revert with TransferFailed.
library SafeTransfer {
    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        _call(address(token), abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        _call(address(token), abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
    }

    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) revert ISluiceErrors.TransferFailed();
        if (ret.length == 0) {
            // A token may return nothing, but then it has to be a contract.
            if (token.code.length == 0) revert ISluiceErrors.TransferFailed();
        } else if (ret.length != 32 || !abi.decode(ret, (bool))) {
            revert ISluiceErrors.TransferFailed();
        }
    }
}
