import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { buildApp } from "../apps/api/dist/app.js";
import { loadConfig } from "../apps/api/dist/config.js";
import { openDatabase } from "../apps/api/dist/db.js";
import { createChainAdapter } from "../apps/api/dist/chain.js";
import { processOne } from "../apps/api/dist/outbox.js";

const deployment = JSON.parse(
  await readFile(
    new URL(
      "../packages/contracts/deployments/localhost.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const config = loadConfig({
  production: false,
  demoMode: true,
  seedDemo: true,
  databaseUrl: undefined,
  sqlitePath: ":memory:",
  blockchainEnabled: true,
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  registryAddress: deployment.address,
  issuerPrivateKey: "",
});
const db = await openDatabase(config);
const app = await buildApp({ config, database: db, logger: false });
let chain;
try {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "explorer@chainpass.local", password: "Explore123!" },
  });
  assert.equal(login.statusCode, 200);
  const headers = {
    authorization: `Bearer ${login.json().token}`,
    "idempotency-key": randomUUID(),
  };
  const booking = await app.inject({
    method: "POST",
    url: "/api/bookings",
    headers,
    payload: { eventId: "evt-neon-nights", quantity: 1 },
  });
  assert.equal(booking.statusCode, 201, booking.body);
  const ticket = booking.json().tickets[0];
  assert.equal(ticket.chainStatus, "pending");
  chain = await createChainAdapter(config);
  assert.equal(await processOne(db, chain.adapter), true);
  const wallet = await app.inject({ url: "/api/tickets", headers });
  const anchored = wallet.json().tickets.find((item) => item.id === ticket.id);
  assert.equal(anchored.chainStatus, "anchored");
  assert.match(anchored.transactionHash, /^0x[0-9a-f]{64}$/i);
  assert.equal(
    await chain.adapter.findAnchor(ticket.commitment),
    anchored.transactionHash,
  );
  assert.equal(await processOne(db, chain.adapter), false);
  console.log(
    JSON.stringify(
      {
        verified: true,
        chainId: 31337,
        registry: deployment.address,
        transactionHash: anchored.transactionHash,
        checks: [
          "API booking",
          "transactional outbox",
          "real EVM confirmation",
          "wallet receipt",
          "registry event recovery",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  chain?.close();
  await app.close();
  await db.close();
}
