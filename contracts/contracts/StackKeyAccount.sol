// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IStackKeyVerifier.sol";

contract StackKeyAccount {
    uint256 private constant NONCE_INPUT_INDEX = 32;
    uint256 private constant EXPIRY_INPUT_INDEX = 33;
    uint256 private constant CHAIN_ID_INPUT_INDEX = 34;
    uint256 private constant SALT_OUTPUT_INDEX = 35;
    uint256 private constant MESSAGE_HASH_FELT_OUTPUT_INDEX = 36;
    uint256 private constant NONCE_OUTPUT_INDEX = 37;
    uint256 private constant EXPIRY_OUTPUT_INDEX = 38;
    uint256 private constant CHAIN_ID_OUTPUT_INDEX = 39;
    uint256 private constant EXPECTED_PUBLIC_INPUTS = 40;

    bytes32 public immutable publicKeySalt;
    IStackKeyVerifier public immutable verifier;

    mapping(uint256 => bool) public usedNonces;

    event Executed(address indexed target, uint256 value, bool success);
    event ProofVerified(bytes32 indexed salt, uint256 indexed nonce);

    error SaltMismatch();
    error ChainIdMismatch();
    error ProofExpired();
    error NonceReplayed();
    error InvalidProof();
    error CallFailed();

    constructor(bytes32 salt_, address verifier_) {
        publicKeySalt = salt_;
        verifier = IStackKeyVerifier(verifier_);
    }

    receive() external payable {}

    function _validateAndConsume(bytes memory proof, bytes32[] memory signals) internal {
        if (signals.length != EXPECTED_PUBLIC_INPUTS) revert InvalidProof();
        if (signals[SALT_OUTPUT_INDEX] != publicKeySalt) revert SaltMismatch();
        if (signals[NONCE_INPUT_INDEX] != signals[NONCE_OUTPUT_INDEX]) revert InvalidProof();
        if (signals[EXPIRY_INPUT_INDEX] != signals[EXPIRY_OUTPUT_INDEX]) revert InvalidProof();
        if (signals[CHAIN_ID_INPUT_INDEX] != signals[CHAIN_ID_OUTPUT_INDEX]) revert InvalidProof();
        if (uint256(signals[CHAIN_ID_INPUT_INDEX]) != block.chainid) revert ChainIdMismatch();
        if (uint256(signals[EXPIRY_INPUT_INDEX]) <= block.timestamp) revert ProofExpired();

        uint256 nonce = uint256(signals[NONCE_INPUT_INDEX]);
        if (usedNonces[nonce]) revert NonceReplayed();
        if (!verifier.verify(proof, signals)) revert InvalidProof();

        usedNonces[nonce] = true;
        emit ProofVerified(signals[SALT_OUTPUT_INDEX], nonce);
    }

    function executeWithProof(
        bytes calldata proof,
        bytes32[] calldata signals,
        address target,
        bytes calldata callData,
        uint256 value
    ) external payable {
        _validateAndConsume(proof, signals);
        (bool ok, ) = target.call{value: value}(callData);
        emit Executed(target, value, ok);
        if (!ok) revert CallFailed();
    }
}
