# stacksKey

`stacksKey` is a deterministic smart-account system that lets a user prove control of a Stacks key, derive a matching Ethereum smart account, deploy it on Sepolia, and execute transactions from it without exposing a private key to Ethereum.

The current implementation is an MVP, but it is a real end-to-end system:

- real Stacks wallet connect
- real `stx_signMessage`
- real local Stacks signature verification
- real Noir circuit execution
- real UltraHonk proof generation
- real onchain verifier usage
- real deterministic account derivation with `CREATE2`
- real relayed deployment and execution on Sepolia

---

## Table of Contents

1. [What the Project Does](#what-the-project-does)
2. [Why It Exists](#why-it-exists)
3. [High-Level Architecture](#high-level-architecture)
4. [How the Flow Works](#how-the-flow-works)
5. [Deterministic Address Derivation](#deterministic-address-derivation)
6. [How Proof Generation Works](#how-proof-generation-works)
7. [Contract Structure and Interaction](#contract-structure-and-interaction)
8. [Project Structure](#project-structure)
9. [Deployed Sepolia Contracts](#deployed-sepolia-contracts)
10. [Environment Variables](#environment-variables)
11. [Local Development](#local-development)
12. [Vercel Deployment](#vercel-deployment)
13. [Using the Application](#using-the-application)
14. [Code Snippets](#code-snippets)
15. [Current Limitations](#current-limitations)
16. [Future Improvements](#future-improvements)

---

## What the Project Does

`stacksKey` binds a Stacks secp256k1 key to a deterministic Ethereum smart account.

The user:

1. connects a Stacks wallet
2. signs an authentication message
3. proves in zero knowledge that the signature is valid for the Stacks public key
4. derives a deterministic Ethereum smart-account address from that Stacks key
5. deploys the account on Sepolia through a relayer
6. executes actions from that account using a proof instead of an Ethereum private key

This means the Ethereum account identity comes from the Stacks key material, not from an EOA private key generated on Ethereum.

---

## Why It Exists

The goal is to make a Stacks-controlled identity usable on Ethereum-compatible chains.

Instead of asking the user to:

- generate a new Ethereum private key
- manage another wallet
- bridge identity manually across chains

`stacksKey` lets the user reuse the Stacks signing key as the root identity and derive a deterministic smart account on Ethereum.

---

## High-Level Architecture

```text
+--------------------+        +-----------------------+
| Stacks Wallet      |        | Next.js Frontend      |
| (Leather/Xverse)   |        | + API routes          |
+---------+----------+        +-----------+-----------+
          |                               |
          | connect + sign message        |
          v                               |
   compressed pubkey + signature          |
          |                               |
          +------------------------------>|
                                          |
                                          | local Stacks verification
                                          | Noir circuit execution
                                          | UltraHonk proof generation
                                          v
                              proof + public inputs + salt
                                          |
                                          | derive CREATE2 address
                                          | relay txs
                                          v
                           +--------------+---------------+
                           | Sepolia                      |
                           | - HonkVerifier               |
                           | - StackKeyFactory            |
                           | - StackKeyAccount            |
                           +------------------------------+
```

---

## How the Flow Works

### 1. Connect a Stacks wallet

The frontend requests Stacks addresses from the wallet and selects the Stacks account entry whose address starts with `S` and whose `publicKey` is a compressed secp256k1 key.

This is important because some wallet APIs return both BTC and STX-related entries. `stacksKey` must bind itself to the Stacks key, not a Bitcoin payment key.

### 2. Build the authentication message

The app creates a JSON payload containing:

- `domain`
- `nonce`
- `expiry`
- `action`
- `chainId`

Example:

```json
{
  "domain": "stackkey",
  "nonce": 1516194150,
  "expiry": 1774020158,
  "action": "authenticate",
  "chainId": 11155111
}
```

### 3. Ask the wallet to sign the message

The wallet signs the message via `stx_signMessage`.

### 4. Verify the signature locally

Before generating a proof, the app verifies the Stacks signature locally. This avoids wasting proving time on invalid or mismatched signatures.

### 5. Generate a ZK proof

The backend:

- loads the Noir circuit
- compiles it
- executes the witness generation
- generates an UltraHonk proof
- verifies that proof before returning it

### 6. Derive the deterministic account address

The frontend calls `StackKeyFactory.getAddress(circuitSalt, verifierAddress)`.

That gives the counterfactual account address before deployment.

### 7. Deploy through the relayer

The frontend calls `/api/relay/deploy`.

The server-side relayer wallet:

- pays Sepolia gas
- calls `StackKeyFactory.createAccount(...)`
- deploys the account at the predicted `CREATE2` address

### 8. Execute actions through the smart account

The frontend can relay:

- ETH sends
- ERC-20 transfers
- arbitrary contract calls

The server-side relayer calls:

```solidity
executeWithProof(proof, signals, target, callData, value)
```

The account verifies the proof onchain, consumes the nonce, and performs the call.

---

## Deterministic Address Derivation

This is one of the most important ideas in the project.

The Ethereum account is deterministic because it is derived from stable inputs:

- the Stacks public key
- the protocol domain tag
- the target chain id
- the protocol version
- the factory contract address
- the verifier contract address
- the `StackKeyAccount` init code

The derivation happens in two layers.

### Layer 1: circuit salt

Inside the Noir circuit, the public key is converted into fields and hashed:

```rust
let salt = pedersen_hash([x_felt, y_felt, DOMAIN_TAG, chain_id, PROTOCOL_VERSION]);
```

That `salt` is deterministic for:

- the same Stacks public key
- the same chain id
- the same protocol version/domain tag

It changes if any of those change.

### Layer 2: `CREATE2` address

Inside `StackKeyFactory`, the final address is derived with `CREATE2`:

```solidity
bytes32 create2Salt = keccak256(abi.encode(circuitSalt));
bytes32 initCodeHash = keccak256(
    abi.encodePacked(type(StackKeyAccount).creationCode, abi.encode(circuitSalt, verifierAddress))
);
```

Then:

```solidity
predicted = address(
    uint160(
        uint256(
            keccak256(abi.encodePacked(bytes1(0xff), address(this), create2Salt, initCodeHash))
        )
    )
);
```

### Why it is deterministic

For the same:

- factory address
- verifier address
- circuit salt
- account bytecode

the resulting account address is always the same.

### What this means in practice

- same Stacks key + same chain + same deployment config => same smart account address
- different Stacks key => different smart account address
- different verifier/factory deployment => different derived address
- different chain id inside the circuit salt => different derived address

---

## How Proof Generation Works

Proof generation is performed in the Next.js API route:

- [prove route](C:\Users\singa\Downloads\stacks-key\frontend\src\app\api\prove\route.ts)

### Inputs to the circuit

The prover receives:

- `pubkey_x`
- `pubkey_y`
- `sig_r`
- `sig_s`
- `message_hash`
- `nonce`
- `expiry`
- `chain_id`

### Circuit behavior

The Noir circuit:

1. reconstructs the secp256k1 signature from `r` and `s`
2. verifies the ECDSA signature against the public key and message hash
3. derives the deterministic salt using Pedersen hash
4. outputs public values needed onchain

### Public outputs

The current proof layout contains `40` public inputs in total.

The important values are:

- message hash bytes
- nonce
- expiry
- chain id
- derived salt
- message hash as a field
- repeated public outputs used for onchain consistency checks

### Proof system

The implementation currently uses:

- Noir
- `@aztec/bb.js`
- UltraHonk with Keccak transcript

### Proof generation diagram

```text
input:
  pubkey_x, pubkey_y
  sig_r, sig_s
  message_hash
  nonce, expiry, chain_id

        |
        v
+-----------------------------+
| Noir circuit                |
| - verify secp256k1 sig      |
| - derive salt               |
| - expose public outputs     |
+-------------+---------------+
              |
              v
+-----------------------------+
| UltraHonk backend           |
| - generateProof()           |
| - verifyProof()             |
+-------------+---------------+
              |
              v
  proof + publicInputs + salt
```

---

## Contract Structure and Interaction

The onchain system currently has three relevant components.

### 1. `HonkVerifier`

This is the generated verifier contract used to validate the Noir/UltraHonk proof onchain.

Role:

- receives the proof
- receives the public inputs
- returns whether the proof is valid

Interface:

- [IStackKeyVerifier.sol](C:\Users\singa\Downloads\stacks-key\contracts\contracts\IStackKeyVerifier.sol)

### 2. `StackKeyFactory`

File:

- [StackKeyFactory.sol](C:\Users\singa\Downloads\stacks-key\contracts\contracts\StackKeyFactory.sol)

Role:

- predicts the smart-account address
- deploys the account with `CREATE2`

Key functions:

- `getAddress(bytes32 circuitSalt, address verifierAddress)`
- `createAccount(bytes32 circuitSalt, address verifierAddress)`

### 3. `StackKeyAccount`

File:

- [StackKeyAccount.sol](C:\Users\singa\Downloads\stacks-key\contracts\contracts\StackKeyAccount.sol)

Role:

- stores the deterministic salt
- stores the verifier address
- prevents nonce replay
- validates proofs
- executes external calls after proof verification

Key checks performed onchain:

- public input length is correct
- proof salt matches account salt
- nonce input matches nonce output
- expiry input matches expiry output
- chain id input matches chain id output
- chain id equals `block.chainid`
- proof has not expired
- nonce was not already used
- verifier returns `true`

Only after all of those checks pass does the account perform:

```solidity
target.call{value: value}(callData);
```

### Contract interaction diagram

```text
User proof
   |
   v
StackKeyAccount.executeWithProof(...)
   |
   +--> validate public inputs
   +--> check salt
   +--> check chain id
   +--> check expiry
   +--> check nonce replay
   +--> verifier.verify(proof, signals)
   |
   v
target.call(callData, value)
```

---

## Project Structure

```text
stacks-key/
|
+-- circuits/
|   +-- stackkey_auth/
|       +-- src/main.nr
|
+-- contracts/
|   +-- contracts/
|   |   +-- IStackKeyVerifier.sol
|   |   +-- StackKeyAccount.sol
|   |   +-- StackKeyFactory.sol
|   |   +-- StackKeyVerifier.sol
|   +-- scripts/
|       +-- deploy.ts
|       +-- generateVerifier.mjs
|
+-- frontend/
|   +-- circuits/
|   |   +-- stackkey_auth/
|   +-- src/app/
|   |   +-- api/prove/route.ts
|   |   +-- api/relay/deploy/route.ts
|   |   +-- api/relay/execute/route.ts
|   |   +-- page.tsx
|   +-- src/lib/
|       +-- constants.ts
|       +-- message.ts
|       +-- signature.ts
|
+-- package.json
+-- README.md
```

Notes:

- `circuits/` is the canonical circuit source used by the contracts/tooling
- `frontend/circuits/` exists so the Vercel/Next.js prover route can compile the circuit inside the frontend deployment boundary

---

## Deployed Sepolia Contracts

These are the currently configured Sepolia addresses from the frontend environment:

- `StackKeyFactory`: `0xDE071191f5E6Ff7D87eA10418a698c95ebA2954B`
- `HonkVerifier`: `0x25B9D03fD2FBF54B09afb94C323F3A4350E2CaE4`

These values are read from:

- [frontend/.env.local](C:\Users\singa\Downloads\stacks-key\frontend\.env.local)

If you redeploy contracts, update:

- `NEXT_PUBLIC_FACTORY_ADDRESS`
- `NEXT_PUBLIC_VERIFIER_ADDRESS`

---

## Environment Variables

Frontend public vars:

```env
NEXT_PUBLIC_SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
NEXT_PUBLIC_FACTORY_ADDRESS=0x...
NEXT_PUBLIC_VERIFIER_ADDRESS=0x...
```

Server-only relayer var:

```env
RELAYER_PRIVATE_KEY=0x...
```

Important:

- `RELAYER_PRIVATE_KEY` must never be exposed in `NEXT_PUBLIC_*`
- on Vercel, add it as a normal server environment variable

Example file:

- [frontend/.env.local.example](C:\Users\singa\Downloads\stacks-key\frontend\.env.local.example)

---

## Local Development

### Install dependencies

```bash
npm install
```

### Frontend env

Create:

```text
frontend/.env.local
```

Fill in:

```env
NEXT_PUBLIC_SEPOLIA_RPC_URL=...
NEXT_PUBLIC_FACTORY_ADDRESS=...
NEXT_PUBLIC_VERIFIER_ADDRESS=...
RELAYER_PRIVATE_KEY=...
```

### Generate verifier and deploy contracts

```bash
cd contracts
npm run generate:verifier
npx hardhat compile
npx hardhat run scripts/deploy.ts --network sepolia
```

### Run the frontend

```bash
cd frontend
npm run dev
```

Open:

```text
http://localhost:3000
```

---

## Vercel Deployment

### Recommended setup

Project root:

- `frontend`

Node version:

- `20.x`

Required environment variables:

- `NEXT_PUBLIC_SEPOLIA_RPC_URL`
- `NEXT_PUBLIC_FACTORY_ADDRESS`
- `NEXT_PUBLIC_VERIFIER_ADDRESS`
- `RELAYER_PRIVATE_KEY`

### Why the circuit is duplicated under `frontend/`

Vercel deploys the frontend project boundary, so the proving route must be able to load the Noir circuit from inside the frontend app directory. That is why the route reads:

```ts
const circuitRoot = join(process.cwd(), "circuits", "stackkey_auth");
```

inside:

- [prove route](C:\Users\singa\Downloads\stacks-key\frontend\src\app\api\prove\route.ts)

### Important operational note

Proof generation is real and happens inside the API route. That is heavier than a normal web request.

For demos, this is acceptable.

For production, a dedicated prover service is a better architecture.

---

## Using the Application

### User flow

1. Connect a Stacks wallet.
2. Sign the auth message.
3. Wait for local signature verification.
4. Wait for proof generation.
5. Review the derived counterfactual account.
6. Deploy the account through the relayer.
7. Use the account through relayed actions.

### Supported demo actions

- Send ETH
- ERC-20 transfer
- Custom contract call

### Important behavior

Each proof is single-use for onchain execution because the nonce is consumed by the smart account.

So the flow is:

```text
proof #1 -> one successful onchain action
proof #2 -> next onchain action
proof #3 -> next onchain action
```

---

## Code Snippets

### Noir circuit salt derivation

```rust
let x_felt = bytes32_to_field(pubkey_x);
let y_felt = bytes32_to_field(pubkey_y);
let salt = pedersen_hash([x_felt, y_felt, DOMAIN_TAG, chain_id, PROTOCOL_VERSION]);
```

Source:

- [main.nr](C:\Users\singa\Downloads\stacks-key\circuits\stackkey_auth\src\main.nr)

### Factory address prediction

```solidity
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
```

Source:

- [StackKeyFactory.sol](C:\Users\singa\Downloads\stacks-key\contracts\contracts\StackKeyFactory.sol)

### Onchain proof enforcement

```solidity
if (signals[SALT_OUTPUT_INDEX] != publicKeySalt) revert SaltMismatch();
if (uint256(signals[CHAIN_ID_INPUT_INDEX]) != block.chainid) revert ChainIdMismatch();
if (uint256(signals[EXPIRY_INPUT_INDEX]) <= block.timestamp) revert ProofExpired();
if (usedNonces[nonce]) revert NonceReplayed();
if (!verifier.verify(proof, signals)) revert InvalidProof();
```

Source:

- [StackKeyAccount.sol](C:\Users\singa\Downloads\stacks-key\contracts\contracts\StackKeyAccount.sol)

### Proof generation on the backend

```ts
const { witness } = await noir.execute({
  pubkey_x: Array.from(pubkeyX),
  pubkey_y: Array.from(pubkeyY),
  sig_r: Array.from(sigR),
  sig_s: Array.from(sigS),
  message_hash: Array.from(messageHash),
  nonce: body.nonce.toString(),
  expiry: body.expiry.toString(),
  chain_id: body.chainId.toString(),
});

const proofData = await backend.generateProof(witness, HONK_PROOF_OPTIONS);
const verified = await backend.verifyProof(proofData, HONK_PROOF_OPTIONS);
```

Source:

- [prove route](C:\Users\singa\Downloads\stacks-key\frontend\src\app\api\prove\route.ts)

### Relayed deployment

```ts
const tx = await factory.getFunction("createAccount")(body.salt, verifierAddress);
```

Source:

- [deploy relay route](C:\Users\singa\Downloads\stacks-key\frontend\src\app\api\relay\deploy\route.ts)

### Relayed execution

```ts
const tx = await account.getFunction("executeWithProof")(
  body.proof,
  body.publicInputs,
  ethers.getAddress(body.target),
  body.callData,
  value
);
```

Source:

- [execute relay route](C:\Users\singa\Downloads\stacks-key\frontend\src\app\api\relay\execute\route.ts)

---

## Current Limitations

- proof generation happens inside the web app backend and is heavy
- account execution uses a custom smart-account flow, not ERC-4337 yet
- proofs are single-use because nonce replay protection is enforced
- relayer sponsorship is centralized right now
- ERC-20 demo assumes `18` decimals in the UI
- supported wallet behavior still depends on Stacks Connect compatibility

---

## Future Improvements

### 1. SDK

Create a dedicated `stacksKey` SDK for:

- deterministic address derivation
- proof request helpers
- relayer integration
- account execution helpers
- frontend hooks for React/Next.js

Possible packages:

- `@stackskey/sdk`
- `@stackskey/react`
- `@stackskey/contracts`

### 2. Deterministic ETH address tooling

Ship utilities that let integrators derive the Ethereum account address locally from:

- Stacks public key
- chain id
- verifier address
- factory address

without having to run the whole app UI.

### 3. More chain support

Expand beyond Sepolia to:

- Ethereum mainnet
- Base
- Arbitrum
- Optimism
- Polygon
- other EVM chains

This mostly requires:

- chain-aware deployment config
- chain-specific relayers
- circuit/UX support for multiple target chain ids

### 4. Wallet integrations

Add first-class integration layers for:

- Leather
- Xverse
- other Stacks-compatible wallets

Potentially also:

- wallet-specific account selection hints
- session state hydration
- better wallet capability detection

### 5. ERC-4337 support

Move from a custom execution path to a more standard account abstraction flow.

That would allow:

- bundler integration
- paymasters
- wallet-like UX
- richer dapp interoperability

### 6. ERC support expansion

Add richer standards support, especially:

- ERC-20 metadata-aware transfers
- ERC-721 transfers
- ERC-1155 transfers
- permit flows where applicable
- approval management
- session-based permissions

### 7. Better relayer architecture

Upgrade from a simple server relayer to:

- policy engine
- rate limits
- replay monitoring
- sponsorship quotas
- usage analytics
- multi-relayer failover

### 8. Better proving architecture

Move proving into a dedicated service with:

- cached circuit artifacts
- proof queues
- concurrency management
- artifact versioning
- faster warm starts

---

## Summary

`stacksKey` is a real deterministic cross-chain identity prototype:

- the Stacks key is the root identity
- a proof attests that the user controls that key
- the proof deterministically maps to a smart account on Ethereum
- the smart account can be deployed and used on Sepolia
- a relayer can sponsor deployment and transaction gas

It is already a useful MVP for demos and experimentation, and it has a clear path toward SDKs, wallet integrations, deterministic multi-chain account support, and fuller ERC / ERC-4337 compatibility.
