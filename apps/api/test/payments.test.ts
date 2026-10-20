import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Database } from "../src/db.js";
import {
  expirePaymentHolds,
  paymentConfig,
  type RazorpayGateway,
  type RazorpayOrder,
  type RazorpayPayment,
} from "../src/payments.js";

const keyId = "rzp_test_ProviderIntegrationFixture";
const keySecret = "fixture-key-secret-not-a-real-provider-credential";
const webhookSecret = "fixture-webhook-secret-not-a-real-provider-credential";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const signature = (value: string, secret = keySecret) =>
  createHmac("sha256", secret).update(value).digest("hex");
const identifier = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;

class FakeGateway implements RazorpayGateway {
  orders = new Map<string, RazorpayOrder>();
  payments = new Map<string, RazorpayPayment>();
  createCalls = 0;
  findCalls = 0;
  loseCreateResponse = false;
  failBeforeCreate = false;

  async createOrder(input: {
    amount: number;
    currency: "INR";
    receipt: string;
  }) {
    this.createCalls++;
    if (this.failBeforeCreate) {
      this.failBeforeCreate = false;
      throw new Error(
        "Connection failed before the provider accepted the request.",
      );
    }
    const order = { ...input, id: identifier("order"), status: "created" };
    this.orders.set(order.id, order);
    if (this.loseCreateResponse) {
      this.loseCreateResponse = false;
      throw new Error("Provider accepted the order but its response was lost.");
    }
    return { ...order };
  }
  async findOrder(receipt: string) {
    this.findCalls++;
    const order = [...this.orders.values()].find(
      (item) => item.receipt === receipt,
    );
    return order && { ...order };
  }
  async getOrder(id: string) {
    const order = this.orders.get(id);
    if (!order) throw new Error("Unknown provider order.");
    return { ...order };
  }
  async getPayment(id: string) {
    const payment = this.payments.get(id);
    if (!payment) throw new Error("Unknown provider payment.");
    return { ...payment };
  }
  async listPayments(orderId: string) {
    return [...this.payments.values()]
      .filter((payment) => payment.order_id === orderId)
      .map((payment) => ({ ...payment }));
  }
  capture(orderId: string, overrides: Partial<RazorpayPayment> = {}) {
    const order = this.orders.get(orderId)!;
    order.status = "paid";
    const payment: RazorpayPayment = {
      id: identifier("pay"),
      order_id: orderId,
      amount: order.amount,
      currency: order.currency,
      status: "captured",
      captured: true,
      amount_refunded: 0,
      ...overrides,
    };
    this.payments.set(payment.id, payment);
    return payment;
  }
}

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Database;
let customer: string;
let stranger: string;
let testPool: pg.Pool | undefined;
let schema: string | undefined;
const gateway = new FakeGateway();
let client = 0;

// The suite tests payment invariants; use independent client IPs so its fixtures
// do not exhaust the unrelated per-minute order endpoint budget.
const createOrder = (
  eventId: string,
  quantity = 1,
  key = randomUUID(),
  token = customer,
) =>
  app.inject({
    method: "POST",
    url: "/api/payments/orders",
    remoteAddress: `198.51.${Math.floor(++client / 250)}.${(client % 250) + 1}`,
    headers: { ...auth(token), "idempotency-key": key },
    payload: { eventId, quantity },
  });
const getOrder = (id: string, token = customer) =>
  app.inject({ url: `/api/payments/orders/${id}`, headers: auth(token) });
const confirm = (
  id: string,
  payment: RazorpayPayment,
  token = customer,
  signed = signature(`${payment.order_id}|${payment.id}`),
) =>
  app.inject({
    method: "POST",
    url: `/api/payments/orders/${id}/confirm`,
    headers: auth(token),
    payload: {
      razorpay_order_id: payment.order_id,
      razorpay_payment_id: payment.id,
      razorpay_signature: signed,
    },
  });
