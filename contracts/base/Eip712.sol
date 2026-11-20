// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// EIP-712 typed-data hashing with a domain that binds the signer's intent to one chain and one
/// contract. The domain separator is cached, and is rebuilt if the chain id or the contract address
/// ever differs from the one it was cached for (for example after a chain fork), so a signature made
/// for one chain or deployment can never be replayed on another.
abstract contract Eip712 {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private immutable _nameHash;
    bytes32 private immutable _versionHash;
    bytes32 private immutable _cachedSeparator;
    uint256 private immutable _cachedChainId;
    address private immutable _cachedThis;

    constructor(string memory name, string memory version) {
        bytes32 nameHash = keccak256(bytes(name));
        bytes32 versionHash = keccak256(bytes(version));
        _nameHash = nameHash;
        _versionHash = versionHash;
        _cachedChainId = block.chainid;
        _cachedThis = address(this);
        _cachedSeparator = keccak256(abi.encode(DOMAIN_TYPEHASH, nameHash, versionHash, block.chainid, address(this)));
    }

    /// The EIP-712 domain separator for this contract on the current chain.
    function domainSeparator() public view returns (bytes32) {
        if (address(this) == _cachedThis && block.chainid == _cachedChainId) return _cachedSeparator;
        return keccak256(abi.encode(DOMAIN_TYPEHASH, _nameHash, _versionHash, block.chainid, address(this)));
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }
}
