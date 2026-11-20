// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// A minimal proxy that keeps its implementation and admin in the ERC-1967 storage slots, so token_risk_check and
/// contract_lookup have a proxy to detect. Test use only. Never deployed anywhere.
contract SlotProxy {
    // bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    // bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1)
    bytes32 private constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    constructor(address implementation, address admin) {
        assembly {
            sstore(IMPLEMENTATION_SLOT, implementation)
            sstore(ADMIN_SLOT, admin)
        }
    }

    fallback() external payable {
        address implementation;
        assembly {
            implementation := sload(IMPLEMENTATION_SLOT)
        }
        (bool ok, bytes memory data) = implementation.delegatecall(msg.data);
        assembly {
            if iszero(ok) { revert(add(data, 32), mload(data)) }
            return(add(data, 32), mload(data))
        }
    }

    receive() external payable {}
}
