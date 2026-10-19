import { defineConfig } from "hardhat/config";

// Compilation uses the pinned solc npm package in scripts/compile.mjs.
// Hardhat supplies an isolated EVM and a loopback-only RPC development node.
export default defineConfig({
  defaultNetwork: "hardhat",
  networks: {
    hardhat: { type: "edr-simulated", chainType: "l1", chainId: 31337 },
  },
});