async function event(capacity = 10, category = "concert") {
  const id = randomUUID();
  await db.run(
    "INSERT INTO events(id,title,subtitle,category,city,venue,starts_at,ends_at,price,currency,capacity,remaining,image,featured,description,organizer_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      id,
      "Payment integration event",
      "Reserved inventory fixture",
      category,
      "Bengaluru",
      "Test venue",
      new Date(Date.now() + 86_400_000).toISOString(),
      new Date(Date.now() + 90_000_000).toISOString(),
      12500,
      "INR",
      capacity,
      capacity,
      "/images/concert.jpg",
      0,
      "An isolated payment integration test event.",
      "usr-demo-organizer",
    ],
  );
  return id;
}
async function remaining(id: string) {
  return Number(
    (await db.get("SELECT remaining FROM events WHERE id = ?", [id]))!
      .remaining,
  );
}
async function ticketCount(id: string) {
  return Number(
    (await db.get(
      "SELECT COUNT(*) AS total FROM payment_tickets WHERE order_id = ?",
      [id],
    ))!.total,
  );
}
async function expire(id: string) {
  await db.run("UPDATE payment_orders SET expires_at = ? WHERE id = ?", [
    new Date(Date.now() - 1000).toISOString(),
    id,
  ]);
  await expirePaymentHolds(db);
}
function webhook(
  payment: RazorpayPayment,
  eventId = identifier("evt"),
  body?: string,
) {
  const payload =
    body ??
    JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: { entity: { id: payment.id, order_id: payment.order_id } },
      },
    });
  return app.inject({
    method: "POST",
    url: "/api/payments/webhook",
    headers: {
      "content-type": "application/json",
      "x-razorpay-event-id": eventId,
      "x-razorpay-signature": signature(payload, webhookSecret),
    },
    payload,
  });
}

before(async () => {
  let databaseUrl: string | undefined;
  if (process.env.TEST_DATABASE_URL) {
    testPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    schema = `chainpass_payments_${randomUUID().replaceAll("-", "")}`;
    await testPool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    databaseUrl = url.toString();
  }
  const config = loadConfig({
    production: false,
    demoMode: true,
    seedDemo: true,
    databaseUrl,
    sqlitePath: ":memory:",
    blockchainEnabled: false,
    qrSecret: "payments-fixture-uses-a-long-non-production-signing-secret",
    firebaseProjectId: "",
    firebaseApiKey: "",
    firebaseAuthDomain: "",
    firebaseAppId: "",
    razorpayKeyId: keyId,
    razorpayKeySecret: keySecret,
    razorpayWebhookSecret: webhookSecret,
    paymentHoldMinutes: 15,
  });
  db = await openDatabase(config);
  app = await buildApp({
    config,
    database: db,
    logger: false,
    razorpayGateway: gateway,
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "explorer@chainpass.local", password: "Explore123!" },
  });
  assert.equal(login.statusCode, 200, login.body);
  customer = login.json().token;
  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: "Other Customer",
      email: "payment-stranger@example.com",
      password: "AnotherStrongPassword123!",
    },
  });
  assert.equal(registered.statusCode, 201, registered.body);
  stranger = registered.json().token;
});

after(async () => {
  await app?.close();
  await db?.close();
  if (testPool && schema) {
    await testPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await testPool.end();
  }
});

test("public payment settings expose only the publishable key and validate incomplete credentials", async () => {
  const response = await app.inject("/api/payments/config");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { enabled: true, mode: "test", keyId });
  assert.ok(!response.body.includes(keySecret));
  assert.ok(!response.body.includes(webhookSecret));
  const disabled = loadConfig({
    production: false,
    blockchainEnabled: false,
    razorpayKeyId: "",
    razorpayKeySecret: "",
    razorpayWebhookSecret: "",
  });
  assert.deepEqual(paymentConfig(disabled), {
    enabled: false,
    mode: "disabled",
  });
  assert.throws(
    () => loadConfig({ ...disabled, razorpayKeyId: keyId }),
    /requires/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...disabled,
        razorpayKeyId: "rzp_live_fixture",
        razorpayKeySecret: keySecret,
        razorpayWebhookSecret: webhookSecret,
      }),
    /Live payments require/,
  );
});

