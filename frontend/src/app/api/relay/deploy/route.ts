import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { FACTORY_ABI } from "@/lib/constants";

export const runtime = "nodejs";

type DeployBody = {
  salt?: string;
  accountAddress?: string;
};

function getRelayConfig() {
  const rpcUrl = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
  const factoryAddress = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
  const verifierAddress = process.env.NEXT_PUBLIC_VERIFIER_ADDRESS;
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;

  if (!rpcUrl || !factoryAddress || !verifierAddress || !relayerPrivateKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SEPOLIA_RPC_URL, NEXT_PUBLIC_FACTORY_ADDRESS, NEXT_PUBLIC_VERIFIER_ADDRESS, or RELAYER_PRIVATE_KEY"
    );
  }

  return { rpcUrl, factoryAddress, verifierAddress, relayerPrivateKey };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as DeployBody;
    if (!body.salt) {
      throw new Error("salt is required");
    }

    const { rpcUrl, factoryAddress, verifierAddress, relayerPrivateKey } = getRelayConfig();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(relayerPrivateKey, provider);
    const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, signer);

    const predictedAddress = await factory.getFunction("getAddress")(body.salt, verifierAddress);
    if (body.accountAddress && ethers.getAddress(body.accountAddress) !== ethers.getAddress(predictedAddress)) {
      throw new Error("Provided accountAddress does not match the factory-derived counterfactual address.");
    }

    const code = await provider.getCode(predictedAddress);
    if (code !== "0x") {
      return NextResponse.json({
        accountAddress: predictedAddress,
        txHash: undefined,
        alreadyDeployed: true,
        relayerAddress: await signer.getAddress(),
      });
    }

    const tx = await factory.getFunction("createAccount")(body.salt, verifierAddress);
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error("Deployment transaction was not confirmed.");
    }

    return NextResponse.json({
      accountAddress: predictedAddress,
      txHash: tx.hash,
      alreadyDeployed: false,
      relayerAddress: await signer.getAddress(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to deploy relayed smart account";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
