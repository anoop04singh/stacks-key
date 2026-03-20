"use client";

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { ACCOUNT_ABI, FACTORY_ABI, PUBLIC_INPUT_LAYOUT, SEPOLIA_CHAIN_ID } from "@/lib/constants";
import { buildAuthMessage, bytesToHex, msgToString, stacksMsgHash } from "@/lib/message";
import { localVerifyStacksMessage, normalizePublicKeyHex, parseStacksSig } from "@/lib/signature";

type Phase =
  | "idle"
  | "connecting"
  | "signing"
  | "verifying"
  | "proving"
  | "deploying"
  | "done"
  | "error";

type Result = {
  proof: string;
  publicInputs: string[];
  salt: string;
  accountAddress: string;
  proofMode: string;
};

type LogItem = {
  text: string;
  ok?: boolean;
};

type StacksAddressEntry = {
  address: string;
  publicKey: string;
  symbol?: string;
};

type DeployState = {
  relayerAddress?: string;
  accountDeployed: boolean;
  deploying: boolean;
  txHash?: string;
  error?: string;
};

type ActionMode = "eth" | "erc20" | "custom";

type ActionForm = {
  mode: ActionMode;
  recipient: string;
  ethAmount: string;
  tokenAddress: string;
  tokenRecipient: string;
  tokenAmount: string;
  customTarget: string;
  customCallData: string;
  customValue: string;
};

type ActionState = {
  submitting: boolean;
  txHash?: string;
  error?: string;
  proofSpent: boolean;
};

const phaseLabel: Record<Phase, string> = {
  idle: "Connect and prove",
  connecting: "Connecting wallet...",
  signing: "Waiting for signature...",
  verifying: "Verifying locally...",
  proving: "Generating proof...",
  deploying: "Deriving account...",
  done: "Run again",
  error: "Try again",
};

const steps = [
  { id: "connecting", label: "Connect wallet" },
  { id: "signing", label: "Sign auth message" },
  { id: "verifying", label: "Verify signature" },
  { id: "proving", label: "Generate ZK proof" },
  { id: "deploying", label: "Derive account" },
] as const;

const stepDescriptions: Record<(typeof steps)[number]["id"], string> = {
  connecting: "Waiting for wallet approval.",
  signing: "Collecting the Stacks message signature.",
  verifying: "Checking the signature before proving.",
  proving: "Executing the circuit and generating the proof.",
  deploying: "Deriving the counterfactual account address.",
};

const defaultActionForm: ActionForm = {
  mode: "eth",
  recipient: "",
  ethAmount: "",
  tokenAddress: "",
  tokenRecipient: "",
  tokenAmount: "",
  customTarget: "",
  customCallData: "0x",
  customValue: "",
};

async function connectWallet(): Promise<{ address: string; publicKey: string }> {
  const { request } = await import("@stacks/connect");
  const response = (await request({ forceWalletSelect: true }, "stx_getAddresses")) as {
    addresses?: StacksAddressEntry[];
  };
  const address = response.addresses?.find(
    (entry) =>
      entry.address.startsWith("S") &&
      /^(02|03)[0-9a-fA-F]{64}$/.test(entry.publicKey)
  );
  if (address) {
    return {
      address: address.address,
      publicKey: address.publicKey,
    };
  }

  throw new Error("Wallet connected but no Stacks address with a compressed secp256k1 public key was returned.");
}

async function requestSignature(message: string, publicKey: string): Promise<{ signature: string; publicKey: string }> {
  const { request } = await import("@stacks/connect");
  const response = (await request("stx_signMessage", {
    message,
    publicKey,
  })) as { signature?: string; publicKey?: string };

  if (response.signature && response.publicKey) {
    return {
      signature: response.signature,
      publicKey: response.publicKey,
    };
  }

  throw new Error("Wallet did not return a signature and public key for stx_signMessage.");
}

