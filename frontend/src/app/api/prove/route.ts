import { NextRequest, NextResponse } from "next/server";
import { access, readFile } from "fs/promises";
import { createRequire } from "module";
import { join } from "path";
import { pathToFileURL } from "url";
import { UltraHonkBackend } from "@aztec/bb.js";
import type { CompiledCircuit } from "@noir-lang/types";
import { HONK_PROOF_OPTIONS, PUBLIC_INPUT_LAYOUT } from "@/lib/constants";

export const runtime = "nodejs";

type ProveBody = {
  pubkeyX: number[] | string;
  pubkeyY: number[] | string;
  sigR: number[] | string;
  sigS: number[] | string;
  messageHash: number[] | string;
  nonce: number;
  expiry: number;
  chainId: number;
};

const FIELD_MASK = (1n << 256n) - 1n;

type StackKeyArtifacts = {
  backend: UltraHonkBackend;
  program: CompiledCircuit;
};

const require = createRequire(import.meta.url);
const { Noir } = require("@noir-lang/noir_js") as typeof import("@noir-lang/noir_js");

let cachedArtifactsPromise: Promise<StackKeyArtifacts> | undefined;

function normalizeBytes32(input: number[] | string, label: string): Uint8Array {
  if (typeof input === "string") {
    const clean = input.startsWith("0x") ? input.slice(2) : input;
    if (clean.length !== 64) {
      throw new Error(`${label} must be 32 bytes`);
    }
    const bytes = new Uint8Array(32);
    for (let index = 0; index < clean.length; index += 2) {
      bytes[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16);
    }
    return bytes;
  }

  if (!Array.isArray(input) || input.length !== 32) {
    throw new Error(`${label} must be 32 bytes`);
  }

  return Uint8Array.from(input);
}

function toBytes32Hex(value: bigint): string {
  return `0x${(value & FIELD_MASK).toString(16).padStart(64, "0")}`;
}

function toHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function streamText(text: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

async function importNoirWasmWebBundle() {
  const candidatePaths = [
    join(process.cwd(), "node_modules", "@noir-lang", "noir_wasm", "dist", "web", "main.mjs"),
    join(process.cwd(), "..", "node_modules", "@noir-lang", "noir_wasm", "dist", "web", "main.mjs"),
  ];

  for (const candidatePath of candidatePaths) {
    try {
      await access(candidatePath);
      const moduleUrl = pathToFileURL(candidatePath).href;
      return import(/* webpackIgnore: true */ moduleUrl);
    } catch {
      continue;
    }
  }

  throw new Error("Unable to locate @noir-lang/noir_wasm/dist/web/main.mjs from the frontend workspace.");
}

async function loadArtifacts(): Promise<StackKeyArtifacts> {
  if (!cachedArtifactsPromise) {
    cachedArtifactsPromise = (async () => {
      const noirWasm = await importNoirWasmWebBundle();
      const fm = noirWasm.createFileManager("/");
      const circuitRoot = join(process.cwd(), "..", "circuits", "stackkey_auth");
      const [nargoToml, mainSource] = await Promise.all([
        readFile(join(circuitRoot, "Nargo.toml"), "utf8"),
        readFile(join(circuitRoot, "src", "main.nr"), "utf8"),
      ]);

      await fm.writeFile("stackkey_auth/Nargo.toml", streamText(nargoToml));
      await fm.writeFile("stackkey_auth/src/main.nr", streamText(mainSource));

      const { program } = await noirWasm.compile(fm, "/stackkey_auth");
      const backend = new UltraHonkBackend(program.bytecode, { threads: 1 });

      return { backend, program };
    })();
  }

  return cachedArtifactsPromise!;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ProveBody;
    const pubkeyX = normalizeBytes32(body.pubkeyX, "pubkeyX");
    const pubkeyY = normalizeBytes32(body.pubkeyY, "pubkeyY");
    const sigR = normalizeBytes32(body.sigR, "sigR");
    const sigS = normalizeBytes32(body.sigS, "sigS");
    const messageHash = normalizeBytes32(body.messageHash, "messageHash");

    if (!Number.isInteger(body.nonce) || body.nonce < 0) {
      throw new Error("nonce must be a positive integer");
    }
    if (!Number.isInteger(body.expiry) || body.expiry <= 0) {
      throw new Error("expiry must be a unix timestamp");
    }
    if (!Number.isInteger(body.chainId) || body.chainId <= 0) {
      throw new Error("chainId must be a positive integer");
    }
    const { backend, program } = await loadArtifacts();
    const noir = new Noir(program);
    const { witness, returnValue } = await noir.execute({
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
    if (!verified) {
      throw new Error("Generated proof did not verify");
    }

    const publicInputs = proofData.publicInputs.map((input) =>
      input.startsWith("0x") ? input : toBytes32Hex(BigInt(input))
    );
    if (publicInputs.length !== PUBLIC_INPUT_LAYOUT.total) {
      throw new Error(`Expected ${PUBLIC_INPUT_LAYOUT.total} public inputs, received ${publicInputs.length}`);
    }

    return NextResponse.json({
      proof: toHex(proofData.proof),
      publicInputs,
      salt: publicInputs[PUBLIC_INPUT_LAYOUT.saltOutput],
      returnValue,
      proofSystem: "ultra-honk-keccak",
      verified,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate proof";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
