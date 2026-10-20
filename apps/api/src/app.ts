import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Booking, User } from "@chainpass/shared";
import { loadConfig, type Config } from "./config.js";
import { openDatabase, type Database } from "./db.js";
import {
  commitment,
  hashPassword,
  newToken,
  sha256,
  verifyPassword,
  verifyQr,
} from "./security.js";
import { eventFrom, ticketFrom, userFrom } from "./models.js";
import { seedDemo } from "./seed.js";
import { registerRailRoutes } from "./rail.js";
import {
  paymentConfig,
  registerPaymentRoutes,
  type RazorpayGateway,
} from "./payments.js";
import {
  registerFirebaseRoutes,
  type FirebaseVerifier,
} from "./firebase-auth.js";

class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new HttpError(status, code, message);
};
const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(128),
});
const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(2).max(80),
});
const bookingSchema = z
  .object({
    eventId: z.string().min(1).max(120),
    quantity: z.number().int().min(1).max(6),
  })
  .strict();
const eventSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    subtitle: z.string().trim().min(2).max(160),
    category: z.enum(["concert", "rail", "bus", "metro"]),
    city: z.string().trim().min(2).max(80),
    venue: z.string().trim().min(2).max(160),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    price: z.number().int().min(0).max(100_000_000),
    currency: z.literal("INR").default("INR"),
    capacity: z.number().int().min(1).max(1_000_000),
    image: z.enum([
      "/images/concert.jpg",
      "/images/train.jpg",
      "/images/bus.jpg",
      "/images/metro.jpg",
    ]),
    featured: z.boolean().default(false),
    description: z.string().trim().min(20).max(5000),
  })
  .strict()
  .refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt), {
    message: "End time must follow start time.",
    path: ["endsAt"],
  })
  .refine((value) => Date.parse(value.startsAt) > Date.now(), {
    message: "Start time must be in the future.",
    path: ["startsAt"],
  });

