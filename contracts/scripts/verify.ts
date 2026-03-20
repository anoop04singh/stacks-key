import { run } from "hardhat";

async function main() {
  const verifierAddress = "PASTE_VERIFIER_ADDRESS";
  const factoryAddress = "PASTE_FACTORY_ADDRESS";

  console.log("Verifying HonkVerifier...");
  await run("verify:verify", {
    address: verifierAddress,
    constructorArguments: [],
  });

  console.log("Verifying StackKeyFactory...");
  await run("verify:verify", {
    address: factoryAddress,
    constructorArguments: [],
  });

  console.log("Verification completed!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});