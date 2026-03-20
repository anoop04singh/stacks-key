import { ethers } from "hardhat";

async function main() {
  const verifierFactory = await ethers.getContractFactory("HonkVerifier");
  const verifier = await verifierFactory.deploy();
  await verifier.waitForDeployment();

  const factoryFactory = await ethers.getContractFactory("StackKeyFactory");
  const factory = await factoryFactory.deploy();
  await factory.waitForDeployment();

  console.log("Verifier:", await verifier.getAddress());
  console.log("Factory :", await factory.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
