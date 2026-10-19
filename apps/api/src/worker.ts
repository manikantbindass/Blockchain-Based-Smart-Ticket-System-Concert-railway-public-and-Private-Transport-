import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createChainAdapter } from "./chain.js";
import { processOne } from "./outbox.js";

const config = loadConfig();
if (!config.blockchainEnabled) {
  console.error(
    "Blockchain worker is disabled. Configure a deployed registry and set BLOCKCHAIN_ENABLED=true.",
  );
  process.exitCode = 1;
} else {
  const db = await openDatabase(config);
  let chain: Awaited<ReturnType<typeof createChainAdapter>> | undefined;
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      stopping = true;
    });
  try {
    chain = await createChainAdapter(config);
    console.log(
      `ChainPass outbox worker connected to chain ${config.chainId}.`,
    );
    while (!stopping) {
      const processed = await processOne(db, chain.adapter);
      if (!processed) await delay(2000);
    }
  } finally {
    chain?.close();
    await db.close();
  }
}