test("orders reserve inventory once, derive prices on the server and enforce idempotency", async () => {
  const eventId = await event(4);
  const requestKey = randomUUID();
  const callsBefore = gateway.createCalls;
  const response = await createOrder(eventId, 2, requestKey);
  assert.equal(response.statusCode, 201, response.body);
  const order = response.json();
  assert.equal(order.amount, 25000);
  assert.equal(order.status, "pending");
  assert.equal(await remaining(eventId), 2);
  assert.equal(await ticketCount(order.id), 0);
  const replay = await createOrder(eventId, 2, requestKey);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().id, order.id);
  assert.equal(gateway.createCalls, callsBefore + 1);
  assert.equal(await remaining(eventId), 2);
  const conflict = await createOrder(eventId, 1, requestKey);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, "IDEMPOTENCY_CONFLICT");
  const forged = await app.inject({
    method: "POST",
    url: "/api/payments/orders",
    headers: { ...auth(customer), "idempotency-key": randomUUID() },
    payload: { eventId, quantity: 1, amount: 1 },
  });
  assert.equal(forged.statusCode, 400);
  assert.equal(await remaining(eventId), 2);
});

test("concurrent checkouts cannot oversell the last seat", async () => {
  const eventId = await event(1);
  const responses = await Promise.all([
    createOrder(eventId),
    createOrder(eventId),
  ]);
  assert.deepEqual(
    responses.map((response) => response.statusCode).sort(),
    [201, 409],
  );
  assert.equal(
    responses.find((response) => response.statusCode === 409)!.json().error,
    "SOLD_OUT",
  );
  assert.equal(await remaining(eventId), 0);
  assert.equal(
    Number(
      (await db.get(
        "SELECT COUNT(*) AS total FROM payment_orders WHERE event_id = ?",
        [eventId],
      ))!.total,
    ),
    1,
  );
});

test("concurrent identical checkout requests create one provider order and one inventory hold", async () => {
  const eventId = await event(3);
  const requestKey = randomUUID();
  const callsBefore = gateway.createCalls;
  const responses = await Promise.all([
    createOrder(eventId, 2, requestKey),
    createOrder(eventId, 2, requestKey),
    createOrder(eventId, 2, requestKey),
  ]);
  assert.equal(
    responses.filter((response) => response.statusCode === 201).length,
    1,
  );
  for (const response of responses) {
    assert.ok([200, 201, 409].includes(response.statusCode), response.body);
    if (response.statusCode === 409)
      assert.equal(response.json().error, "PAYMENT_ORDER_CREATING");
  }
  const recovered = await createOrder(eventId, 2, requestKey);
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(gateway.createCalls, callsBefore + 1);
  assert.equal(await remaining(eventId), 1);
  assert.equal(
    Number(
      (await db.get(
        "SELECT COUNT(*) AS total FROM payment_orders WHERE event_id = ?",
        [eventId],
      ))!.total,
    ),
    1,
  );
});

test("confirmation requires ownership, a valid signature and captured provider resources", async () => {
  const eventId = await event(3);
  const order = (await createOrder(eventId, 2)).json();
  const payment = gateway.capture(order.providerOrderId, {
    status: "authorized",
    captured: false,
  });
  const foreign = await confirm(order.id, payment, stranger);
  assert.equal(foreign.statusCode, 404);
  assert.equal((await getOrder(order.id, stranger)).statusCode, 404);
  const tampered = await confirm(order.id, payment, customer, "0".repeat(64));
  assert.equal(tampered.statusCode, 400);
  assert.equal(tampered.json().error, "INVALID_PAYMENT_SIGNATURE");
  const authorized = await confirm(order.id, payment);
  assert.equal(authorized.statusCode, 409);
  assert.equal(authorized.json().error, "PAYMENT_NOT_CAPTURED");
  assert.equal(await ticketCount(order.id), 0);
  payment.status = "captured";
  payment.captured = true;
  const confirmed = await confirm(order.id, payment);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().status, "paid");
  assert.equal(confirmed.json().booking.tickets.length, 2);
  assert.equal(confirmed.json().booking.total, 25000);
  assert.equal(await ticketCount(order.id), 2);
  assert.equal(await remaining(eventId), 1);
  const replay = await confirm(order.id, payment);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json().booking, confirmed.json().booking);
  assert.equal(await ticketCount(order.id), 2);
});

