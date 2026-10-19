import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Database } from "../src/db.js";
import { createOrganizer } from "../src/seed.js";
import { processOne } from "../src/outbox.js";

const secret = "tests-use-a-long-randomized-secret-which-is-never-production";
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Database;
let customer: string;
let organizer: string;
let stranger: string;
let testPool: pg.Pool | undefined;
let schema: string | undefined;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const booking = (
  eventId: string,
  token = customer,
  key = randomUUID(),
  quantity = 1,
) =>
  app.inject({
    method: "POST",
    url: "/api/bookings",
    headers: { ...auth(token), "idempotency-key": key },
    payload: { eventId, quantity },
  });
const now = () => new Date().toISOString();

async function login(email: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().token as string;
}
async function event(capacity = 10) {
  const response = await app.inject({
    method: "POST",
    url: "/api/organizer/events",
    headers: auth(organizer),
    payload: {
      title: "Integration Test Event",
      subtitle: "A test of reliable ticketing",
      category: "concert",
      city: "Bengaluru",
      venue: "Test venue",
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 90_000_000).toISOString(),
      price: 125000,
      currency: "INR",
      capacity,
      image: "/images/concert.jpg",
      featured: false,
      description: "A complete integration test event with limited inventory.",
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().event;
}

before(async () => {
  let databaseUrl: string | undefined;
  if (process.env.TEST_DATABASE_URL) {
    testPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    schema = `chainpass_test_${randomUUID().replaceAll("-", "")}`;
    await testPool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    databaseUrl = url.toString();
  }
  const config = loadConfig({
    production: false,
    databaseUrl,
    sqlitePath: ":memory:",
    qrSecret: secret,
    seedDemo: true,
    demoMode: true,
    blockchainEnabled: false,
  });
  db = await openDatabase(config);
  app = await buildApp({ config, database: db, logger: false });
  customer = await login("explorer@chainpass.local", "Explore123!");
  organizer = await login("organizer@chainpass.local", "Organize123!");
  const registration = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: "Other Customer",
      email: "other@example.com",
      password: "SecureOther123!",
    },
  });
  assert.equal(registration.statusCode, 201, registration.body);
  stranger = registration.json().token;
});
after(async () => {
  await app?.close();
  await db?.close();
  if (testPool && schema) {
    await testPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await testPool.end();
  }
});

test("health, readiness, catalog filters and structured 404", async () => {
  assert.equal((await app.inject("/api/health")).json().status, "ok");
  assert.equal((await app.inject("/api/ready")).json().status, "ready");
  const events = (await app.inject("/api/events")).json().events;
  assert.equal(events.length, 9);
  assert.equal(
    (await app.inject("/api/events?category=rail")).json().events.length,
    2,
  );
  assert.equal(
    (await app.inject("/api/events?city=Delhi")).json().events.length,
    2,
  );
  assert.equal(
    (await app.inject("/api/events?q=Neon")).json().events[0].id,
    "evt-neon-nights",
  );
  assert.equal(
    (await app.inject("/api/events?category=invalid")).statusCode,
    400,
  );
  assert.equal((await app.inject("/api/missing")).statusCode, 404);
  assert.equal((await app.inject("/api/status")).json().blockchain, "disabled");
});

test("authentication stores hashes, rejects weak input, and revokes sessions", async () => {
  assert.equal((await app.inject("/api/auth/me")).statusCode, 401);
  const userRow = await db.get("SELECT * FROM users WHERE email = ?", [
    "explorer@chainpass.local",
  ]);
  assert.match(String(userRow?.password_hash), /^scrypt:/);
  const sessionRow = await db.get("SELECT * FROM sessions WHERE user_id = ?", [
    String(userRow?.id),
  ]);
  assert.notEqual(sessionRow?.token_hash, customer);
  const weak = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "Test", email: "weak@example.com", password: "123" },
  });
  assert.equal(weak.statusCode, 400);
  const wrong = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: "explorer@chainpass.local",
      password: "DefinitelyWrong123!",
    },
  });
  assert.equal(wrong.statusCode, 401);
  const disposable = await login("other@example.com", "SecureOther123!");
  assert.equal(
    (
      await app.inject({ url: "/api/auth/me", headers: auth(disposable) })
    ).json().user.role,
    "customer",
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: auth(disposable),
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: "/api/auth/me", headers: auth(disposable) }))
      .statusCode,
    401,
  );
});

