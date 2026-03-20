import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import {
  ACTION,
  DEFAULT_EXPIRY_WINDOW_SECONDS,
  DOMAIN,
} from "./constants";

export type AuthMessage = {
  domain: string;
  nonce: number;
  expiry: number;
  action: string;
  chainId: number;
};

const STACKS_PREFIX = "\u0017Stacks Signed Message:\n";

function encodeVarUint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Message length must be a non-negative safe integer");
  }

  const out: number[] = [];
  let current = value;

  while (current >= 0x80) {
    out.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }

  out.push(current);
  return Uint8Array.from(out);
}

export function buildAuthMessage(chainId: number): AuthMessage {
  const nonceBytes = crypto.getRandomValues(new Uint32Array(1));
  const now = Math.floor(Date.now() / 1000);

  return {
    domain: DOMAIN,
    nonce: nonceBytes[0],
    expiry: now + DEFAULT_EXPIRY_WINDOW_SECONDS,
    action: ACTION,
    chainId,
  };
}

export function msgToString(message: AuthMessage): string {
  return JSON.stringify(message);
}

export function stacksMsgHash(message: string): Uint8Array {
  const body = utf8ToBytes(message);
  const prefix = utf8ToBytes(STACKS_PREFIX);
  const encodedLength = encodeVarUint(body.length);
  const payload = new Uint8Array(prefix.length + encodedLength.length + body.length);
  payload.set(prefix, 0);
  payload.set(encodedLength, prefix.length);
  payload.set(body, prefix.length + encodedLength.length);

  return sha256(payload);
}

export function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
