// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {ISluiceErrors} from "./interfaces/ISluiceErrors.sol";
import {Eip712} from "./base/Eip712.sol";
import {SignatureLib} from "./libraries/SignatureLib.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";
import {AgentVault} from "./AgentVault.sol";

/// Pay-per-use settlement for AI tools and APIs, in one ERC-20 (QUSDC on QIE).
///
///   payer  --deposit-->  prepaid balance  --signed intent-->  builder earnings  --withdraw-->  builder
///                              |                                    |
///                              +--refund (any time)--> payer        +--fee (capped)--> fee recipient's earnings
///
/// A payer deposits once (approve, then deposit). After that each call is an EIP-712 intent, signed
/// off-chain by the payer or by an agent key the payer authorised, and settled on-chain by anyone.
///
/// What the contract guarantees, and what the tests pin:
///   - It is immutable: no proxy, no upgrade, no pause, no delegatecall, no selfdestruct.
///   - The owner can change the fee (never above MAX_FEE_BPS) and the fee recipient. That is all.
///     No function lets the owner, or anyone else, move a user's balance.
///   - A payer can refund their unspent balance, and a builder can withdraw their earnings, at any
///     time, with no delay. Either can do it through a relayer with a signature, so neither needs QIE.
///   - Every signed message is bound to this chain and this contract, expires, and can be used once.
///   - Token balance held by the router is never below what it owes (totalLiabilities) unless the token
///     itself burns the router's balance, which the token's admin can do. docs/RISKS.md says so.
contract PaymentRouter is Eip712, ISluiceErrors {
    using SafeTransfer for IERC20;

    /// The fee can never be set above 2%.
    uint16 public constant MAX_FEE_BPS = 200;
    uint256 private constant BPS = 10_000;

    /// A payment a payer (or the payer's agent key) agreed to, signed off-chain.
    struct Intent {
        address payer; // whose prepaid balance pays
        address payee; // the builder who is paid
        uint256 amount; // in token units (QUSDC has 6 decimals)
        bytes32 toolId; // which tool the call was for
        bytes32 nonce; // chosen by the signer, never reused
        uint256 deadline; // unix seconds, after which the intent is dead
    }

    bytes32 public constant PAYMENT_TYPEHASH = keccak256(
        "Payment(address payer,address payee,uint256 amount,bytes32 toolId,bytes32 nonce,uint256 deadline)"
    );
    bytes32 public constant WITHDRAW_TYPEHASH = keccak256(
        "Withdraw(address account,address to,uint256 amount,uint256 relayerFee,bytes32 nonce,uint256 deadline)"
    );
    bytes32 public constant REFUND_TYPEHASH = keccak256(
        "Refund(address payer,address to,uint256 amount,uint256 relayerFee,bytes32 nonce,uint256 deadline)"
    );

    /// The token the router holds (QUSDC).
    IERC20 public immutable token;
    /// The agent policy contract, created by this router. Only this router can spend a session.
    AgentVault public immutable vault;
    /// May change the fee (within the cap) and the fee recipient. Cannot be changed or removed.
    address public immutable owner;

    address public feeRecipient;
    uint16 public feeBps;

    /// Everything the router owes: all payer balances plus all builder earnings.
    uint256 public totalLiabilities;
    mapping(address payer => uint256) public payerBalance;
    mapping(address builder => uint256) public earnings;
    mapping(address signer => mapping(bytes32 nonce => bool)) public nonceUsed;

    uint256 private _status = 1;

    event Deposited(address indexed account, address indexed from, uint256 amount);
    event Settled(
        address indexed payer,
        address indexed payee,
        bytes32 indexed toolId,
        uint256 amount,
        uint256 fee,
        bytes32 nonce,
        address signer
    );
    event SettleSkipped(uint256 indexed index, address indexed payer, bytes32 nonce, bytes4 reason);
    /// `amount` is what left the builder's earnings. `relayerFee` of it went to `relayer`, the rest to `to`.
    event Withdrawn(address indexed account, address indexed to, uint256 amount, address relayer, uint256 relayerFee);
    event Refunded(address indexed payer, address indexed to, uint256 amount, address relayer, uint256 relayerFee);
    event NonceCancelled(address indexed signer, bytes32 nonce);
    event FeeChanged(uint16 oldBps, uint16 newBps);
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);

    modifier nonReentrant() {
        if (_status == 2) revert Reentrancy();
        _status = 2;
        _;
        _status = 1;
    }

    constructor(IERC20 token_, address owner_, address feeRecipient_, uint16 feeBps_)
        Eip712("SluiceRouter", "1")
    {
        if (address(token_) == address(0) || owner_ == address(0) || feeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        token = token_;
        owner = owner_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        vault = new AgentVault(address(this));
    }

    // ------------------------------------------------------------------------------------- deposit

    /// Adds tokens to the caller's prepaid balance. The caller must have approved this router first.
    function deposit(uint256 amount) external nonReentrant {
        _deposit(msg.sender, amount);
    }

    /// Adds tokens, from the caller's wallet, to someone else's prepaid balance.
    function depositFor(address account, uint256 amount) external nonReentrant {
        if (account == address(0)) revert ZeroAddress();
        _deposit(account, amount);
    }

    function _deposit(address account, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        // A token that delivers less than asked would break the accounting, so it is refused.
        if (token.balanceOf(address(this)) - before != amount) revert UnexpectedTransferAmount();
        payerBalance[account] += amount;
        totalLiabilities += amount;
        emit Deposited(account, msg.sender, amount);
    }

    // -------------------------------------------------------------------------------------- settle

    /// Settles one signed intent. Anyone may call it; the facilitator that submits it pays the gas.
    /// It reverts with the reason if the intent cannot be settled.
    function settle(Intent calldata intent, bytes calldata signature) external {
        bytes4 reason = _settleOne(intent, signature);
        if (reason != bytes4(0)) _revertWith(reason);
    }

    /// Settles many signed intents in one transaction. An intent that cannot be settled (expired, used,
    /// unaffordable, outside an agent's policy) is skipped and reported in a SettleSkipped event, so one
    /// bad intent cannot make the facilitator lose the whole batch. Returns how many were settled.
    function batchSettle(Intent[] calldata intents, bytes[] calldata signatures) external returns (uint256 settled) {
        uint256 n = intents.length;
        if (n == 0) revert EmptyBatch();
        if (n != signatures.length) revert ArrayLengthMismatch();
        for (uint256 i; i < n; ++i) {
            bytes4 reason = _settleOne(intents[i], signatures[i]);
            if (reason == bytes4(0)) {
                ++settled;
            } else {
                emit SettleSkipped(i, intents[i].payer, intents[i].nonce, reason);
            }
        }
    }

    function _settleOne(Intent calldata i, bytes calldata signature) private returns (bytes4) {
        if (i.amount == 0) return ZeroAmount.selector;
        if (i.payee == address(0) || i.payee == address(this)) return InvalidPayee.selector;
        if (block.timestamp > i.deadline) return Expired.selector;
        if (nonceUsed[i.payer][i.nonce]) return NonceAlreadyUsed.selector;

        address signer = SignatureLib.recover(_hashTypedData(_hashIntent(i)), signature);
        if (signer == address(0)) return InvalidSignature.selector;

        uint256 balance = payerBalance[i.payer];
        if (balance < i.amount) return InsufficientBalance.selector;

        // Signed by the payer: no policy. Signed by anyone else: that signer must hold a live session
        // from the payer that allows this exact spend. The vault changes nothing unless it allows it.
        if (signer != i.payer) {
            bytes4 denied = vault.consume(i.payer, signer, i.payee, i.toolId, i.amount);
            if (denied != bytes4(0)) return denied;
        }

        nonceUsed[i.payer][i.nonce] = true;
        payerBalance[i.payer] = balance - i.amount;
        // The fee comes out of the builder's side. The payer always pays exactly `amount`.
        uint256 fee = (i.amount * feeBps) / BPS;
        earnings[i.payee] += i.amount - fee;
        if (fee != 0) earnings[feeRecipient] += fee;
        emit Settled(i.payer, i.payee, i.toolId, i.amount, fee, i.nonce, signer);
        return bytes4(0);
    }

    function _hashIntent(Intent calldata i) private pure returns (bytes32) {
        return keccak256(abi.encode(PAYMENT_TYPEHASH, i.payer, i.payee, i.amount, i.toolId, i.nonce, i.deadline));
    }

    /// A signer cancels a nonce they have not used yet, which kills any intent signed with it.
    function cancelNonce(bytes32 nonce) external {
        nonceUsed[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    // ------------------------------------------------------------------------ withdraw and refund

    /// A builder withdraws earnings. No delay, no approval.
    function withdraw(uint256 amount, address to) external nonReentrant {
        _debit(earnings, msg.sender, amount);
        _payOut(to, amount, 0);
        emit Withdrawn(msg.sender, to, amount, address(0), 0);
    }

    /// A builder withdraws through a relayer. The builder signs; the relayer submits and pays the gas, and
    /// is paid `relayerFee` out of the withdrawal, an amount the builder chose in the signature.
    function withdrawBySig(
        address account,
        address to,
        uint256 amount,
        uint256 relayerFee,
        bytes32 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (relayerFee > amount) revert RelayerFeeTooHigh();
        _useSignedRequest(
            account,
            nonce,
            deadline,
            keccak256(abi.encode(WITHDRAW_TYPEHASH, account, to, amount, relayerFee, nonce, deadline)),
            signature
        );
        _debit(earnings, account, amount);
        _payOut(to, amount, relayerFee);
        emit Withdrawn(account, to, amount, msg.sender, relayerFee);
    }

    /// A payer takes back unspent prepaid balance. No delay, no approval, whatever else is outstanding.
    function refund(uint256 amount, address to) external nonReentrant {
        _debit(payerBalance, msg.sender, amount);
        _payOut(to, amount, 0);
        emit Refunded(msg.sender, to, amount, address(0), 0);
    }

    /// A payer refunds through a relayer, the same way a builder withdraws through one.
    function refundBySig(
        address payer,
        address to,
        uint256 amount,
        uint256 relayerFee,
        bytes32 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (relayerFee > amount) revert RelayerFeeTooHigh();
        _useSignedRequest(
            payer,
            nonce,
            deadline,
            keccak256(abi.encode(REFUND_TYPEHASH, payer, to, amount, relayerFee, nonce, deadline)),
            signature
        );
        _debit(payerBalance, payer, amount);
        _payOut(to, amount, relayerFee);
        emit Refunded(payer, to, amount, msg.sender, relayerFee);
    }

    /// Checks a signed withdraw or refund request and burns its nonce.
    function _useSignedRequest(
        address signerExpected,
        bytes32 nonce,
        uint256 deadline,
        bytes32 structHash,
        bytes calldata signature
    ) private {
        if (block.timestamp > deadline) revert Expired();
        if (nonceUsed[signerExpected][nonce]) revert NonceAlreadyUsed();
        address signer = SignatureLib.recover(_hashTypedData(structHash), signature);
        if (signer == address(0) || signer != signerExpected) revert InvalidSignature();
        nonceUsed[signerExpected][nonce] = true;
    }

    function _debit(mapping(address => uint256) storage book, address account, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        uint256 balance = book[account];
        if (balance < amount) revert InsufficientBalance();
        book[account] = balance - amount;
        totalLiabilities -= amount;
    }

    function _payOut(address to, uint256 amount, uint256 relayerFee) private {
        if (to == address(0)) revert ZeroAddress();
        if (relayerFee > amount) revert RelayerFeeTooHigh();
        uint256 toAccount = amount - relayerFee;
        if (toAccount != 0) token.safeTransfer(to, toAccount);
        if (relayerFee != 0) token.safeTransfer(msg.sender, relayerFee);
    }

    // ------------------------------------------------------------------------------- owner powers

    /// The owner can change the fee, never above MAX_FEE_BPS. It applies to settlements after this call
    /// and changes nothing about what a payer pays.
    function setFee(uint16 newFeeBps) external {
        if (msg.sender != owner) revert NotOwner();
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeChanged(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    /// The owner can change who the fee is credited to. Fees already credited stay with their holder.
    function setFeeRecipient(address newRecipient) external {
        if (msg.sender != owner) revert NotOwner();
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientChanged(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    // ----------------------------------------------------------------------------------------- views

    /// The token the router holds against what it owes. `held` is below `owed` only if the token
    /// itself burned or removed tokens from the router.
    function solvency() external view returns (uint256 held, uint256 owed) {
        return (token.balanceOf(address(this)), totalLiabilities);
    }

    /// The EIP-712 digest a payer or agent signs for an intent.
    function hashPayment(Intent calldata intent) external view returns (bytes32) {
        return _hashTypedData(_hashIntent(intent));
    }

    function _revertWith(bytes4 reason) private pure {
        assembly {
            mstore(0, reason)
            revert(0, 4)
        }
    }
}