test("organizer role is enforced and registration cannot elevate a role", async () => {
  assert.equal(
    (
      await app.inject({
        url: "/api/organizer/dashboard",
        headers: auth(customer),
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/organizer/events",
        headers: auth(customer),
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/check-in",
        headers: auth(customer),
        payload: {},
      })
    ).statusCode,
    403,
  );
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: "Role Attempt",
      email: "role@example.com",
      password: "SecureRole123!",
      role: "organizer",
    },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().user.role, "customer");
});

test("booking is atomic, accurately priced and owner-private", async () => {
  const experience = await event(5);
  const response = await booking(experience.id, customer, randomUUID(), 2);
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.headers["x-payment-mode"], "demo-no-charge");
  const value = response.json();
  assert.equal(value.total, 250000);
  assert.equal(value.tickets.length, 2);
  assert.equal(value.tickets[0].event.remaining, 3);
  assert.equal(value.tickets[0].chainStatus, "disabled");
  assert.equal(value.tickets[0].transactionHash, null);
  const own = await app.inject({
    url: "/api/tickets",
    headers: auth(customer),
  });
  assert.ok(
    own
      .json()
      .tickets.some(
        (ticket: { id: string }) => ticket.id === value.tickets[0].id,
      ),
  );
  const other = await app.inject({
    url: "/api/tickets",
    headers: auth(stranger),
  });
  assert.ok(
    !other
      .json()
      .tickets.some(
        (ticket: { id: string }) => ticket.id === value.tickets[0].id,
      ),
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/tickets/${value.tickets[0].id}/cancel`,
        headers: auth(stranger),
      })
    ).statusCode,
    404,
  );
});

test("concurrent requests cannot oversell the final seat", async () => {
  const experience = await event(1);
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => booking(experience.id)),
  );
  assert.equal(
    responses.filter((response) => response.statusCode === 201).length,
    1,
  );
  assert.equal(
    responses.filter((response) => response.statusCode === 409).length,
    7,
  );
  assert.equal(
    (await app.inject(`/api/events/${experience.id}`)).json().event.remaining,
    0,
  );
});

test("idempotency coalesces concurrent retries, rejects mismatches, and scopes to user", async () => {
  const experience = await event(5);
  const key = randomUUID();
  const responses = await Promise.all([
    booking(experience.id, customer, key),
    booking(experience.id, customer, key),
  ]);
  for (const response of responses)
    assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(responses[0]!.json(), responses[1]!.json());
  assert.equal(
    (await booking(experience.id, customer, key, 2)).statusCode,
    409,
  );
  const other = await booking(experience.id, stranger, key);
  assert.equal(other.statusCode, 201);
  assert.notEqual(
    other.json().tickets[0].id,
    responses[0]!.json().tickets[0].id,
  );
  assert.equal(
    (await app.inject(`/api/events/${experience.id}`)).json().event.remaining,
    3,
  );
});

test("cancellation restores stock once and invalidates verification and admission", async () => {
  const experience = await event(2);
  const ticket = (await booking(experience.id)).json().tickets[0];
  const responses = await Promise.all(
    [1, 2].map(() =>
      app.inject({
        method: "POST",
        url: `/api/tickets/${ticket.id}/cancel`,
        headers: auth(customer),
      }),
    ),
  );
  assert.equal(
    responses.filter((response) => response.statusCode === 200).length >= 1,
    true,
  );
  assert.equal(
    (await app.inject(`/api/events/${experience.id}`)).json().event.remaining,
    2,
  );
  assert.equal(
    (await app.inject(`/api/verify/${ticket.code}`)).json().valid,
    false,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/check-in",
        headers: auth(organizer),
        payload: { qrPayload: ticket.qrPayload },
      })
    ).statusCode,
    409,
  );
});

test("public verification contains no owner identity, QR credential or ticket id", async () => {
  const experience = await event();
  const ticket = (await booking(experience.id)).json().tickets[0];
  const response = await app.inject(`/api/verify/${ticket.code}`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().valid, true);
  assert.deepEqual(Object.keys(response.json()).sort(), [
    "chainStatus",
    "commitment",
    "eventTitle",
    "status",
    "transactionHash",
    "valid",
  ]);
  assert.ok(!response.body.includes(ticket.userId));
  assert.ok(!response.body.includes(ticket.qrPayload));
});

test("signed check-in rejects tampering and atomically blocks replay", async () => {
  const experience = await event();
  const ticket = (await booking(experience.id)).json().tickets[0];
  const tamper = await app.inject({
    method: "POST",
    url: "/api/check-in",
    headers: auth(organizer),
    payload: { qrPayload: `x${ticket.qrPayload.slice(1)}` },
  });
  assert.equal(tamper.statusCode, 400);
  const responses = await Promise.all(
    [1, 2].map(() =>
      app.inject({
        method: "POST",
        url: "/api/check-in",
        headers: auth(organizer),
        payload: { qrPayload: ticket.qrPayload },
      }),
    ),
  );
  assert.equal(
    responses.filter((response) => response.statusCode === 200).length,
    1,
  );
  assert.equal(
    responses.filter((response) => response.statusCode === 409).length,
    1,
  );
  assert.equal(
    (await app.inject(`/api/verify/${ticket.code}`)).json().status,
    "used",
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/tickets/${ticket.id}/cancel`,
        headers: auth(customer),
      })
    ).statusCode,
    409,
  );
});

