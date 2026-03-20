export const DOMAIN = "stackkey";
export const ACTION = "authenticate";
export const PROTOCOL_VERSION = 1;
export const SEPOLIA_CHAIN_ID = 11155111;
export const DEFAULT_EXPIRY_WINDOW_SECONDS = 5 * 60;
export const HONK_PROOF_OPTIONS = { keccak: true } as const;

export const PUBLIC_INPUT_LAYOUT = {
  messageHashStart: 0,
  messageHashEnd: 31,
  nonceInput: 32,
  expiryInput: 33,
  chainIdInput: 34,
  saltOutput: 35,
  messageHashFeltOutput: 36,
  nonceOutput: 37,
  expiryOutput: 38,
  chainIdOutput: 39,
  total: 40,
} as const;

export const FACTORY_ABI = [
  "function getAddress(bytes32 circuitSalt, address verifierAddress) view returns (address)",
  "function createAccount(bytes32 circuitSalt, address verifierAddress) returns (address)"
] as const;

export const ACCOUNT_ABI = [
  "function executeWithProof(bytes proof, bytes32[] signals, address target, bytes callData, uint256 value) payable"
] as const;
