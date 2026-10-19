import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ContractFactory, JsonRpcProvider } from "ethers";
import { compileRegistry, contractRoot } from "./compile.mjs";

const envPath = resolve(contractRoot, "../../.env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
const parsedUrl = new URL(rpcUrl);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(parsedUrl.hostname) ||
  parsedUrl.protocol !== "http:"
) {
  throw new Error(
    "This deployment script is for a loopback HTTP development node only.",
  );
}

const provider = new JsonRpcProvider(rpcUrl);
provider.pollingInterval = 100;
try {
  const network = await provider.getNetwork();
  if (network.chainId !== 31337n)
    throw new Error("Local deployment requires chain ID 31337.");
  const signer = await provider.getSigner(0);
  const admin = await signer.getAddress();
  const artifact = compileRegistry();
  const registry = await new ContractFactory(
    artifact.abi,
    artifact.bytecode,
    signer,
  ).deploy(admin, admin, 86400);
  await registry.waitForDeployment();
  const transaction = registry.deploymentTransaction();
  const receipt = await transaction.wait();
  const deployment = {
    address: await registry.getAddress(),
    chainId: Number(network.chainId),
    transactionHash: transaction.hash,
    blockNumber: receipt.blockNumber,
    deployedAt: new Date().toISOString(),
    issuer: admin,
    admin,
    adminDelaySeconds: 86400,
  };
  mkdirSync(join(contractRoot, "deployments"), { recursive: true });
  writeFileSync(
    join(contractRoot, "deployments/localhost.json"),
    `${JSON.stringify(deployment, null, 2)}\n`,
  );
  console.log(`TicketRegistry deployed locally at ${deployment.address}`);
  console.log(
    `Set BLOCKCHAIN_ENABLED=true, RPC_URL=${rpcUrl}, CHAIN_ID=31337, CONTRACT_ADDRESS=${deployment.address}`,
  );
  console.log(
    "Deployment recorded in packages/contracts/deployments/localhost.json. Restart the API and start its worker after setting .env.",
  );
} finally {
  provider.destroy();
}