test("an organizer cannot check in another organizer’s tickets", async () => {
  await createOrganizer(
    db,
    "Other Organizer",
    "host@example.com",
    "OtherOrganizer123!",
  );
  const otherOrganizer = await login("host@example.com", "OtherOrganizer123!");
  const experience = await event();
  const ticket = (await booking(experience.id)).json().tickets[0];
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/check-in",
        headers: auth(otherOrganizer),
        payload: { qrPayload: ticket.qrPayload },
      })
    ).statusCode,
    403,
  );
});

test("expired experiences cannot be booked, cancelled or checked in", async () => {
  const experience = await event();
  const ticket = (await booking(experience.id)).json().tickets[0];
  await db.run("UPDATE events SET ends_at = ? WHERE id = ?", [
    new Date(Date.now() - 1000).toISOString(),
    experience.id,
  ]);
  assert.equal((await booking(experience.id)).statusCode, 409);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/check-in",
        headers: auth(organizer),
        payload: { qrPayload: ticket.qrPayload },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await app.inject(`/api/verify/${ticket.code}`)).json().status,
    "expired",
  );
});

test("production requires a secret, forbids demo seeds, and blocks live payment issuance", async () => {
  assert.throws(
    () => loadConfig({ production: true, seedDemo: true, qrSecret: secret }),
    /never be seeded/,
  );
  assert.throws(
    () => loadConfig({ production: true, seedDemo: false, qrSecret: "short" }),
    /32 characters/,
  );
  const production = await buildApp({
    database: db,
    logger: false,
    config: {
      production: true,
      seedDemo: false,
      demoMode: false,
      qrSecret: secret,
      blockchainEnabled: false,
    },
  });
  const response = await production.inject({
    method: "POST",
    url: "/api/bookings",
    headers: { ...auth(stranger), "idempotency-key": randomUUID() },
    payload: { eventId: "evt-neon-nights", quantity: 1 },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, "PAYMENTS_NOT_CONFIGURED");
  const demo = await production.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "organizer@chainpass.local", password: "Organize123!" },
  });
  assert.equal(demo.statusCode, 403);
  const inheritedSession = await production.inject({
    url: "/api/auth/me",
    headers: auth(organizer),
  });
  assert.equal(inheritedSession.statusCode, 401);
  await production.close();
});

