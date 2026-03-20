import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { ACCOUNT_ABI } from "@/lib/constants";

export const runtime = "nodejs";

type ExecuteBody = {
  accountAddress?: string;
  proof?: string;
  publicInputs?: string[];
  target?: string;
  callData?: string;
  value?: string;
};

function getRelayConfig() {
  const rpcUrl = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;

  if (!rpcUrl || !relayerPrivateKey) {
    throw new Error("Missing NEXT_PUBLIC_SEPOLIA_RPC_URL or RELAYER_PRIVATE_KEY");
  }

  return { rpcUrl, relayerPrivateKey };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ExecuteBody;
    if (!body.accountAddress || !body.proof || !body.publicInputs || !body.target || !body.callData) {
      throw new Error("accountAddress, proof, publicInputs, target, and callData are required");
    }

    const { rpcUrl, relayerPrivateKey } = getRelayConfig();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(relayerPrivateKey, provider);
    const account = new ethers.Contract(body.accountAddress, ACCOUNT_ABI, signer);
    const value = BigInt(body.value ?? "0");

    const tx = await account.getFunction("executeWithProof")(
      body.proof,
      body.publicInputs,
      ethers.getAddress(body.target),
      body.callData,
      value
    );
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error("Execution transaction was not confirmed.");
    }

    return NextResponse.json({
      txHash: tx.hash,
      relayerAddress: await signer.getAddress(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to execute relayed smart-account action";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
