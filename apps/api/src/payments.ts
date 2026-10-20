import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  Booking,
  PaymentConfig,
  PaymentOrder,
  User,
} from "@chainpass/shared";
import type { Config } from "./config.js";
import type { Database, Queryable, Row } from "./db.js";
import { ticketFrom } from "./models.js";
import { commitment, sha256 } from "./security.js";

const providerId = z
  .string()
  .regex(/^(order|pay)_[A-Za-z0-9]+$/)
  .max(100);
const providerOrderSchema = z.object({
  id: providerId.refine((id) => id.startsWith("order_")),
  amount: z.number().int().positive(),
  currency: z.string(),
  receipt: z.string(),
  status: z.string(),
});
const providerPaymentSchema = z.object({
  id: providerId.refine((id) => id.startsWith("pay_")),
  order_id: providerId.refine((id) => id.startsWith("order_")),
  amount: z.number().int().positive(),
  currency: z.string(),
  status: z.string(),
  captured: z.boolean(),
  amount_refunded: z.number().int().nonnegative(),
});
export type RazorpayOrder = z.infer<typeof providerOrderSchema>;
export type RazorpayPayment = z.infer<typeof providerPaymentSchema>;
export interface RazorpayGateway {
  createOrder(input: {
    amount: number;
    currency: "INR";
    receipt: string;
  }): Promise<RazorpayOrder>;
  findOrder(receipt: string): Promise<RazorpayOrder | undefined>;
  getOrder(id: string): Promise<RazorpayOrder>;
  getPayment(id: string): Promise<RazorpayPayment>;
  listPayments(orderId: string): Promise<RazorpayPayment[]>;
}