test("status checks recover a captured payment even when the browser callback never arrived", async () => {
  const eventId = await event(2);
  const order = (await createOrder(eventId)).json();
  gateway.capture(order.providerOrderId);
  assert.equal(await ticketCount(order.id), 0);
  const recovered = await getOrder(order.id);
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().status, "paid");
  assert.equal(recovered.json().booking.tickets.length, 1);
  assert.equal(await ticketCount(order.id), 1);
  assert.equal(await remaining(eventId), 1);
  assert.equal(
    (await getOrder(order.id)).json().booking.tickets[0].id,
    recovered.json().booking.tickets[0].id,
  );
  assert.equal(await ticketCount(order.id), 1);
});

test("payment and order amount, currency and refunded status are verified before issuing tickets", async () => {
  const eventId = await event(2);
  const order = (await createOrder(eventId)).json();
  const payment = gateway.capture(order.providerOrderId, { amount: 1 });
  assert.equal(
    (await confirm(order.id, payment)).json().error,
    "PAYMENT_MISMATCH",
  );
  payment.amount = order.amount;
  payment.currency = "USD";
  assert.equal(
    (await confirm(order.id, payment)).json().error,
    "PAYMENT_MISMATCH",
  );
  payment.currency = "INR";
  payment.amount_refunded = 1;
  assert.equal(
    (await confirm(order.id, payment)).json().error,
    "PAYMENT_NOT_CAPTURED",
  );
  payment.amount_refunded = 0;
  gateway.orders.get(order.providerOrderId)!.status = "attempted";
  assert.equal(
    (await confirm(order.id, payment)).json().error,
    "PAYMENT_NOT_CAPTURED",
  );
  gateway.orders.get(order.providerOrderId)!.status = "paid";
  gateway.orders.get(order.providerOrderId)!.amount++;
  assert.equal(
    (await confirm(order.id, payment)).json().error,
    "PAYMENT_MISMATCH",
  );
  assert.equal(await ticketCount(order.id), 0);
});

test("webhooks authenticate the exact raw body and deduplicate deliveries without reissuing tickets", async () => {
  const eventId = await event(2);
  const order = (await createOrder(eventId)).json();
  const payment = gateway.capture(order.providerOrderId);
  const deliveryId = identifier("evt");
  const compact = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: { entity: { id: payment.id, order_id: payment.order_id } },
    },
  });
  const spaced = JSON.stringify(JSON.parse(compact), null, 2);
  const invalid = await app.inject({
    method: "POST",
    url: "/api/payments/webhook",
    headers: {
      "content-type": "application/json",
      "x-razorpay-event-id": deliveryId,
      "x-razorpay-signature": signature(compact, webhookSecret),
    },
    payload: spaced,
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, "INVALID_WEBHOOK_SIGNATURE");
  assert.equal(await ticketCount(order.id), 0);
  const accepted = await webhook(payment, deliveryId, spaced);
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(await ticketCount(order.id), 1);
  assert.equal((await webhook(payment, deliveryId, spaced)).statusCode, 200);
  assert.equal(
    (await webhook(payment, identifier("evt"), spaced)).statusCode,
    200,
  );
  assert.equal(await ticketCount(order.id), 1);
  assert.equal(await remaining(eventId), 1);
  const conflict = await webhook(payment, deliveryId, compact);
  assert.equal(conflict.statusCode, 400);
  assert.equal(conflict.json().error, "WEBHOOK_CONFLICT");
  assert.equal((await getOrder(order.id)).json().status, "paid");
});

