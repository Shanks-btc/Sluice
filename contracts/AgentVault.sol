// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Eip712} from "./base/Eip712.sol";
import {SignatureLib} from "./libraries/SignatureLib.sol";
import {ISluiceErrors} from "./interfaces/ISluiceErrors.sol";

/// Session keys for AI agents. A payer lets an agent key spend from the payer's prepaid balance, inside
/// a policy the payer sets and the chain enforces:
///   - a total budget,
///   - a cap on any single call,
///   - an expiry time,
///   - a list of allowed (builder, tool) pairs, so a stolen agent key can only pay the tools the payer
///     named, to the builders the payer named.
/// The payer can revoke a session at any moment. The router creates this vault when it is deployed
/// and is the only contract that can spend a session; the vault holds no tokens at all.
contract AgentVault is Eip712, ISluiceErrors {
    /// The most tools one session can list. A session stores one slot per tool.
    uint256 public constant MAX_TOOLS = 32;

    struct Tool {
        address payee;
        bytes32 toolId; // bytes32(0) allows every tool of that payee
    }

    struct Grant {
        address agent;
        uint256 budget;
        uint256 perCallCap;
        uint256 expiry;
    }

    // Two storage slots: [budget, spent] and [perCallCap, expiry, id].
    struct Session {
        uint128 budget;
        uint128 spent;
        uint128 perCallCap;
        uint64 expiry;
        uint64 id;
    }

    bytes32 private constant TOOL_TYPEHASH = keccak256("Tool(address payee,bytes32 toolId)");
    bytes32 private constant AUTHORIZE_TYPEHASH = keccak256(
        "Authorize(address payer,address agent,uint256 budget,uint256 perCallCap,uint256 expiry,Tool[] tools,uint256 nonce,uint256 deadline)Tool(address payee,bytes32 toolId)"
    );
    bytes32 private constant REVOKE_TYPEHASH =
        keccak256("Revoke(address payer,address agent,uint256 nonce,uint256 deadline)");

    /// The only address allowed to spend a session.
    address public immutable router;

    /// How many sessions have ever been authorised. Session ids start at 1.
    uint64 public sessionCount;

    /// Per payer: the nonce the next signed authorisation or revocation must carry.
    mapping(address payer => uint256) public nonces;

    mapping(address payer => mapping(address agent => Session)) private _sessions;
    mapping(uint64 sessionId => mapping(bytes32 toolKey => bool)) private _allowed;

    event SessionAuthorized(
        address indexed payer,
        address indexed agent,
        uint64 indexed sessionId,
        uint256 budget,
        uint256 perCallCap,
        uint256 expiry,
        bytes32 toolsHash
    );
    event SessionRevoked(address indexed payer, address indexed agent, uint64 indexed sessionId);
    event SessionSpent(
        address indexed payer, address indexed agent, uint64 indexed sessionId, uint256 amount, uint256 remainingBudget
    );

    constructor(address router_) Eip712("SluiceAgentVault", "1") {
        if (router_ == address(0)) revert ZeroAddress();
        router = router_;
    }

    // ------------------------------------------------------------------------------------ authorise

    /// The payer authorises an agent key. The payer pays the gas.
    function authorize(Grant calldata grant, Tool[] calldata tools) external {
        _authorize(msg.sender, grant, tools);
    }

    /// The same, from the payer's EIP-712 signature, so a relayer can submit it and the payer needs no QIE.
    function authorizeBySig(
        address payer,
        Grant calldata grant,
        Tool[] calldata tools,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert Expired();
        address signer = SignatureLib.recover(_authorizeDigest(payer, grant, tools, deadline), signature);
        if (signer == address(0) || signer != payer) revert InvalidSignature();
        unchecked {
            nonces[payer] += 1;
        }
        _authorize(payer, grant, tools);
    }

    /// The EIP-712 digest of a signed authorisation. The struct hash is built in two halves to keep the
    /// stack shallow; every field is one 32-byte word, so the bytes are exactly those of one abi.encode.
    function _authorizeDigest(address payer, Grant calldata g, Tool[] calldata tools, uint256 deadline)
        private
        view
        returns (bytes32)
    {
        bytes memory head = abi.encode(AUTHORIZE_TYPEHASH, payer, g.agent, g.budget, g.perCallCap);
        bytes memory tail = abi.encode(g.expiry, _hashTools(tools), nonces[payer], deadline);
        return _hashTypedData(keccak256(bytes.concat(head, tail)));
    }

    /// The digest a payer signs to authorise a session, for the payer's current nonce.
    function hashAuthorization(address payer, Grant calldata g, Tool[] calldata tools, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _authorizeDigest(payer, g, tools, deadline);
    }

    function _authorize(address payer, Grant calldata g, Tool[] calldata tools) private {
        if (g.agent == address(0) || g.agent == payer) revert InvalidSession();
        if (g.budget == 0 || g.budget > type(uint128).max) revert InvalidSession();
        if (g.perCallCap == 0 || g.perCallCap > g.budget) revert InvalidSession();
        if (g.expiry <= block.timestamp || g.expiry > type(uint64).max) revert InvalidSession();
        if (tools.length == 0) revert EmptyToolList();
        if (tools.length > MAX_TOOLS) revert TooManyTools();

        uint64 id = ++sessionCount;
        _sessions[payer][g.agent] = Session({
            budget: uint128(g.budget),
            spent: 0,
            perCallCap: uint128(g.perCallCap),
            expiry: uint64(g.expiry),
            id: id
        });
        for (uint256 i; i < tools.length; ++i) {
            if (tools[i].payee == address(0)) revert ZeroAddress();
            _allowed[id][keccak256(abi.encode(tools[i].payee, tools[i].toolId))] = true;
        }
        emit SessionAuthorized(payer, g.agent, id, g.budget, g.perCallCap, g.expiry, _hashTools(tools));
    }

    // ---------------------------------------------------------------------------------------- revoke

    /// The payer revokes an agent. It takes effect in the same block: the next call by that agent fails.
    function revoke(address agent) external {
        _revoke(msg.sender, agent);
    }

    /// The same, from the payer's signature, so a relayer can submit it.
    function revokeBySig(address payer, address agent, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest =
            _hashTypedData(keccak256(abi.encode(REVOKE_TYPEHASH, payer, agent, nonces[payer], deadline)));
        address signer = SignatureLib.recover(digest, signature);
        if (signer == address(0) || signer != payer) revert InvalidSignature();
        unchecked {
            nonces[payer] += 1;
        }
        _revoke(payer, agent);
    }

    function _revoke(address payer, address agent) private {
        uint64 id = _sessions[payer][agent].id;
        if (id == 0) revert SessionNotFound();
        delete _sessions[payer][agent];
        emit SessionRevoked(payer, agent, id);
    }

    // -------------------------------------------------------------------------------------- consume

    /// Called by the router when an intent was signed by an agent key. If the policy allows the spend,
    /// the session's spent total goes up and the function returns zero. Otherwise it returns the
    /// selector of the error that explains why, and changes nothing.
    function consume(address payer, address agent, address payee, bytes32 toolId, uint256 amount)
        external
        returns (bytes4)
    {
        if (msg.sender != router) revert NotRouter();
        Session storage s = _sessions[payer][agent];
        uint64 id = s.id;
        if (id == 0) return SessionNotFound.selector;
        if (block.timestamp > s.expiry) return SessionExpired.selector;
        if (amount > s.perCallCap) return PerCallCapExceeded.selector;
        uint256 newSpent = uint256(s.spent) + amount;
        if (newSpent > s.budget) return BudgetExceeded.selector;
        mapping(bytes32 => bool) storage tools = _allowed[id];
        if (!tools[keccak256(abi.encode(payee, toolId))] && !tools[keccak256(abi.encode(payee, bytes32(0)))]) {
            return ToolNotAllowed.selector;
        }
        s.spent = uint128(newSpent);
        emit SessionSpent(payer, agent, id, amount, uint256(s.budget) - newSpent);
        return bytes4(0);
    }

    // ----------------------------------------------------------------------------------------- views

    function sessionOf(address payer, address agent) external view returns (Session memory) {
        return _sessions[payer][agent];
    }

    function remainingBudget(address payer, address agent) external view returns (uint256) {
        Session storage s = _sessions[payer][agent];
        return s.id == 0 ? 0 : uint256(s.budget) - s.spent;
    }

    function isToolAllowed(address payer, address agent, address payee, bytes32 toolId) external view returns (bool) {
        uint64 id = _sessions[payer][agent].id;
        if (id == 0) return false;
        return _allowed[id][keccak256(abi.encode(payee, toolId))] || _allowed[id][keccak256(abi.encode(payee, bytes32(0)))];
    }

    /// The EIP-712 hash of a tool list, as a signed authorisation commits to it.
    function hashTools(Tool[] calldata tools) external pure returns (bytes32) {
        return _hashTools(tools);
    }

    function _hashTools(Tool[] calldata tools) private pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](tools.length);
        for (uint256 i; i < tools.length; ++i) {
            hashes[i] = keccak256(abi.encode(TOOL_TYPEHASH, tools[i].payee, tools[i].toolId));
        }
        return keccak256(abi.encodePacked(hashes));
    }
}
