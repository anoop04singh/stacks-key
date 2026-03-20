import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hashMessage, verifyMessageSignature, verifyMessageSignatureRsv } from "@stacks/encryption";
import { bytesToHex } from "./message";

const CURVE_ORDER = secp256k1.CURVE.n;
const HALF_CURVE_ORDER = CURVE_ORDER >> 1n;

function canonicalHex(hex: string, label = "hex value"): string {
  const clean = hex.trim().replace(/\s+/g, "");
  const normalized = clean.startsWith("0x") || clean.startsWith("0X") ? clean.slice(2) : clean;
  if (!/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new Error(`${label} must contain only hexadecimal characters`);
  }
  return normalized;
}

function hexToBytes(hex: string, label = "hex value"): Uint8Array {
  const clean = canonicalHex(hex, label);
  if (clean.length % 2 !== 0) {
    throw new Error(`${label} must contain an even number of hexadecimal characters`);
  }

  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < clean.length; index += 2) {
    bytes[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16);
  }
  return bytes;
}

function bigIntToBytes32(value: bigint): Uint8Array {
  return hexToBytes(value.toString(16).padStart(64, "0"));
}

function normalizeRecoveryId(byte: number): number {
  if (byte >= 31) {
    return byte - 31;
  }
  if (byte >= 27) {
    return byte - 27;
  }
  return byte;
}

function isDerSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0x30;
}

function stripHexPrefix(hex: string): string {
  return canonicalHex(hex);
}

function parseSignature(signatureHex: string): {
  r: Uint8Array;
  s: Uint8Array;
  compact: Uint8Array;
  recoveryId?: number;
} {
  const sigBytes = hexToBytes(signatureHex);

  if (isDerSignature(sigBytes)) {
    const signature = secp256k1.Signature.fromDER(sigBytes);
    let sValue = signature.s;
    if (sValue > HALF_CURVE_ORDER) {
      sValue = CURVE_ORDER - sValue;
    }

    const r = bigIntToBytes32(signature.r);
    const s = bigIntToBytes32(sValue);
    return {
      r,
      s,
      compact: new Uint8Array([...r, ...s]),
    };
  }

  if (sigBytes.length === 65) {
    // `stx_signMessage` returns recoverable signatures in RSV order:
    //   [r (32 bytes)] [s (32 bytes)] [v (1 byte)]
    // This is the Clarity-compatible format consumed by `verifyMessageSignatureRsv`.
    const recoveryId = normalizeRecoveryId(sigBytes[64]);
    const r = sigBytes.slice(0, 32);
    let sValue = BigInt(`0x${bytesToHex(sigBytes.slice(32, 64)).slice(2)}`);
    if (sValue > HALF_CURVE_ORDER) {
      sValue = CURVE_ORDER - sValue;
    }

    const s = bigIntToBytes32(sValue);
    return {
      r,
      s,
      compact: new Uint8Array([...r, ...s]),
      recoveryId,
    };
  }

  throw new Error("Unsupported signature format. Expected DER or 65-byte compact signature.");
}

export type ParsedStacksSignature = {
  publicKey: string;
  pubkeyX: string;
  pubkeyY: string;
  sigR: string;
  sigS: string;
  recoveryId?: number;
};

export function parseStacksSig(signatureHex: string, publicKeyHex: string): ParsedStacksSignature {
  const parsedSignature = parseSignature(signatureHex);
  const normalizedPublicKey = canonicalHex(publicKeyHex, "public key");
  const point = secp256k1.ProjectivePoint.fromHex(normalizedPublicKey);
  const uncompressed = point.toRawBytes(false);

  return {
    publicKey: `0x${normalizedPublicKey}`,
    pubkeyX: bytesToHex(uncompressed.slice(1, 33)),
    pubkeyY: bytesToHex(uncompressed.slice(33, 65)),
    sigR: bytesToHex(parsedSignature.r),
    sigS: bytesToHex(parsedSignature.s),
    recoveryId: parsedSignature.recoveryId,
  };
}

export function normalizePublicKeyHex(publicKeyHex: string): string {
  const normalizedPublicKey = canonicalHex(publicKeyHex, "public key");
  return bytesToHex(secp256k1.ProjectivePoint.fromHex(normalizedPublicKey).toRawBytes(true));
}

export function localVerify(signatureHex: string, publicKeyHex: string, messageHash: Uint8Array): boolean {
  const parsedSignature = parseSignature(signatureHex);
  return secp256k1.verify(parsedSignature.compact, messageHash, hexToBytes(publicKeyHex, "public key"), { lowS: false });
}

export function localVerifyStacksMessage(signatureHex: string, publicKeyHex: string, message: string): boolean {
  const cleanSignature = stripHexPrefix(signatureHex);
  const cleanPublicKey = stripHexPrefix(publicKeyHex);
  const messageHash = hashMessage(message);

  if (cleanSignature.length === 130) {
    return (
      verifyMessageSignatureRsv({
        signature: cleanSignature,
        message,
        publicKey: cleanPublicKey,
      }) ||
      verifyMessageSignature({
        signature: cleanSignature,
        message,
        publicKey: cleanPublicKey,
      })
    );
  }

  const parsedSignature = parseSignature(cleanSignature);
  return secp256k1.verify(parsedSignature.compact, messageHash, hexToBytes(cleanPublicKey), { lowS: false });
}

export function hexStringToByteArray(hex: string): number[] {
  return Array.from(hexToBytes(hex));
}