test("concurrent callback and webhook confirmation issue a single booking", async () => {
  const eventId = await event(3);
  const order = (await createOrder(eventId, 2)).json();
  const payment = gateway.capture(order.providerOrderId);
  const responses = await Promise.all([
    confirm(order.id, payment),
    webhook(payment),
    confirm(order.id, payment),
  ]);
  assert.deepEqual(
    responses.map((response) => response.statusCode),
    [200, 200, 200],
  );
  assert.equal(await ticketCount(order.id), 2);
  assert.equal(await remaining(eventId), 1);
});

test("expired holds release stock once and late capture reacquires available seats", async () => {
  const eventId = await event(2);
  const order = (await createOrder(eventId, 2)).json();
  assert.equal(await remaining(eventId), 0);
  await expire(order.id);
  await Promise.all([expirePaymentHolds(db), expirePaymentHolds(db)]);
  assert.equal(await remaining(eventId), 2);
  assert.equal((await getOrder(order.id)).json().status, "expired");
  const payment = gateway.capture(order.providerOrderId);
  const confirmed = await confirm(order.id, payment);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().status, "paid");
  assert.equal(await remaining(eventId), 0);
  assert.equal(await ticketCount(order.id), 2);
  await expirePaymentHolds(db);
  assert.equal(await remaining(eventId), 0);
});

test("late capture without capacity enters refund review and cannot fabricate tickets", async () => {
  const eventId = await event(1);
  const expiredOrder = (await createOrder(eventId)).json();
  await expire(expiredOrder.id);
  const replacement = await createOrder(eventId, 1, randomUUID(), stranger);
  assert.equal(replacement.statusCode, 201, replacement.body);
  const payment = gateway.capture(expiredOrder.providerOrderId);
  const result = await confirm(expiredOrder.id, payment);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().status, "refund_required");
  assert.equal(result.json().booking, undefined);
  assert.equal(await ticketCount(expiredOrder.id), 0);
  assert.equal(await remaining(eventId), 0);
  assert.equal(
    (await confirm(expiredOrder.id, payment)).json().status,
    "refund_required",
  );
  assert.equal((await webhook(payment)).statusCode, 200);
  assert.equal(await remaining(eventId), 0);
  const stored = await db.get(
    "SELECT review_reason,provider_payment_id FROM payment_orders WHERE id = ?",
    [expiredOrder.id],
  );
  assert.equal(stored!.review_reason, "CAPTURE_AFTER_INVENTORY_EXPIRED");
  assert.equal(stored!.provider_payment_id, payment.id);
});

test("capture after booking closes releases an active hold and requires refund review", async () => {
  const eventId = await event(2);
  const order = (await createOrder(eventId)).json();
  await db.run("UPDATE events SET starts_at = ? WHERE id = ?", [
    new Date(Date.now() - 1000).toISOString(),
    eventId,
  ]);
  const payment = gateway.capture(order.providerOrderId);
  const result = await confirm(order.id, payment);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().status, "refund_required");
  assert.equal(await remaining(eventId), 2);
  assert.equal(await ticketCount(order.id), 0);
  await expirePaymentHolds(db);
  assert.equal(await remaining(eventId), 2);
});

test("a lost provider create response recovers by receipt without a duplicate provider POST", async () => {
  const eventId = await event(2);
  const requestKey = randomUUID();
  const callsBefore = gateway.createCalls;
  gateway.loseCreateResponse = true;
  const first = await createOrder(eventId, 1, requestKey);
  assert.equal(first.statusCode, 503, first.body);
  assert.equal(first.json().error, "PAYMENT_PROVIDER_UNAVAILABLE");
  assert.equal(await remaining(eventId), 1);
  const recovered = await createOrder(eventId, 1, requestKey);
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().status, "pending");
  assert.equal(gateway.createCalls, callsBefore + 1);
  assert.equal(await remaining(eventId), 1);
  const payment = gateway.capture(recovered.json().providerOrderId);
  assert.equal(
    (await confirm(recovered.json().id, payment)).json().status,
    "paid",
  );
  assert.equal(await ticketCount(recovered.json().id), 1);
});

