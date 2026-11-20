// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Recovers the signer of a 65-byte ECDSA signature (r, s, v), and refuses the malleable forms.
/// It returns the zero address for anything that is not a canonical signature, so a caller only has
/// to compare the result with the address it expects (and treat zero as invalid).
library SignatureLib {
    /// Half of the secp256k1 group order. A signature with s above this has a twin with the same
    /// meaning, so it is refused (EIP-2).
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > HALF_ORDER) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