function truncateMiddle(value: string, start = 10, end = 8) {
  if (value.length <= start + end + 3) {
    return value;
  }
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function getExplorerAddressUrl(address: string) {
  return `https://sepolia.etherscan.io/address/${address}`;
}

function getExplorerTxUrl(hash: string) {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

function getFactoryConfig() {
  const rpcUrl = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
  const factoryAddress = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
  const verifierAddress = process.env.NEXT_PUBLIC_VERIFIER_ADDRESS;

  if (!rpcUrl || !factoryAddress || !verifierAddress) {
    throw new Error("Missing NEXT_PUBLIC_SEPOLIA_RPC_URL, NEXT_PUBLIC_FACTORY_ADDRESS, or NEXT_PUBLIC_VERIFIER_ADDRESS");
  }

  return { rpcUrl, factoryAddress, verifierAddress };
}

export default function HomePage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<Result>();
  const [hasStacksSession, setHasStacksSession] = useState(false);
  const [stacksPublicKey, setStacksPublicKey] = useState<string>();
  const [deployState, setDeployState] = useState<DeployState>({
    accountDeployed: false,
    deploying: false,
  });
  const [actionForm, setActionForm] = useState<ActionForm>(defaultActionForm);
  const [actionState, setActionState] = useState<ActionState>({
    submitting: false,
    proofSpent: false,
  });

  const running = ["connecting", "signing", "verifying", "proving", "deploying"].includes(phase);
  const stacksConnected = hasStacksSession;
  const completedSteps = phase === "done" ? steps.length : Math.max(steps.findIndex((entry) => entry.id === phase), 0);

  function pushLog(text: string, ok?: boolean) {
    setLogs((current) => [...current, { text, ok }]);
  }

  function resetFlowState() {
    setPhase("idle");
    setError(undefined);
    setResult(undefined);
    setLogs([]);
    setHasStacksSession(false);
    setStacksPublicKey(undefined);
    setDeployState({
      accountDeployed: false,
      deploying: false,
    });
    setActionForm(defaultActionForm);
    setActionState({
      submitting: false,
      proofSpent: false,
    });
  }

  async function refreshDeploymentStatus(accountAddress: string) {
    const { rpcUrl } = getFactoryConfig();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const code = await provider.getCode(accountAddress);

    setDeployState((current) => ({
      ...current,
      accountDeployed: code !== "0x",
    }));
  }

  useEffect(() => {
    if (!result?.accountAddress) {
      setDeployState({
        accountDeployed: false,
        deploying: false,
      });
      setActionState({
        submitting: false,
        proofSpent: false,
      });
      return;
    }

    refreshDeploymentStatus(result.accountAddress).catch((caught) => {
      const message = caught instanceof Error ? caught.message : "Failed to check deployment status";
      setDeployState((current) => ({
        ...current,
        error: message,
      }));
    });
  }, [result?.accountAddress]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateConnection() {
      const { isConnected } = await import("@stacks/connect");
      if (!isConnected()) {
        return;
      }
      if (!cancelled) {
        setHasStacksSession(true);
      }
    }

    hydrateConnection().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  async function runFlow() {
    resetFlowState();
    setPhase("connecting");

    try {
      const connected = await connectWallet();
      const connectedPublicKey = normalizePublicKeyHex(connected.publicKey);
      setHasStacksSession(true);
      setStacksPublicKey(connectedPublicKey);
      pushLog(`Wallet connected: ${connected.address}`, true);
      pushLog(`Stacks key selected: ${connectedPublicKey.slice(0, 18)}...`, true);

      setPhase("signing");
      const authMessage = buildAuthMessage(SEPOLIA_CHAIN_ID);
      const messageString = msgToString(authMessage);
      pushLog(`Auth message built with nonce ${authMessage.nonce}`);

      const signed = await requestSignature(messageString, connectedPublicKey);
      const signedPublicKey = signed.publicKey ? normalizePublicKeyHex(signed.publicKey) : connectedPublicKey;
      if (signedPublicKey !== connectedPublicKey) {
        throw new Error(
          `Wallet signed with a different Stacks key (${signedPublicKey.slice(0, 18)}...) than the connected key (${connectedPublicKey.slice(0, 18)}...). Please switch the wallet account and try again.`
        );
      }
      const publicKey = connectedPublicKey;
      pushLog("Message signed in wallet", true);
      pushLog(`Signing key confirmed: ${publicKey.slice(0, 18)}...`, true);

      setPhase("verifying");
      const messageHash = stacksMsgHash(messageString);
      const verified = localVerifyStacksMessage(signed.signature, publicKey, messageString);
      if (!verified) {
        throw new Error("Local signature verification failed. Check wallet hash format and low-s normalization.");
      }
      pushLog(`Local signature check passed for ${bytesToHex(messageHash).slice(0, 18)}...`, true);

      const parsed = parseStacksSig(signed.signature, publicKey);

      setPhase("proving");
      const proveResponse = await fetch("/api/prove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pubkeyX: parsed.pubkeyX,
          pubkeyY: parsed.pubkeyY,
          sigR: parsed.sigR,
          sigS: parsed.sigS,
          messageHash: Array.from(messageHash),
          nonce: authMessage.nonce,
          expiry: authMessage.expiry,
          chainId: authMessage.chainId,
        }),
      });

      const proveData = (await proveResponse.json()) as {
        error?: string;
        proof?: string;
        publicInputs?: string[];
        salt?: string;
        proofSystem?: string;
      };

      if (!proveResponse.ok || !proveData.proof || !proveData.publicInputs || !proveData.salt) {
        throw new Error(proveData.error ?? "Proof generation failed");
      }
      pushLog(`ZK proof generated with ${proveData.publicInputs.length} public inputs`, true);

      setPhase("deploying");
      const { rpcUrl, factoryAddress, verifierAddress } = getFactoryConfig();
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
      let accountAddress: string;
      try {
        accountAddress = await factory.getFunction("getAddress")(
          proveData.publicInputs[PUBLIC_INPUT_LAYOUT.saltOutput],
          verifierAddress
        );
      } catch (caught) {
        if (caught instanceof Error && "code" in caught && (caught as { code?: string }).code === "CALL_EXCEPTION") {
          throw new Error(
            `Configured factory address ${factoryAddress} does not behave like StackKeyFactory.getAddress(bytes32,address). Check NEXT_PUBLIC_FACTORY_ADDRESS and make sure it is the deployed StackKeyFactory contract, not the verifier or a previously derived account.`
          );
        }
        throw caught;
      }
      pushLog(`Counterfactual account: ${accountAddress}`, true);

      setResult({
        proof: proveData.proof,
        publicInputs: proveData.publicInputs,
        salt: proveData.salt,
        accountAddress,
        proofMode: proveData.proofSystem ?? "unknown",
      });
      setPhase("done");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Something went wrong";
      setError(message);
      setPhase("error");
      pushLog(message, false);
    }
  }

  async function disconnectStacksWallet() {
    try {
      const { disconnect } = await import("@stacks/connect");
      disconnect();
      resetFlowState();
      setHasStacksSession(false);
      setLogs([{ text: "Stacks wallet disconnected", ok: true }]);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Failed to disconnect the Stacks wallet";
      setError(message);
      pushLog(message, false);
    }
  }

  async function deployWithRelayer() {
    try {
      if (!result) {
        throw new Error("Generate the account proof before deploying.");
      }

      setDeployState((current) => ({
        ...current,
        deploying: true,
        error: undefined,
      }));

      const response = await fetch("/api/relay/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salt: result.salt,
          accountAddress: result.accountAddress,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        accountAddress?: string;
        txHash?: string;
        alreadyDeployed?: boolean;
        relayerAddress?: string;
      };
      if (!response.ok || !data.accountAddress) {
        throw new Error(data.error ?? "Failed to relay account deployment");
      }

      if (data.alreadyDeployed) {
        pushLog(`Account already deployed on Sepolia: ${data.accountAddress}`, true);
      } else if (data.txHash) {
        pushLog(`Relayed deployment submitted: ${data.txHash}`, true);
        pushLog(`Account deployed on Sepolia: ${data.accountAddress}`, true);
      }
      setDeployState({
        relayerAddress: data.relayerAddress,
        accountDeployed: true,
        deploying: false,
        txHash: data.txHash,
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Failed to deploy smart account";
      setDeployState((current) => ({
        ...current,
        deploying: false,
        error: message,
      }));
    }
  }

  async function executeDemoAction() {
    try {
      if (!result) {
        throw new Error("Generate and keep a valid proof before executing an action.");
      }
      if (!deployState.accountDeployed) {
        throw new Error("Deploy the smart account before using it.");
      }
      if (actionState.proofSpent) {
        throw new Error("This proof has already been used for an onchain action. Run the proof flow again to get a fresh nonce.");
      }

      setActionState((current) => ({
        ...current,
        submitting: true,
        error: undefined,
      }));

      let target: string;
      let callData: string;
      let value = 0n;

      if (actionForm.mode === "eth") {
        target = ethers.getAddress(actionForm.recipient);
        value = ethers.parseEther(actionForm.ethAmount || "0");
        callData = "0x";
      } else if (actionForm.mode === "erc20") {
        target = ethers.getAddress(actionForm.tokenAddress);
        const recipient = ethers.getAddress(actionForm.tokenRecipient);
        const amount = ethers.parseUnits(actionForm.tokenAmount || "0", 18);
        const erc20Interface = new ethers.Interface(["function transfer(address to, uint256 amount)"]);
        callData = erc20Interface.encodeFunctionData("transfer", [recipient, amount]);
      } else {
        target = ethers.getAddress(actionForm.customTarget);
        callData = actionForm.customCallData.startsWith("0x") ? actionForm.customCallData : `0x${actionForm.customCallData}`;
        if (callData.length % 2 !== 0) {
          throw new Error("Custom calldata must be valid hex.");
        }
        value = ethers.parseEther(actionForm.customValue || "0");
      }

      const response = await fetch("/api/relay/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountAddress: result.accountAddress,
          proof: result.proof,
          publicInputs: result.publicInputs,
          target,
          callData,
          value: value.toString(),
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        txHash?: string;
        relayerAddress?: string;
      };
      if (!response.ok || !data.txHash) {
        throw new Error(data.error ?? "Failed to relay smart-account action");
      }

      pushLog(`Relayed smart account action submitted: ${data.txHash}`, true);
      pushLog(`Smart account executed call on ${target}`, true);
      setDeployState((current) => ({
        ...current,
        relayerAddress: data.relayerAddress ?? current.relayerAddress,
      }));
      setActionState({
        submitting: false,
        proofSpent: true,
        txHash: data.txHash,
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Failed to execute smart-account action";
      setActionState((current) => ({
        ...current,
        submitting: false,
        error: message,
      }));
    }
  }

  async function copyText(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    pushLog(`${label} copied`, true);
  }

  return (
    <main className="app-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">Stacks identity, proven cleanly</span>
          <h1 className="brand-mark" aria-label="stacksKey">
            stacksKey
          </h1>
          <p className="hero-text">
            Connect a Stacks wallet, sign one authentication message, generate a real zero-knowledge proof,
            derive the Ethereum account bound to that key, deploy it on Sepolia through a relayer, and demo transactions from it.
          </p>

          <div className="hero-actions">
            <button type="button" onClick={runFlow} disabled={running} className="primary-button">
              {running && <span className="button-spinner" aria-hidden="true" />}
              {phaseLabel[phase]}
            </button>
            {stacksConnected && (
              <button
                type="button"
                onClick={disconnectStacksWallet}
                disabled={running}
                className="secondary-button"
              >
                Disconnect Stacks wallet
              </button>
            )}
            <div className="chain-pill">Sepolia {SEPOLIA_CHAIN_ID}</div>
          </div>
        </div>

        <div className="summary-grid">
          <InfoStat label="Mode" value="Real proof generation" />
          <InfoStat label="Proof system" value={result?.proofMode ?? "UltraHonk keccak"} />
          <InfoStat label="Current step" value={phase === "done" ? "Complete" : phaseLabel[phase]} />
          <InfoStat
            label="Stacks key"
            value={stacksPublicKey ? truncateMiddle(stacksPublicKey, 10, 8) : stacksConnected ? "Connected" : "Not connected"}
          />
          <InfoStat label="Account" value={result ? truncateMiddle(result.accountAddress, 8, 6) : "Not derived yet"} />
        </div>
      </section>

      <section className="section-card">
        <div className="section-heading">
          <div>
            <p className="section-label">Flow</p>
            <h2>Minimal sign-to-account path</h2>
          </div>
          <p className="section-note">{phase === "done" ? "5 / 5 complete" : `${completedSteps} / 5 complete`}</p>
        </div>

        <div className="step-list">
          {steps.map((step, index) => {
            const active = phase === step.id;
            const done = steps.findIndex((entry) => entry.id === phase) > index || phase === "done";

            return (
              <div
                key={step.id}
                className={`step-card${active ? " step-card-active" : ""}${done ? " step-card-done" : ""}`}
              >
                <span className="step-index">{done ? "OK" : index + 1}</span>
                <span className="step-label">{step.label}</span>
                {active && running && (
                  <div className="step-status">
                    <span className="step-loader" aria-hidden="true" />
                    <span>{stepDescriptions[step.id]}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div className="content-grid">
        <section className="section-card">
          <div className="section-heading">
            <div>
              <p className="section-label">Activity</p>
              <h2>Live run log</h2>
            </div>
          </div>

          {logs.length === 0 ? (
            <div className="empty-panel">
              Start the flow to connect your wallet, sign the auth message, and generate the proof.
            </div>
          ) : (
            <div className="log-list">
              {logs.map((entry, index) => (
                <p
                  key={`${entry.text}-${index}`}
                  className={`log-item${entry.ok === true ? " log-item-ok" : ""}${entry.ok === false ? " log-item-error" : ""}`}
                >
                  {entry.ok === true ? "[ok] " : entry.ok === false ? "[x] " : "[..] "}
                  {entry.text}
                </p>
              ))}
            </div>
          )}

          {error && <div className="error-panel">{error}</div>}
        </section>

        <section className="section-card">
          <div className="section-heading">
            <div>
              <p className="section-label">Output</p>
              <h2>Derived account</h2>
            </div>
          </div>

          {result ? (
            <>
              <div className="result-stack">
                <InfoCard label="Counterfactual account" value={result.accountAddress} />
                <InfoCard label="Circuit salt" value={result.salt} />
                <InfoCard label="Proof bytes" value={`${(result.proof.length - 2) / 2}`} />
                <InfoCard label="Public inputs" value={`${result.publicInputs.length}`} />
              </div>

              <div className="section-card deployment-panel">
                <div className="section-heading">
                  <div>
                    <p className="section-label">Deployment</p>
                    <h2>Deploy through relayer</h2>
                  </div>
                </div>

                <p className="hero-text compact-text">
                  stacksKey can deploy this smart account on Sepolia through your server-side relayer wallet. The relayer
                  pays gas on behalf of the user, so no MetaMask connection is needed for deployment or demo actions.
                </p>

                <div className="result-stack deploy-stats">
                  <InfoCard label="Deployment status" value={deployState.accountDeployed ? "Deployed" : "Not deployed"} />
                  <InfoCard
                    label="Relayer wallet"
                    value={deployState.relayerAddress ? truncateMiddle(deployState.relayerAddress, 8, 6) : "Not used yet"}
                  />
                  <InfoCard label="Explorer" value={truncateMiddle(getExplorerAddressUrl(result.accountAddress), 20, 14)} />
                  <InfoCard label="Copyable address" value={result.accountAddress} />
                </div>

                <div className="hero-actions">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={deployWithRelayer}
                    disabled={deployState.deploying || deployState.accountDeployed}
                  >
                    {deployState.deploying && <span className="button-spinner" aria-hidden="true" />}
                    {deployState.accountDeployed ? "Account deployed" : "Deploy with relayer"}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => copyText(result.accountAddress, "Account address")}
                  >
                    Copy address
                  </button>
                  <a className="text-link" href={getExplorerAddressUrl(result.accountAddress)} target="_blank" rel="noreferrer">
                    View on Etherscan
                  </a>
                  {deployState.txHash && (
                    <a className="text-link" href={getExplorerTxUrl(deployState.txHash)} target="_blank" rel="noreferrer">
                      View deployment tx
                    </a>
                  )}
                </div>

                {deployState.error && <div className="error-panel">{deployState.error}</div>}
              </div>

              <div className="section-card deployment-panel">
                <div className="section-heading">
                  <div>
                    <p className="section-label">Actions</p>
                    <h2>Use the smart account on Sepolia</h2>
                  </div>
                </div>

                <p className="hero-text compact-text">
                  These actions call <code>executeWithProof(...)</code> on the deployed account. Each proof is single-use
                  because the nonce is consumed onchain, so after one action you should run the proof flow again for a fresh demo.
                  Gas is paid by the server-side relayer wallet.
                </p>

                <div className="mode-row">
                  <button
                    type="button"
                    className={actionForm.mode === "eth" ? "tab-button tab-button-active" : "tab-button"}
                    onClick={() => setActionForm((current) => ({ ...current, mode: "eth" }))}
                  >
                    Send ETH
                  </button>
                  <button
                    type="button"
                    className={actionForm.mode === "erc20" ? "tab-button tab-button-active" : "tab-button"}
                    onClick={() => setActionForm((current) => ({ ...current, mode: "erc20" }))}
                  >
                    ERC-20 transfer
                  </button>
                  <button
                    type="button"
                    className={actionForm.mode === "custom" ? "tab-button tab-button-active" : "tab-button"}
                    onClick={() => setActionForm((current) => ({ ...current, mode: "custom" }))}
                  >
                    Custom call
                  </button>
                </div>

                {actionForm.mode === "eth" && (
                  <div className="form-grid">
                    <label className="field">
                      <span>Recipient</span>
                      <input
                        value={actionForm.recipient}
                        onChange={(event) => setActionForm((current) => ({ ...current, recipient: event.target.value }))}
                        placeholder="0x..."
                      />
                    </label>
                    <label className="field">
                      <span>Amount (ETH)</span>
                      <input
                        value={actionForm.ethAmount}
                        onChange={(event) => setActionForm((current) => ({ ...current, ethAmount: event.target.value }))}
                        placeholder="0.001"
                      />
                    </label>
                  </div>
                )}

                {actionForm.mode === "erc20" && (
                  <div className="form-grid">
                    <label className="field">
                      <span>Token address</span>
                      <input
                        value={actionForm.tokenAddress}
                        onChange={(event) => setActionForm((current) => ({ ...current, tokenAddress: event.target.value }))}
                        placeholder="0x..."
                      />
                    </label>
                    <label className="field">
                      <span>Recipient</span>
                      <input
                        value={actionForm.tokenRecipient}
                        onChange={(event) => setActionForm((current) => ({ ...current, tokenRecipient: event.target.value }))}
                        placeholder="0x..."
                      />
                    </label>
                    <label className="field">
                      <span>Amount (18 decimals)</span>
                      <input
                        value={actionForm.tokenAmount}
                        onChange={(event) => setActionForm((current) => ({ ...current, tokenAmount: event.target.value }))}
                        placeholder="1.0"
                      />
                    </label>
                  </div>
                )}

                {actionForm.mode === "custom" && (
                  <div className="form-grid">
                    <label className="field">
                      <span>Target contract</span>
                      <input
                        value={actionForm.customTarget}
                        onChange={(event) => setActionForm((current) => ({ ...current, customTarget: event.target.value }))}
                        placeholder="0x..."
                      />
                    </label>
                    <label className="field field-wide">
                      <span>Calldata</span>
                      <textarea
                        value={actionForm.customCallData}
                        onChange={(event) => setActionForm((current) => ({ ...current, customCallData: event.target.value }))}
                        placeholder="0x"
                        rows={4}
                      />
                    </label>
                    <label className="field">
                      <span>ETH value</span>
                      <input
                        value={actionForm.customValue}
                        onChange={(event) => setActionForm((current) => ({ ...current, customValue: event.target.value }))}
                        placeholder="0"
                      />
                    </label>
                  </div>
                )}

                <div className="hero-actions">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={executeDemoAction}
                    disabled={actionState.submitting || !deployState.accountDeployed || actionState.proofSpent}
                  >
                    {actionState.submitting && <span className="button-spinner" aria-hidden="true" />}
                    {actionState.proofSpent ? "Proof already used" : "Execute with smart account"}
                  </button>
                  {actionState.txHash && (
                    <a className="text-link" href={getExplorerTxUrl(actionState.txHash)} target="_blank" rel="noreferrer">
                      View action tx
                    </a>
                  )}
                </div>

                {actionState.error && <div className="error-panel">{actionState.error}</div>}
              </div>

              <div className="signals-panel">
                <p className="section-label">Public signals</p>
                <div className="signal-list">
                  {result.publicInputs.map((signal, index) => (
                    <p key={signal} className="signal-item">
                      <span>[{index}]</span> {signal}
                    </p>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-panel">
              The derived Ethereum account, deployment actions, and public proof signals will appear here after a successful run.
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function InfoStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-stat">
      <p>{label}</p>
      <strong>{value}</strong>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-card">
      <p>{label}</p>
      <strong>{value}</strong>
    </div>
  );
}