test("an ambiguous failure with no matching provider order is not automatically charged again", async () => {
  const eventId = await event(1);
  const requestKey = randomUUID();
  const callsBefore = gateway.createCalls;
  gateway.failBeforeCreate = true;
  assert.equal((await createOrder(eventId, 1, requestKey)).statusCode, 503);
  const retry = await createOrder(eventId, 1, requestKey);
  assert.equal(retry.statusCode, 409, retry.body);
  assert.equal(retry.json().error, "PAYMENT_ORDER_CREATING");
  assert.equal(gateway.createCalls, callsBefore + 1);
  const stored = await db.get(
    "SELECT id FROM payment_orders WHERE request_key = ?",
    [requestKey],
  );
  await expire(String(stored!.id));
  assert.equal(await remaining(eventId), 1);
  const expired = await createOrder(eventId, 1, requestKey);
  assert.equal(expired.statusCode, 200, expired.body);
  assert.equal(expired.json().status, "expired");
  assert.equal(gateway.createCalls, callsBefore + 1);
});

test("signed webhooks recover a provider order whose creation response was lost", async () => {
  const eventId = await event(1);
  const requestKey = randomUUID();
  gateway.loseCreateResponse = true;
  assert.equal((await createOrder(eventId, 1, requestKey)).statusCode, 503);
  const row = await db.get(
    "SELECT * FROM payment_orders WHERE request_key = ?",
    [requestKey],
  );
  assert.equal(row!.provider_order_id, null);
  const providerOrder = [...gateway.orders.values()].find(
    (item) => item.receipt === row!.id,
  )!;
  const payment = gateway.capture(providerOrder.id);
  const result = await webhook(payment);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal((await getOrder(String(row!.id))).json().status, "paid");
  assert.equal(await ticketCount(String(row!.id)), 1);
  assert.equal(await remaining(eventId), 0);
});

test("railway sandbox bookings and free generic checkout cannot bypass the payment boundary", async () => {
  const railEvent = await event(2, "rail");
  const rail = await createOrder(railEvent);
  assert.equal(rail.statusCode, 409);
  assert.equal(rail.json().error, "RAIL_SANDBOX_ONLY");
  assert.equal(await remaining(railEvent), 2);
  const eventId = await event(2);
  const bypass = await app.inject({
    method: "POST",
    url: "/api/bookings",
    headers: { ...auth(customer), "idempotency-key": randomUUID() },
    payload: { eventId, quantity: 1 },
  });
  assert.equal(bypass.statusCode, 409);
  assert.equal(bypass.json().error, "PAYMENT_CHECKOUT_REQUIRED");
  assert.equal(await remaining(eventId), 2);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/payments/orders",
        headers: { "idempotency-key": randomUUID() },
        payload: { eventId, quantity: 1 },
      })
    ).statusCode,
    401,
  );
});

test("paid tickets cannot use demo cancellation to release seats without a refund workflow", async () => {
  const eventId = await event(2);
  const order = (await createOrder(eventId)).json();
  const payment = gateway.capture(order.providerOrderId);
  const paid = await confirm(order.id, payment);
  assert.equal(paid.statusCode, 200, paid.body);
  const ticket = paid.json().booking.tickets[0];
  const cancelled = await app.inject({
    method: "POST",
    url: `/api/tickets/${ticket.id}/cancel`,
    headers: auth(customer),
  });
  assert.equal(cancelled.statusCode, 409, cancelled.body);
  assert.match(cancelled.json().message, /refund|support/i);
  assert.equal(
    (await db.get("SELECT status FROM tickets WHERE id = ?", [ticket.id]))!
      .status,
    "valid",
  );
  assert.equal(await remaining(eventId), 1);
  const otherOrders = (
    await app.inject({ url: "/api/payments/orders", headers: auth(stranger) })
  ).json().orders;
  assert.ok(
    !otherOrders.some((candidate: { id: string }) => candidate.id === order.id),
  );
});
