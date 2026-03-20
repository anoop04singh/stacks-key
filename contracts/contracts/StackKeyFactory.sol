// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./StackKeyAccount.sol";

contract StackKeyFactory {
    event AccountDeployed(address indexed account, bytes32 indexed circuitSalt);

    function getAddress(bytes32 circuitSalt, address verifierAddress) public view returns (address predicted) {
        bytes32 create2Salt = keccak256(abi.encode(circuitSalt));
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(StackKeyAccount).creationCode, abi.encode(circuitSalt, verifierAddress))
        );

        predicted = address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), create2Salt, initCodeHash))
                )
            )
        );
    }

    function createAccount(bytes32 circuitSalt, address verifierAddress) external returns (address account) {
        address predicted = getAddress(circuitSalt, verifierAddress);
        if (predicted.code.length > 0) {
            return predicted;
        }

        bytes32 create2Salt = keccak256(abi.encode(circuitSalt));
        account = address(new StackKeyAccount{salt: create2Salt}(circuitSalt, verifierAddress));
        emit AccountDeployed(account, circuitSalt);
    }
}
