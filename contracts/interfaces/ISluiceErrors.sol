// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Every custom error in Sluice, declared once. The router and the agent vault both inherit this, so
/// the router's ABI can name an error that the vault reports (the router passes the vault's error code
/// through unchanged).
interface ISluiceErrors {
    // Shared
    error ZeroAddress();
    error ZeroAmount();
    error Expired();
    error InvalidSignature();

    // Router
    error NotOwner();
    error FeeTooHigh();
    error Reentrancy();
    error NonceAlreadyUsed();
    error InsufficientBalance();
    error UnexpectedTransferAmount();
    error TransferFailed();
    error RelayerFeeTooHigh();
    error ArrayLengthMismatch();
    error EmptyBatch();
    error InvalidPayee();

    // Agent vault
    error NotRouter();
    error InvalidSession();
    error EmptyToolList();
    error TooManyTools();
    error SessionNotFound();
    error SessionExpired();
    error PerCallCapExceeded();
    error BudgetExceeded();
    error ToolNotAllowed();
}
