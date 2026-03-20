import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { readFile, writeFile } from "fs/promises";
import { UltraHonkBackend } from "@aztec/bb.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function streamText(text) {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

async function importNoirWasmWebBundle() {
  const noirWasmEntry = require.resolve("@noir-lang/noir_wasm");
  const packageDir = join(dirname(noirWasmEntry), "..", "..");
  const webBundlePath = join(packageDir, "dist", "web", "main.mjs");
  return import(pathToFileURL(webBundlePath).href);
}

async function compileCircuit() {
  const noirWasm = await importNoirWasmWebBundle();
  const fm = noirWasm.createFileManager("/");
  const circuitRoot = join(__dirname, "..", "..", "circuits", "stackkey_auth");
  const [nargoToml, mainSource] = await Promise.all([
    readFile(join(circuitRoot, "Nargo.toml"), "utf8"),
    readFile(join(circuitRoot, "src", "main.nr"), "utf8"),
  ]);

  await fm.writeFile("stackkey_auth/Nargo.toml", streamText(nargoToml));
  await fm.writeFile("stackkey_auth/src/main.nr", streamText(mainSource));

  const { program } = await noirWasm.compile(fm, "/stackkey_auth");
  return program;
}

async function main() {
  const program = await compileCircuit();
  const backend = new UltraHonkBackend(program.bytecode, { threads: 1 });

  try {
    const vk = await backend.getVerificationKey({ keccak: true });
    const verifierSource = await backend.getSolidityVerifier(vk, { keccak: true });
    const outPath = join(__dirname, "..", "contracts", "StackKeyVerifier.sol");
    await writeFile(outPath, verifierSource, "utf8");
    console.log(`Wrote verifier to ${outPath}`);
  } finally {
    await backend.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
