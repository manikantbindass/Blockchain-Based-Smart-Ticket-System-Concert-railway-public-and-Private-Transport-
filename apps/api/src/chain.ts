import { Contract, JsonRpcProvider, Wallet, type Signer } from "ethers";
import { ticketRegistryAbi } from "@chainpass/contracts";
import type { Config } from "./config.js";
import type { ChainAdapter } from "./outbox.js";

export async function createChainAdapter(
  config: Config,
): Promise<{ adapter: ChainAdapter; close(): void }> {
  const provider = new JsonRpcProvider(config.rpcUrl);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) {
    provider.destroy();
    throw new Error("RPC chain ID does not match CHAIN_ID.");
  }
  if ((await provider.getCode(config.registryAddress)) === "0x") {
    provider.destroy();
    throw new Error("No registry contract found at configured address.");
  }
  const signer: Signer = config.issuerPrivateKey
    ? new Wallet(config.issuerPrivateKey, provider)
    : await provider.getSigner(0);
  const contract = new Contract(
    config.registryAddress,
    ticketRegistryAbi,
    signer,
  );
  return {
    adapter: {
      async findAnchor(commitment) {
        const anchor = (await contract.getFunction("getAnchor")(
          commitment,
        )) as [bigint, bigint, string];
        if (anchor[0] === 0n) return null;
        const event = contract.filters.TicketAnchored;
        if (!event)
          throw new Error("Registry ABI does not include TicketAnchored");
        const logs = await contract.queryFilter(
          event(commitment),
          Number(anchor[1]),
          Number(anchor[1]),
        );
        if (!logs[0])
          throw new Error(
            "Anchor exists but transaction could not be recovered from RPC logs.",
          );
        return logs[0].transactionHash;
      },
      async submit(commitment) {
        const transaction = await contract.getFunction("anchorBatch")([
          commitment,
        ]);
        return transaction.hash as string;
      },
      async confirm(transactionHash) {
        const receipt = await provider.waitForTransaction(
          transactionHash,
          1,
          60_000,
        );
        if (!receipt) throw new Error("Registry transaction did not confirm.");
        if (receipt.status !== 1) {
          const error = new Error("Registry transaction reverted.");
          error.name = "TransactionRevertedError";
          throw error;
        }
      },
    },
    close() {
      provider.destroy();
    },
  };
}