test("booking and cancellation close at departure, before the experience ends", async () => {
  const experience = await event();
  const ticket = (await booking(experience.id)).json().tickets[0];
  await db.run("UPDATE events SET starts_at = ? WHERE id = ?", [
    new Date(Date.now() - 1000).toISOString(),
    experience.id,
  ]);
  assert.equal((await booking(experience.id)).statusCode, 409);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/tickets/${ticket.id}/cancel`,
        headers: auth(customer),
      })
    ).statusCode,
    409,
  );
});

test("a mined revert clears its transaction for a fresh outbox retry", async () => {
  const experience = await event();
  const ticket = (await booking(experience.id)).json().tickets[0];
  const jobId = randomUUID();
  await db.run(
    "INSERT INTO outbox(id,ticket_id,commitment,status,attempts,available_at,created_at,transaction_hash) VALUES(?,?,?,?,?,?,?,?)",
    [
      jobId,
      ticket.id,
      ticket.commitment,
      "pending",
      0,
      now(),
      now(),
      `0x${"b".repeat(64)}`,
    ],
  );
  await processOne(db, {
    findAnchor: async () => null,
    submit: async () => {
      throw new Error("Do not submit before reconciling");
    },
    confirm: async () => {
      const error = new Error("Reverted");
      error.name = "TransactionRevertedError";
      throw error;
    },
  });
  const job = await db.get("SELECT * FROM outbox WHERE id = ?", [jobId]);
  assert.equal(job?.status, "pending");
  assert.equal(job?.transaction_hash, null);
  assert.equal(job?.last_error, "TransactionRevertedError");
  await db.run("DELETE FROM outbox WHERE id = ?", [jobId]);
});

test("outbox retries failure, recovers an expired lease, and records only confirmed chain hashes", async () => {
  const experience = await event();
  const ticket = (await booking(experience.id)).json().tickets[0];
  const jobId = randomUUID();
  await db.run("UPDATE tickets SET chain_status = 'pending' WHERE id = ?", [
    ticket.id,
  ]);
  await db.run(
    "INSERT INTO outbox(id,ticket_id,commitment,status,attempts,available_at,created_at) VALUES(?,?,?,?,?,?,?)",
    [jobId, ticket.id, ticket.commitment, "pending", 0, now(), now()],
  );
  assert.equal(
    await processOne(db, {
      findAnchor: async () => null,
      submit: async () => {
        throw new Error("provider unavailable");
      },
      confirm: async () => undefined,
    }),
    true,
  );
  const failed = await db.get("SELECT * FROM outbox WHERE id = ?", [jobId]);
  assert.equal(failed?.status, "pending");
  assert.equal(failed?.attempts, 1);
  const pendingTicket = await db.get("SELECT * FROM tickets WHERE id = ?", [
    ticket.id,
  ]);
  assert.equal(pendingTicket?.transaction_hash, null);
  await db.run(
    "UPDATE outbox SET status = 'processing', lease_until = ?, lease_token = ? WHERE id = ?",
    [new Date(Date.now() - 1000).toISOString(), "crashed-worker", jobId],
  );
  const confirmedHash = `0x${"a".repeat(64)}`;
  assert.equal(
    await processOne(db, {
      findAnchor: async () => confirmedHash,
      submit: async () => {
        throw new Error("must not resubmit existing commitment");
      },
      confirm: async () => undefined,
    }),
    true,
  );
  const recovered = await db.get("SELECT * FROM tickets WHERE id = ?", [
    ticket.id,
  ]);
  assert.equal(recovered?.chain_status, "anchored");
  assert.equal(recovered?.transaction_hash, confirmedHash);
  assert.equal(
    await processOne(db, {
      findAnchor: async () => null,
      submit: async () => "",
      confirm: async () => undefined,
    }),
    false,
  );
});