/** This adapter never returns provider errors, card details or credentials to callers. */
export function createRazorpayGateway(config: Config): RazorpayGateway {
  async function request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`https://api.razorpay.com/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString("base64")}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`Razorpay request failed (${response.status}).`);
    return response.json();
  }
  return {
    async createOrder(input) {
      return providerOrderSchema.parse(
        await request("orders", { ...input, partial_payment: false }),
      );
    },
    async findOrder(receipt) {
      const result = z
        .object({ items: z.array(providerOrderSchema) })
        .parse(
          await request(
            `orders?receipt=${encodeURIComponent(receipt)}&count=100`,
          ),
        );
      const matches = result.items.filter((order) => order.receipt === receipt);
      if (matches.length > 1)
        throw new Error(
          "Multiple provider orders require operator reconciliation.",
        );
      return matches[0];
    },
    async getOrder(id) {
      return providerOrderSchema.parse(
        await request(`orders/${encodeURIComponent(id)}`),
      );
    },
    async getPayment(id) {
      return providerPaymentSchema.parse(
        await request(`payments/${encodeURIComponent(id)}`),
      );
    },
    async listPayments(orderId) {
      return z
        .object({ items: z.array(providerPaymentSchema) })
        .parse(await request(`orders/${encodeURIComponent(orderId)}/payments`))
        .items;
    },
  };
}

export function paymentConfig(config: Config): PaymentConfig {
  const enabled = Boolean(
    config.razorpayKeyId &&
    config.razorpayKeySecret &&
    config.razorpayWebhookSecret,
  );
  return enabled
    ? {
        enabled: true,
        mode: config.razorpayKeyId.startsWith("rzp_live_") ? "live" : "test",
        keyId: config.razorpayKeyId,
      }
    : { enabled: false, mode: "disabled" };
}

function validSignature(
  body: string | Buffer,
  signature: unknown,
  secret: string,
): boolean {
  if (typeof signature !== "string" || !/^[a-fA-F0-9]{64}$/.test(signature))
    return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
const now = () => new Date().toISOString();

/** Release each hold exactly once, even when several API instances sweep together. */
export async function expirePaymentHolds(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    const timestamp = now();
    const rows = await tx.all(
      "SELECT id,event_id,quantity FROM payment_orders WHERE hold_active = 1 AND expires_at <= ? ORDER BY id LIMIT 500",
      [timestamp],
    );
    for (const row of rows) {
      const changed = await tx.run(
        "UPDATE payment_orders SET hold_active = 0,status = 'expired',updated_at = ? WHERE id = ? AND hold_active = 1 AND status IN ('creating','pending') AND expires_at <= ?",
        [timestamp, String(row.id), timestamp],
      );
      if (changed)
        await tx.run(
          "UPDATE events SET remaining = remaining + ? WHERE id = ?",
          [Number(row.quantity), String(row.event_id)],
        );
    }
  });
}

type Fail = (status: number, code: string, message: string) => never;
interface PaymentDependencies {
  authenticate: (request: FastifyRequest) => Promise<User>;
  fail: Fail;
  gateway?: RazorpayGateway;
}

export async function registerPaymentRoutes(
  app: FastifyInstance,
  db: Database,
  config: Config,
  {
    authenticate,
    fail,
    gateway = createRazorpayGateway(config),
  }: PaymentDependencies,
) {
  const settings = paymentConfig(config);
  const requireEnabled = () => {
    if (!settings.enabled)
      fail(
        503,
        "PAYMENTS_NOT_CONFIGURED",
        "UPI and card payments are not configured yet.",
      );
  };
  const orderParam = (request: FastifyRequest) =>
    z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
  const lock = db.kind === "postgres" ? " FOR UPDATE" : "";
  async function owned(id: string, userId: string) {
    const row = await db.get(
      "SELECT * FROM payment_orders WHERE id = ? AND user_id = ?",
      [id, userId],
    );
    if (!row) return fail(404, "NOT_FOUND", "Payment order not found.");
    if (row.key_id !== config.razorpayKeyId)
      return fail(
        409,
        "PAYMENT_KEY_CHANGED",
        "This payment needs support because the payment configuration changed.",
      );
    return row;
  }
  async function external<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      return fail(
        503,
        "PAYMENT_PROVIDER_UNAVAILABLE",
        "The payment provider could not be reached. Retry this same checkout to recover its status.",
      );
    }
  }
  function matchesOrder(row: Row, order: RazorpayOrder) {
    if (
      order.receipt !== row.id ||
      order.amount !== Number(row.amount) ||
      order.currency !== row.currency ||
      (row.provider_order_id && row.provider_order_id !== order.id)
    ) {
      fail(
        409,
        "PAYMENT_MISMATCH",
        "The provider order does not match this checkout. Contact support.",
      );
    }
  }
  async function attachOrder(row: Row, order: RazorpayOrder) {
    matchesOrder(row, order);
    await db.run(
      "UPDATE payment_orders SET provider_order_id = ?,status = CASE WHEN status = 'creating' THEN 'pending' ELSE status END,updated_at = ? WHERE id = ? AND (provider_order_id IS NULL OR provider_order_id = ?)",
      [order.id, now(), String(row.id), order.id],
    );
    return (await db.get("SELECT * FROM payment_orders WHERE id = ?", [
      String(row.id),
    ]))!;
  }
  async function bookingFor(row: Row, tx: Queryable): Promise<Booking> {
    const tickets = await tx.all(
      "SELECT t.* FROM tickets t JOIN payment_tickets p ON p.ticket_id = t.id WHERE p.order_id = ? ORDER BY t.id",
      [String(row.id)],
    );
    return {
      tickets: await Promise.all(
        tickets.map((ticket) => ticketFrom(ticket, tx, config.qrSecret)),
      ),
      total: Number(row.amount),
    };
  }
  async function present(
    row: Row,
    includeCreating = false,
  ): Promise<PaymentOrder> {
    if (!includeCreating && !row.provider_order_id && row.status !== "expired")
      return fail(
        409,
        "PAYMENT_ORDER_CREATING",
        "The payment order is still being created. Retry with the same checkout key.",
      );
    return {
      id: String(row.id),
      providerOrderId: String(row.provider_order_id || ""),
      keyId: String(row.key_id),
      amount: Number(row.amount),
      currency: "INR",
      status: row.status as PaymentOrder["status"],
      expiresAt: String(row.expires_at),
      mode: row.mode as "test" | "live",
      ...(row.status === "paid" ? { booking: await bookingFor(row, db) } : {}),
    };
  }
  async function finalize(
    localId: string,
    providerOrder: RazorpayOrder,
    payment: RazorpayPayment,
    webhook?: { id: string; hash: string },
  ) {
    return db.transaction(async (tx) => {
      const row = (await tx.get(
        `SELECT * FROM payment_orders WHERE id = ?${lock}`,
        [localId],
      ))!;
      matchesOrder(row, providerOrder);
      if (
        payment.order_id !== providerOrder.id ||
        payment.amount !== Number(row.amount) ||
        payment.currency !== row.currency
      ) {
        return fail(
          409,
          "PAYMENT_MISMATCH",
          "The payment amount or order does not match this checkout.",
        );
      }
      // A Checkout callback proves a signed response, not capture. Both provider resources must agree.
      if (
        payment.status !== "captured" ||
        !payment.captured ||
        providerOrder.status !== "paid" ||
        payment.amount_refunded !== 0
      ) {
        return fail(
          409,
          "PAYMENT_NOT_CAPTURED",
          "Payment is not confirmed as captured. Check its status again shortly.",
        );
      }
      if (row.provider_payment_id && row.provider_payment_id !== payment.id)
        return fail(
          409,
          "PAYMENT_MISMATCH",
          "This checkout already references another payment.",
        );
      if (webhook) {
        const previous = await tx.get(
          "SELECT payload_hash FROM payment_webhooks WHERE event_id = ?",
          [webhook.id],
        );
        if (previous && previous.payload_hash !== webhook.hash)
          return fail(
            400,
            "WEBHOOK_CONFLICT",
            "Webhook identifier was already used.",
          );
      }
      const timestamp = now();
      if (row.status !== "paid" && row.status !== "refund_required") {
        const event = (await tx.get("SELECT * FROM events WHERE id = ?", [
          String(row.event_id),
        ]))!;
        const eventOpen = String(event.starts_at) > timestamp;
        let reserved = Number(row.hold_active) === 1;
        if (!reserved && eventOpen)
          reserved = Boolean(
            await tx.run(
              "UPDATE events SET remaining = remaining - ? WHERE id = ? AND remaining >= ? AND starts_at > ?",
              [
                Number(row.quantity),
                String(row.event_id),
                Number(row.quantity),
                timestamp,
              ],
            ),
          );
        if (!eventOpen || !reserved) {
          if (Number(row.hold_active) === 1)
            await tx.run(
              "UPDATE events SET remaining = remaining + ? WHERE id = ?",
              [Number(row.quantity), String(row.event_id)],
            );
          await tx.run(
            "UPDATE payment_orders SET status = 'refund_required',hold_active = 0,provider_payment_id = ?,review_reason = ?,updated_at = ? WHERE id = ?",
            [
              payment.id,
              eventOpen
                ? "CAPTURE_AFTER_INVENTORY_EXPIRED"
                : "CAPTURE_AFTER_BOOKING_CLOSED",
              timestamp,
              localId,
            ],
          );
        } else {
          const unitPrice = Number(row.amount) / Number(row.quantity);
          for (let index = 0; index < Number(row.quantity); index++) {
            const id = randomUUID();
            const code = `CP-${randomBytes(8).toString("hex").toUpperCase()}`;
            const hash = commitment(id, String(row.event_id));
            await tx.run(
              "INSERT INTO tickets(id,event_id,user_id,code,status,created_at,price_paid,commitment,chain_status,transaction_hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
              [
                id,
                String(row.event_id),
                String(row.user_id),
                code,
                "valid",
                timestamp,
                unitPrice,
                hash,
                config.blockchainEnabled ? "pending" : "disabled",
                null,
              ],
            );
            await tx.run(
              "INSERT INTO payment_tickets(ticket_id,order_id) VALUES(?,?)",
              [id, localId],
            );
            if (config.blockchainEnabled)
              await tx.run(
                "INSERT INTO outbox(id,ticket_id,commitment,status,attempts,available_at,created_at) VALUES(?,?,?,?,?,?,?)",
                [randomUUID(), id, hash, "pending", 0, timestamp, timestamp],
              );
          }
          await tx.run(
            "UPDATE payment_orders SET status = 'paid',hold_active = 0,provider_payment_id = ?,updated_at = ? WHERE id = ?",
            [payment.id, timestamp, localId],
          );
        }
      }
      if (webhook)
        await tx.run(
          "INSERT INTO payment_webhooks(event_id,payload_hash,processed_at) VALUES(?,?,?) ON CONFLICT(event_id) DO NOTHING",
          [webhook.id, webhook.hash, timestamp],
        );
      return (await tx.get("SELECT * FROM payment_orders WHERE id = ?", [
        localId,
      ]))!;
    });
  }
  async function reconcile(row: Row) {
    if (row.status === "paid" || row.status === "refund_required") return row;
    let providerOrder: RazorpayOrder | undefined;
    if (!row.provider_order_id) {
      providerOrder = await external(() => gateway.findOrder(String(row.id)));
      if (!providerOrder) return row;
      row = await attachOrder(row, providerOrder);
    } else
      providerOrder = await external(() =>
        gateway.getOrder(String(row.provider_order_id)),
      );
    matchesOrder(row, providerOrder);
    const payments = await external(() =>
      gateway.listPayments(providerOrder!.id),
    );
    const captured = payments.find(
      (payment) =>
        payment.status === "captured" &&
        payment.captured &&
        payment.amount_refunded === 0,
    );
    return captured ? finalize(String(row.id), providerOrder, captured) : row;
  }

  app.get("/api/payments/config", async () => settings);
  app.post(
    "/api/payments/orders",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = await authenticate(request);
      requireEnabled();
      const body = z
        .object({
          eventId: z.string().min(1).max(120),
          quantity: z.number().int().min(1).max(6),
        })
        .strict()
        .parse(request.body);
      const key = z
        .string()
        .min(8)
        .max(128)
        .regex(/^[A-Za-z0-9._:-]+$/)
        .parse(request.headers["idempotency-key"]);
      const hash = sha256(JSON.stringify([body.eventId, body.quantity]));
      await expirePaymentHolds(db);
      const result = await db.transaction(async (tx) => {
        const timestamp = now();
        const previous = await tx.get(
          "SELECT * FROM payment_orders WHERE user_id = ? AND request_key = ?",
          [user.id, key],
        );
        if (previous) {
          if (previous.request_hash !== hash)
            return fail(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This checkout key was already used for a different purchase.",
            );
          if (previous.key_id !== config.razorpayKeyId)
            return fail(
              409,
              "PAYMENT_KEY_CHANGED",
              "This checkout needs support because its payment configuration changed.",
            );
          return { row: previous, created: false };
        }
        const event = await tx.get(
          "SELECT e.*,u.email AS organizer_email FROM events e JOIN users u ON u.id = e.organizer_id WHERE e.id = ?",
          [body.eventId],
        );
        if (!event)
          return fail(404, "NOT_FOUND", "This experience could not be found.");
        if (event.category === "rail")
          return fail(
            409,
            "RAIL_SANDBOX_ONLY",
            "Railway tickets use the free sandbox flow. Real railway payments are not enabled.",
          );
        if (
          settings.mode === "live" &&
          (String(event.organizer_email).endsWith("@chainpass.local") ||
            String(event.id).startsWith("evt-"))
        )
          return fail(
            409,
            "DEMO_EVENT_NOT_PAYABLE",
            "Live payments are not available for demo experiences.",
          );
        if (String(event.starts_at) <= timestamp)
          return fail(
            409,
            "BOOKING_CLOSED",
            "Booking has closed for this experience.",
          );
        const amount = Number(event.price) * body.quantity;
        if (!Number.isSafeInteger(amount) || amount < 100)
          return fail(
            400,
            "INVALID_PAYMENT_AMOUNT",
            "Online checkout requires a total of at least ₹1.",
          );
        const id = randomUUID();
        const expires = new Date(
          Math.min(
            Date.now() + config.paymentHoldMinutes * 60_000,
            Date.parse(String(event.starts_at)),
          ),
        ).toISOString();
        // Claim the key before inventory. PostgreSQL's unique key wait serializes concurrent identical requests.
        const inserted = await tx.run(
          "INSERT INTO payment_orders(id,user_id,event_id,quantity,amount,currency,request_key,request_hash,key_id,mode,status,hold_active,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'creating',1,?,?,?) ON CONFLICT(user_id,request_key) DO NOTHING",
          [
            id,
            user.id,
            body.eventId,
            body.quantity,
            amount,
            "INR",
            key,
            hash,
            config.razorpayKeyId,
            settings.mode,
            expires,
            timestamp,
            timestamp,
          ],
        );
        if (!inserted) {
          const raced = (await tx.get(
            "SELECT * FROM payment_orders WHERE user_id = ? AND request_key = ?",
            [user.id, key],
          ))!;
          if (raced.request_hash !== hash)
            return fail(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This checkout key was already used for a different purchase.",
            );
          return { row: raced, created: false };
        }
        const reserved = await tx.run(
          "UPDATE events SET remaining = remaining - ? WHERE id = ? AND remaining >= ? AND starts_at > ?",
          [body.quantity, body.eventId, body.quantity, timestamp],
        );
        if (!reserved)
          return fail(
            409,
            "SOLD_OUT",
            "There are not enough tickets left. Try a smaller quantity.",
          );
        return {
          row: (await tx.get("SELECT * FROM payment_orders WHERE id = ?", [
            id,
          ]))!,
          created: true,
        };
      });
      let row = result.row;
      if (result.created) {
        // Never repeat this POST after an ambiguous response; recover by our unique receipt instead.
        const order = await external(() =>
          gateway.createOrder({
            amount: Number(row.amount),
            currency: "INR",
            receipt: String(row.id),
          }),
        );
        row = await attachOrder(row, order);
      } else row = await reconcile(row);
      reply.code(result.created ? 201 : 200);
      return present(row);
    },
  );
  app.get("/api/payments/orders/:id", async (request) => {
    const user = await authenticate(request);
    requireEnabled();
    await expirePaymentHolds(db);
    return present(await reconcile(await owned(orderParam(request), user.id)));
  });
  app.get("/api/payments/orders", async (request) => {
    const user = await authenticate(request);
    requireEnabled();
    const rows = await db.all(
      "SELECT * FROM payment_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
      [user.id],
    );
    return { orders: await Promise.all(rows.map((row) => present(row, true))) };
  });
  app.post("/api/payments/orders/:id/confirm", async (request) => {
    const user = await authenticate(request);
    requireEnabled();
    const row = await owned(orderParam(request), user.id);
    const body = z
      .object({
        razorpay_order_id: providerId,
        razorpay_payment_id: providerId,
        razorpay_signature: z.string().length(64),
      })
      .strict()
      .parse(request.body);
    if (
      !row.provider_order_id ||
      body.razorpay_order_id !== row.provider_order_id ||
      !validSignature(
        `${row.provider_order_id}|${body.razorpay_payment_id}`,
        body.razorpay_signature,
        config.razorpayKeySecret,
      )
    )
      return fail(
        400,
        "INVALID_PAYMENT_SIGNATURE",
        "The payment signature could not be verified.",
      );
    const [order, payment] = await external(() =>
      Promise.all([
        gateway.getOrder(String(row.provider_order_id)),
        gateway.getPayment(body.razorpay_payment_id),
      ]),
    );
    if (payment.id !== body.razorpay_payment_id)
      return fail(
        409,
        "PAYMENT_MISMATCH",
        "The provider returned a different payment.",
      );
    return present(await finalize(String(row.id), order, payment));
  });

  // Only the webhook parser sees raw bytes; the rest of the API retains Fastify's JSON parser.
  await app.register(async (webhooks) => {
    webhooks.removeContentTypeParser("application/json");
    webhooks.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    webhooks.post(
      "/api/payments/webhook",
      {
        bodyLimit: 256 * 1024,
        config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
      },
      async (request) => {
        requireEnabled();
        if (
          !Buffer.isBuffer(request.body) ||
          !validSignature(
            request.body,
            request.headers["x-razorpay-signature"],
            config.razorpayWebhookSecret,
          )
        )
          return fail(
            400,
            "INVALID_WEBHOOK_SIGNATURE",
            "Webhook signature could not be verified.",
          );
        const id = z
          .string()
          .min(1)
          .max(160)
          .regex(/^[A-Za-z0-9_-]+$/)
          .parse(request.headers["x-razorpay-event-id"]);
        const payloadHash = sha256(request.body.toString("utf8"));
        const previous = await db.get(
          "SELECT payload_hash FROM payment_webhooks WHERE event_id = ?",
          [id],
        );
        if (previous) {
          if (previous.payload_hash !== payloadHash)
            return fail(
              400,
              "WEBHOOK_CONFLICT",
              "Webhook identifier was already used.",
            );
          return { ok: true };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(request.body.toString("utf8"));
        } catch {
          return fail(400, "INVALID_WEBHOOK", "Webhook payload must be JSON.");
        }
        const body = z
          .object({ event: z.string(), payload: z.unknown() })
          .parse(parsed);
        if (body.event !== "payment.captured" && body.event !== "order.paid")
          return { ok: true, ignored: true };
        const payload = z
          .object({
            payment: z.object({
              entity: z.object({ id: providerId, order_id: providerId }),
            }),
          })
          .parse(body.payload);
        const order = await external(() =>
          gateway.getOrder(payload.payment.entity.order_id),
        );
        let row = await db.get(
          "SELECT * FROM payment_orders WHERE provider_order_id = ?",
          [order.id],
        );
        if (!row) {
          row = await db.get(
            "SELECT * FROM payment_orders WHERE id = ? AND provider_order_id IS NULL",
            [order.receipt],
          );
          if (!row) return { ok: true, ignored: true };
          if (row.key_id !== config.razorpayKeyId)
            return fail(
              409,
              "PAYMENT_KEY_CHANGED",
              "Payment configuration changed. Operator reconciliation is required.",
            );
          row = await attachOrder(row, order);
        }
        if (row.key_id !== config.razorpayKeyId)
          return fail(
            409,
            "PAYMENT_KEY_CHANGED",
            "Payment configuration changed. Operator reconciliation is required.",
          );
        const payment = await external(() =>
          gateway.getPayment(payload.payment.entity.id),
        );
        if (payment.id !== payload.payment.entity.id)
          return fail(
            409,
            "PAYMENT_MISMATCH",
            "The provider returned a different payment.",
          );
        await finalize(String(row.id), order, payment, {
          id,
          hash: payloadHash,
        });
        return { ok: true };
      },
    );
  });

  if (settings.enabled) {
    let interval: ReturnType<typeof setInterval> | undefined;
    let sweep: Promise<void> | undefined;
    // The timestamp claim is a short lease shared by all API replicas. It also
    // bounds retries after crashes without doing network I/O inside a transaction.
    async function maintenance() {
      await expirePaymentHolds(db);
      const cutoff = new Date(Date.now() - 60_000).toISOString();
      const horizon = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const rows = await db.all(
        "SELECT * FROM payment_orders WHERE key_id = ? AND status IN ('creating','pending','expired') AND updated_at <= ? AND created_at >= ? ORDER BY updated_at,id LIMIT 20",
        [config.razorpayKeyId, cutoff, horizon],
      );
      for (const row of rows) {
        const claimed = await db.run(
          "UPDATE payment_orders SET updated_at = ? WHERE id = ? AND updated_at = ? AND status IN ('creating','pending','expired')",
          [now(), String(row.id), String(row.updated_at)],
        );
        if (!claimed) continue;
        try {
          await reconcile(row);
        } catch {
          app.log.error(
            { orderId: row.id },
            "Payment reconciliation failed; an upcoming sweep will retry.",
          );
        }
      }
    }
    app.addHook("onReady", async () => {
      await expirePaymentHolds(db);
      interval = setInterval(() => {
        if (!sweep)
          sweep = maintenance()
            .catch(() => {
              app.log.error(
                "Payment hold expiry failed; the next sweep will retry.",
              );
            })
            .finally(() => {
              sweep = undefined;
            });
      }, 30_000);
      interval.unref();
    });
    app.addHook("onClose", async () => {
      if (interval) clearInterval(interval);
      await sweep;
    });
  }
}
