import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hashMessage, verifyMessageSignature, verifyMessageSignatureRsv } from "@stacks/encryption";
import { bytesToHex } from "./message";

const CURVE_ORDER = secp256k1.CURVE.n;
const HALF_CURVE_ORDER = CURVE_ORDER >> 1n;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex length");
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
  return hex.startsWith("0x") ? hex.slice(2) : hex;
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
  const point = secp256k1.ProjectivePoint.fromHex(publicKeyHex);
  const uncompressed = point.toRawBytes(false);

  return {
    publicKey: publicKeyHex,
    pubkeyX: bytesToHex(uncompressed.slice(1, 33)),
    pubkeyY: bytesToHex(uncompressed.slice(33, 65)),
    sigR: bytesToHex(parsedSignature.r),
    sigS: bytesToHex(parsedSignature.s),
    recoveryId: parsedSignature.recoveryId,
  };
}

export function normalizePublicKeyHex(publicKeyHex: string): string {
  return bytesToHex(secp256k1.ProjectivePoint.fromHex(publicKeyHex).toRawBytes(true));
}

export function localVerify(signatureHex: string, publicKeyHex: string, messageHash: Uint8Array): boolean {
  const parsedSignature = parseSignature(signatureHex);
  return secp256k1.verify(parsedSignature.compact, messageHash, hexToBytes(publicKeyHex), { lowS: false });
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