export async function buildApp(
  options: {
    config?: Partial<Config>;
    database?: Database;
    logger?: boolean;
    razorpayGateway?: RazorpayGateway;
    firebaseVerifier?: FirebaseVerifier;
  } = {},
) {
  const config = loadConfig(options.config);
  const db = options.database || (await openDatabase(config));
  if (config.seedDemo) await seedDemo(db);
  const dummyHash = await hashPassword(
    "constant-invalid-credentials-placeholder",
  );
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: "info",
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.body",
              'res.headers["set-cookie"]',
            ],
          },
    bodyLimit: 32 * 1024,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy: false, // Set only to your trusted edge network before deployment; never trust arbitrary X-Forwarded-For.
  });
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("cache-control", "no-store");
  });
  await app.register(cors, {
    origin: config.webOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    credentials: false,
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "https://checkout.razorpay.com",
          "https://www.google.com",
          "https://www.gstatic.com",
          "https://apis.google.com",
          "https://www.recaptcha.net",
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://*.razorpay.com",
          "https://www.gstatic.com",
          "https://www.google.com",
        ],
        connectSrc: [
          "'self'",
          "https://*.razorpay.com",
          "https://identitytoolkit.googleapis.com",
          "https://securetoken.googleapis.com",
          "https://www.googleapis.com",
          "https://www.google.com",
          "https://www.recaptcha.net",
          "https://*.firebaseapp.com",
          ...(config.firebaseAuthDomain
            ? [`https://${config.firebaseAuthDomain}`]
            : []),
        ],
        frameSrc: [
          "https://api.razorpay.com",
          "https://checkout.razorpay.com",
          "https://*.firebaseapp.com",
          "https://www.google.com",
          "https://www.recaptcha.net",
          ...(config.firebaseAuthDomain
            ? [`https://${config.firebaseAuthDomain}`]
            : []),
        ],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  });
  await app.register(rateLimit, {
    max: 180,
    timeWindow: "1 minute",
    // Static assets must not spend the API budget. Use the matched route,
    // not a caller-controlled URL, so API aliases cannot bypass the limiter.
    allowList: (request) => {
      const route = request.routeOptions.url;
      return route !== undefined && !route.startsWith("/api/");
    },
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        message: error.issues
          .map(
            (issue) => `${issue.path.join(".") || "request"}: ${issue.message}`,
          )
          .join("; "),
      });
    if (error instanceof HttpError)
      return reply
        .code(error.statusCode)
        .send({ error: error.code, message: error.message });
    const status =
      typeof error === "object" && error && "statusCode" in error
        ? Number(error.statusCode)
        : 500;
    if (status >= 400 && status < 500)
      return reply.code(status).send({
        error: status === 429 ? "RATE_LIMITED" : "BAD_REQUEST",
        message:
          status === 429
            ? "Too many requests. Please try again shortly."
            : "The request could not be processed.",
      });
    request.log.error(
      { err: error, requestId: request.id },
      "Unhandled request error",
    );
    return reply.code(500).send({
      error: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again.",
    });
  });
  app.addHook("onClose", async () => {
    if (!options.database) await db.close();
  });

  async function authenticate(
    request: FastifyRequest,
    organizer = false,
  ): Promise<User> {
    const token = request.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{40,100})$/,
    )?.[1];
    if (!token) return fail(401, "UNAUTHORIZED", "Sign in to continue.");
    const row = await db.get(
      "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
      [sha256(token), new Date().toISOString()],
    );
    if (!row)
      return fail(
        401,
        "UNAUTHORIZED",
        "Your session has expired. Please sign in again.",
      );
    const user = userFrom(row);
    if (config.production && user.email.endsWith("@chainpass.local"))
      return fail(
        401,
        "DEMO_ACCOUNT_DISABLED",
        "Demo sessions cannot access a production deployment.",
      );
    if (organizer && user.role !== "organizer")
      return fail(403, "FORBIDDEN", "Organizer access is required.");
    return user;
  }
  async function session(user: User) {
    const token = newToken();
    await db.run(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      [
        sha256(token),
        user.id,
        new Date(Date.now() + config.sessionTtlHours * 3_600_000).toISOString(),
      ],
    );
    return { token, user };
  }
  const getParam = (request: FastifyRequest, key: string) =>
    z
      .string()
      .min(1)
      .max(160)
      .parse((request.params as Record<string, unknown>)[key]);

  app.get("/api/health", async () => ({
    status: "ok",
    service: "chainpass-api",
  }));
  app.get("/api/ready", async () => {
    await db.get("SELECT 1 AS ok");
    return { status: "ready", database: db.kind };
  });
  app.get("/api/status", async () => ({
    mode: config.demoMode ? "demo" : "production",
    database: db.kind,
    blockchain: config.blockchainEnabled ? "enabled" : "disabled",
    chainId: config.blockchainEnabled ? config.chainId : null,
  }));
  app.get("/api/events", async (request) => {
    const query = z
      .object({
        category: z.enum(["concert", "rail", "bus", "metro"]).optional(),
        q: z.string().trim().max(120).optional(),
        city: z.string().trim().max(80).optional(),
      })
      .parse(request.query);
    const where = [
      "ends_at > ?",
      "id NOT IN (SELECT event_id FROM rail_inventory)",
    ];
    const values: (string | number)[] = [new Date().toISOString()];
    if (query.category) {
      where.push("category = ?");
      values.push(query.category);
    }
    if (query.city && query.city !== "All cities") {
      where.push("LOWER(city) = LOWER(?)");
      values.push(query.city);
    }
    if (query.q) {
      where.push(
        "LOWER(title || ' ' || subtitle || ' ' || venue || ' ' || city) LIKE ?",
      );
      values.push(`%${query.q.toLowerCase().replace(/[%_]/g, "")}%`);
    }
    const rows = await db.all(
      `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY featured DESC, starts_at ASC LIMIT 100`,
      values,
    );
    return { events: rows.map(eventFrom) };
  });
  app.get("/api/events/:id", async (request) => {
    const row = await db.get("SELECT * FROM events WHERE id = ?", [
      getParam(request, "id"),
    ]);
    if (!row)
      return fail(404, "NOT_FOUND", "This experience could not be found.");
    return { event: eventFrom(row) };
  });
  app.post(
    "/api/auth/register",
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = registerSchema.parse(request.body);
      if (await db.get("SELECT id FROM users WHERE email = ?", [body.email]))
        return fail(
          409,
          "EMAIL_EXISTS",
          "An account already exists with this email.",
        );
      const user: User = {
        id: randomUUID(),
        name: body.name,
        email: body.email,
        role: "customer",
      };
      const passwordHash = await hashPassword(body.password);
      const inserted = await db.run(
        "INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO NOTHING",
        [
          user.id,
          user.name,
          user.email,
          passwordHash,
          user.role,
          new Date().toISOString(),
        ],
      );
      if (!inserted)
        return fail(
          409,
          "EMAIL_EXISTS",
          "An account already exists with this email.",
        );
      reply.code(201);
      return session(user);
    },
  );
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request) => {
      const body = credentialsSchema.parse(request.body);
      const row = await db.get("SELECT * FROM users WHERE email = ?", [
        body.email,
      ]);
      const valid = await verifyPassword(
        body.password,
        row ? String(row.password_hash) : dummyHash,
      );
      if (!row || !valid)
        return fail(
          401,
          "INVALID_CREDENTIALS",
          "Email or password is incorrect.",
        );
      if (config.production && body.email.endsWith("@chainpass.local"))
        return fail(
          403,
          "DEMO_ACCOUNT_DISABLED",
          "Demo identities cannot sign in to a production deployment.",
        );
      return session(userFrom(row));
    },
  );
  app.get("/api/auth/me", async (request) => ({
    user: await authenticate(request),
  }));
  app.post("/api/auth/logout", async (request) => {
    await authenticate(request);
    await db.run("DELETE FROM sessions WHERE token_hash = ?", [
      sha256(request.headers.authorization!.slice(7)),
    ]);
    return { ok: true };
  });
  registerFirebaseRoutes(app, db, config, {
    session,
    authenticate,
    fail,
    verifier: options.firebaseVerifier,
  });
  await registerPaymentRoutes(app, db, config, {
    authenticate,
    fail,
    gateway: options.razorpayGateway,
  });
  app.post(
    "/api/bookings",
    { config: { rateLimit: { max: 40, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = await authenticate(request);
      if (paymentConfig(config).enabled)
        return fail(
          409,
          "PAYMENT_CHECKOUT_REQUIRED",
          "Use the UPI/card checkout to confirm payment before tickets are issued.",
        );
      if (!config.demoMode)
        return fail(
          503,
          "PAYMENTS_NOT_CONFIGURED",
          "Live payments are not configured. Booking is available only in explicitly enabled demo mode.",
        );
      const body = bookingSchema.parse(request.body);
      const key = z
        .string()
        .min(8)
        .max(128)
        .regex(/^[A-Za-z0-9._:-]+$/)
        .parse(request.headers["idempotency-key"]);
      const requestHash = sha256(JSON.stringify([body.eventId, body.quantity]));
      const now = new Date().toISOString();
      const result = await db.transaction(async (tx) => {
        const inserted = await tx.run(
          "INSERT INTO idempotency(user_id,key,request_hash,response,created_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,key) DO NOTHING",
          [user.id, key, requestHash, "", now],
        );
        if (!inserted) {
          const previous = await tx.get(
            "SELECT * FROM idempotency WHERE user_id = ? AND key = ?",
            [user.id, key],
          );
          if (!previous || previous.request_hash !== requestHash)
            return fail(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This request key was already used for a different booking.",
            );
          if (!previous.response)
            return fail(
              409,
              "BOOKING_IN_PROGRESS",
              "This booking is still being processed. Retry with the same key.",
            );
          return JSON.parse(String(previous.response)) as Booking;
        }
        const event = await tx.get("SELECT * FROM events WHERE id = ?", [
          body.eventId,
        ]);
        if (!event)
          return fail(404, "NOT_FOUND", "This experience could not be found.");
        if (event.category === "rail")
          return fail(
            409,
            "RAIL_FLOW_REQUIRED",
            "Use the railway booking flow to select a train, passengers, and sandbox identity verification.",
          );
        if (String(event.starts_at) <= now || String(event.ends_at) <= now)
          return fail(
            409,
            "BOOKING_CLOSED",
            "Booking has closed for this experience.",
          );
        const reserved = await tx.run(
          "UPDATE events SET remaining = remaining - ? WHERE id = ? AND remaining >= ? AND starts_at > ?",
          [body.quantity, body.eventId, body.quantity, now],
        );
        if (!reserved)
          return fail(
            409,
            "SOLD_OUT",
            "There are not enough tickets left. Try a smaller quantity.",
          );
        const tickets = [];
        for (let index = 0; index < body.quantity; index++) {
          const id = randomUUID();
          const code = `CP-${randomBytes(8).toString("hex").toUpperCase()}`;
          const hash = commitment(id, body.eventId);
          await tx.run(
            "INSERT INTO tickets(id,event_id,user_id,code,status,created_at,price_paid,commitment,chain_status,transaction_hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
            [
              id,
              body.eventId,
              user.id,
              code,
              "valid",
              now,
              Number(event.price),
              hash,
              config.blockchainEnabled ? "pending" : "disabled",
              null,
            ],
          );
          if (config.blockchainEnabled)
            await tx.run(
              "INSERT INTO outbox(id,ticket_id,commitment,status,attempts,available_at,created_at) VALUES(?,?,?,?,?,?,?)",
              [randomUUID(), id, hash, "pending", 0, now, now],
            );
          const row = await tx.get("SELECT * FROM tickets WHERE id = ?", [id]);
          tickets.push(await ticketFrom(row!, tx, config.qrSecret));
        }
        const booking: Booking = {
          tickets,
          total: Number(event.price) * body.quantity,
        };
        await tx.run(
          "UPDATE idempotency SET response = ? WHERE user_id = ? AND key = ?",
          [JSON.stringify(booking), user.id, key],
        );
        return booking;
      });
      reply.header("x-payment-mode", "demo-no-charge");
      reply.code(201);
      return result;
    },
  );
  app.get("/api/tickets", async (request) => {
    const user = await authenticate(request);
    const rows = await db.all(
      "SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 200",
      [user.id],
    );
    return {
      tickets: await Promise.all(
        rows.map((row) => ticketFrom(row, db, config.qrSecret)),
      ),
    };
  });
  app.post("/api/tickets/:id/cancel", async (request) => {
    const user = await authenticate(request);
    const id = getParam(request, "id");
    return db.transaction(async (tx) => {
      const row = await tx.get(
        "SELECT t.*, e.starts_at, e.ends_at FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = ? AND t.user_id = ?",
        [id, user.id],
      );
      if (!row) return fail(404, "NOT_FOUND", "Ticket not found.");
      if (
        await tx.get(
          "SELECT order_id FROM payment_tickets WHERE ticket_id = ?",
          [id],
        )
      )
        return fail(
          409,
          "PAID_CANCELLATION_REQUIRES_SUPPORT",
          "Paid ticket cancellations require support and a verified refund. This ticket has not been cancelled or refunded.",
        );
      if (row.status === "cancelled")
        return { ticket: await ticketFrom(row, tx, config.qrSecret) };
      if (row.status !== "valid")
        return fail(
          409,
          "TICKET_ALREADY_USED",
          "A checked-in ticket cannot be cancelled.",
        );
      if (String(row.starts_at) <= new Date().toISOString())
        return fail(
          409,
          "EVENT_STARTED",
          "Tickets cannot be cancelled after an experience begins.",
        );
      const changed = await tx.run(
        "UPDATE tickets SET status = 'cancelled' WHERE id = ? AND status = 'valid'",
        [id],
      );
      if (!changed)
        return fail(
          409,
          "TICKET_CHANGED",
          "The ticket has already been used or cancelled.",
        );
      await tx.run(
        "UPDATE events SET remaining = remaining + 1 WHERE id = ? AND remaining < capacity",
        [String(row.event_id)],
      );
      const allocation = await tx.get(
        "SELECT inventory_id FROM rail_seats WHERE ticket_id = ?",
        [id],
      );
      if (allocation) {
        await tx.run(
          "UPDATE rail_inventory SET remaining = remaining + 1 WHERE id = ? AND remaining < capacity",
          [String(allocation.inventory_id)],
        );
        await tx.run("DELETE FROM rail_seats WHERE ticket_id = ?", [id]);
      }
      return {
        ticket: await ticketFrom(
          { ...row, status: "cancelled" },
          tx,
          config.qrSecret,
        ),
      };
    });
  });
  app.get("/api/verify/:code", async (request) => {
    const code = getParam(request, "code");
    const row = await db.get(
      "SELECT t.status,t.commitment,t.chain_status,t.transaction_hash,e.title,e.ends_at,e.category FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.code = ?",
      [code],
    );
    if (!row)
      return fail(
        404,
        "NOT_FOUND",
        "No ticket matches this verification code.",
      );
    const expired = String(row.ends_at) <= new Date().toISOString();
    return {
      valid: row.status === "valid" && !expired,
      status: row.status === "valid" && expired ? "expired" : row.status,
      eventTitle: row.title,
      commitment: row.commitment,
      chainStatus: row.chain_status,
      transactionHash: row.transaction_hash || null,
      ...(row.category === "rail" ? { sandboxRail: true } : {}),
    };
  });
  app.get("/api/organizer/dashboard", async (request) => {
    const user = await authenticate(request, true);
    const rows = await db.all(
      "SELECT * FROM events WHERE organizer_id = ? ORDER BY starts_at ASC LIMIT 200",
      [user.id],
    );
    const stats = await db.get(
      `SELECT COUNT(*) AS total_tickets, COALESCE(SUM(CASE WHEN t.status != 'cancelled' THEN t.price_paid ELSE 0 END),0) AS total_revenue, COALESCE(SUM(CASE WHEN t.status = 'used' THEN 1 ELSE 0 END),0) AS checked_in FROM tickets t JOIN events e ON e.id = t.event_id WHERE e.organizer_id = ?`,
      [user.id],
    );
    const recent = await db.all(
      "SELECT t.* FROM tickets t JOIN events e ON e.id = t.event_id WHERE e.organizer_id = ? ORDER BY t.created_at DESC LIMIT 12",
      [user.id],
    );
    const active = await db.get(
      "SELECT COUNT(*) AS count FROM events WHERE organizer_id = ? AND ends_at > ?",
      [user.id, new Date().toISOString()],
    );
    return {
      totalTickets: Number(stats?.total_tickets || 0),
      totalRevenue: Number(stats?.total_revenue || 0),
      checkedIn: Number(stats?.checked_in || 0),
      activeEvents: Number(active?.count || 0),
      events: rows.map(eventFrom),
      recentTickets: await Promise.all(
        recent.map((row) => ticketFrom(row, db, config.qrSecret)),
      ),
    };
  });
  app.post("/api/organizer/events", async (request, reply) => {
    const user = await authenticate(request, true);
    const body = eventSchema.parse(request.body);
    const id = `evt-${randomUUID()}`;
    await db.run(
      "INSERT INTO events(id,title,subtitle,category,city,venue,starts_at,ends_at,price,currency,capacity,remaining,image,featured,description,organizer_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        body.title,
        body.subtitle,
        body.category,
        body.city,
        body.venue,
        new Date(body.startsAt).toISOString(),
        new Date(body.endsAt).toISOString(),
        body.price,
        body.currency,
        body.capacity,
        body.capacity,
        body.image,
        body.featured ? 1 : 0,
        body.description,
        user.id,
      ],
    );
    const row = await db.get("SELECT * FROM events WHERE id = ?", [id]);
    reply.code(201);
    return { event: eventFrom(row!) };
  });
  app.post("/api/check-in", async (request) => {
    const user = await authenticate(request, true);
    const body = z
      .object({ qrPayload: z.string().min(20).max(2000) })
      .strict()
      .parse(request.body);
    const qr = verifyQr(body.qrPayload, config.qrSecret);
    if (!qr)
      return fail(400, "INVALID_QR", "This ticket signature is invalid.");
    return db.transaction(async (tx) => {
      const row = await tx.get(
        "SELECT t.*,e.organizer_id,e.ends_at FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = ? AND t.code = ?",
        [qr.ticketId, qr.code],
      );
      if (!row) return fail(404, "NOT_FOUND", "Ticket not found.");
      if (row.organizer_id !== user.id)
        return fail(
          403,
          "FORBIDDEN",
          "This ticket belongs to another organizer.",
        );
      if (String(row.ends_at) <= new Date().toISOString())
        return fail(409, "EVENT_ENDED", "This experience has ended.");
      const changed = await tx.run(
        "UPDATE tickets SET status = 'used' WHERE id = ? AND status = 'valid'",
        [qr.ticketId],
      );
      if (!changed)
        return fail(
          409,
          "TICKET_NOT_VALID",
          "This ticket has already been used or cancelled.",
        );
      await tx.run(
        "INSERT INTO checkin_audit(id,ticket_id,organizer_id,checked_in_at) VALUES(?,?,?,?)",
        [randomUUID(), qr.ticketId, user.id, new Date().toISOString()],
      );
      return {
        ticket: await ticketFrom(
          { ...row, status: "used" },
          tx,
          config.qrSecret,
        ),
      };
    });
  });

  registerRailRoutes(app, db, config, authenticate, fail);

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.method !== "GET")
        return reply
          .code(404)
          .send({ error: "NOT_FOUND", message: "Endpoint not found." });
      return reply.sendFile("index.html");
    });
  } else
    app.setNotFoundHandler((_request, reply) =>
      reply
        .code(404)
        .send({ error: "NOT_FOUND", message: "Endpoint not found." }),
    );
  return app;
}
