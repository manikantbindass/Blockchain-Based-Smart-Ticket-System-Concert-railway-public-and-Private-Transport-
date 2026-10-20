import {
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  RailBooking,
  RailClassCode,
  RailIdentity,
  RailOptions,
  RailQuota,
  RailStation,
  RailTicketDetails,
  RailTrain,
  User,
} from "@chainpass/shared";
import type { Config } from "./config.js";
import type { Database, Queryable, Row } from "./db.js";
import { commitment, sha256 } from "./security.js";
import { ticketFrom } from "./models.js";

type Fail = (status: number, code: string, message: string) => never;
const CONSENT_VERSION = "rail-sandbox-v1";
const STATIONS: RailStation[] = [
  { code: "SBC", name: "KSR Bengaluru", city: "Bengaluru" },
  { code: "BNC", name: "Bengaluru Cantonment", city: "Bengaluru" },
  { code: "MAS", name: "Chennai Central", city: "Chennai" },
  {
    code: "CSMT",
    name: "Chhatrapati Shivaji Maharaj Terminus",
    city: "Mumbai",
  },
  { code: "TNA", name: "Thane", city: "Thane" },
  { code: "MAO", name: "Madgaon Junction", city: "Goa" },
  { code: "NDLS", name: "New Delhi", city: "Delhi" },
  { code: "AGC", name: "Agra Cantt", city: "Agra" },
];
const CLASSES = [
  { code: "SL" as const, label: "Sleeper", capacity: 72, prefix: "S" },
  { code: "3A" as const, label: "AC 3 Tier", capacity: 64, prefix: "B" },
  { code: "2A" as const, label: "AC 2 Tier", capacity: 48, prefix: "A" },
  { code: "CC" as const, label: "AC Chair Car", capacity: 64, prefix: "C" },
  {
    code: "EC" as const,
    label: "Executive Chair Car",
    capacity: 24,
    prefix: "E",
  },
];
interface Schedule {
  id: string;
  number: string;
  name: string;
  from: string;
  to: string;
  departure: string;
  durationMinutes: number;
  boarding: string[];
  fares: Partial<Record<RailClassCode, number>>;
}
// Illustrative fixtures only: these are not railway timetable or fare feeds.
const SCHEDULES: Schedule[] = [
  {
    id: "demo-vande-bharat",
    number: "DEMO-20608",
    name: "Vande Bharat Express",
    from: "SBC",
    to: "MAS",
    departure: "06:00",
    durationMinutes: 270,
    boarding: ["SBC", "BNC"],
    fares: { CC: 125000, EC: 245000 },
  },
  {
    id: "demo-lalbagh",
    number: "DEMO-12608",
    name: "Lalbagh Express",
    from: "SBC",
    to: "MAS",
    departure: "10:30",
    durationMinutes: 360,
    boarding: ["SBC", "BNC"],
    fares: { SL: 35000, "3A": 89500, "2A": 129500, CC: 65000 },
  },
  {
    id: "demo-chennai-return",
    number: "DEMO-20607",
    name: "Bengaluru Intercity",
    from: "MAS",
    to: "SBC",
    departure: "15:30",
    durationMinutes: 285,
    boarding: ["MAS"],
    fares: { CC: 125000, EC: 245000 },
  },
  {
    id: "demo-western-coast",
    number: "DEMO-10111",
    name: "Western Coast Express",
    from: "CSMT",
    to: "MAO",
    departure: "07:10",
    durationMinutes: 660,
    boarding: ["CSMT", "TNA"],
    fares: { SL: 55000, "3A": 189900, "2A": 249900 },
  },
  {
    id: "demo-goa-return",
    number: "DEMO-10112",
    name: "Konkan Return Express",
    from: "MAO",
    to: "CSMT",
    departure: "18:00",
    durationMinutes: 720,
    boarding: ["MAO"],
    fares: { SL: 55000, "3A": 189900, "2A": 249900 },
  },
  {
    id: "demo-taj-intercity",
    number: "DEMO-12002",
    name: "Taj Intercity",
    from: "NDLS",
    to: "AGC",
    departure: "08:00",
    durationMinutes: 120,
    boarding: ["NDLS"],
    fares: { CC: 75000, EC: 145000 },
  },
];
const station = (code: string) => STATIONS.find((item) => item.code === code)!;
const classSchema = z.enum(["SL", "3A", "2A", "CC", "EC"]);
const quotaSchema = z.enum(["GENERAL", "TATKAL"]);
const genderSchema = z.enum(["M", "F", "X"]);
const nameSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(
    /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u,
    "Use a name with letters, spaces, apostrophes, or hyphens.",
  );
const calendarSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "Enter a valid calendar date.");
const passengerSchema = z
  .object({
    name: nameSchema,
    age: z.number().int().min(5).max(120),
    gender: genderSchema,
    berthPreference: z.enum([
      "ANY",
      "LOWER",
      "MIDDLE",
      "UPPER",
      "SIDE_LOWER",
      "SIDE_UPPER",
      "WINDOW",
      "AISLE",
    ]),
  })
  .strict();
const bookingSchema = z
  .object({
    trainId: z.string().min(1).max(80),
    journeyDate: calendarSchema,
    travelClass: classSchema,
    quota: quotaSchema,
    boardingStation: z.string().min(2).max(5),
    passengers: z.array(passengerSchema).min(1).max(6),
    contactEmail: z.string().trim().toLowerCase().email().max(254),
    contactMobile: z
      .string()
      .regex(
        /^[6-9]\d{9}$/,
        "Use a 10-digit Indian mobile format for the sandbox receipt.",
      ),
    paymentMethod: z.enum(["DEMO_UPI", "DEMO_CARD", "DEMO_NETBANKING"]),
    acceptedTerms: z.literal(true),
  })
  .strict();

function dateAtOffset(days: number) {
  return new Date(Date.now() + 19_800_000 + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
function validateJourney(date: string, quota: RailQuota, fail: Fail) {
  if (date < dateAtOffset(0) || date > dateAtOffset(60))
    fail(
      400,
      "JOURNEY_DATE_INVALID",
      "Choose a journey within the next 60 days in this sandbox.",
    );
  if (quota === "TATKAL" && date !== dateAtOffset(1))
    fail(
      400,
      "TATKAL_DATE_INVALID",
      "Sandbox Tatkal is available for tomorrow only; real opening times are not simulated.",
    );
}
const inventoryId = (
  trainId: string,
  date: string,
  travelClass: RailClassCode,
  quota: RailQuota,
) => `rail-${trainId}-${date}-${travelClass}-${quota}`;
const capacityFor = (code: RailClassCode, quota: RailQuota) =>
  quota === "TATKAL"
    ? code === "EC"
      ? 8
      : 12
    : CLASSES.find((item) => item.code === code)!.capacity;
const fareFor = (schedule: Schedule, code: RailClassCode, quota: RailQuota) =>
  schedule.fares[code]! + (quota === "TATKAL" ? 20000 : 0);
function trainFrom(
  schedule: Schedule,
  date: string,
  quota: RailQuota,
): RailTrain {
  const departureAt = new Date(
    `${date}T${schedule.departure}:00+05:30`,
  ).toISOString();
  return {
    id: schedule.id,
    number: schedule.number,
    name: schedule.name,
    from: station(schedule.from),
    to: station(schedule.to),
    journeyDate: date,
    departureAt,
    arrivalAt: new Date(
      Date.parse(departureAt) + schedule.durationMinutes * 60_000,
    ).toISOString(),
    durationMinutes: schedule.durationMinutes,
    boardingStations: schedule.boarding.map(station),
    quota,
    classes: CLASSES.filter(
      (item) => schedule.fares[item.code] !== undefined,
    ).map((item) => ({
      code: item.code,
      label: item.label,
      fare: fareFor(schedule, item.code, quota),
      remaining: capacityFor(item.code, quota),
      status: "AVAILABLE",
    })),
  };
}
function identityFrom(row: Row | undefined, enabled: boolean): RailIdentity {
  if (!enabled || !row)
    return { verified: false, mode: enabled ? "sandbox" : "unavailable" };
  return {
    verified: true,
    mode: "sandbox",
    name: String(row.name),
    dateOfBirth: String(row.date_of_birth),
    gender: row.gender as RailIdentity["gender"],
    maskedIdentifier: String(row.masked_identifier),
    verifiedAt: String(row.verified_at),
  };
}
function berthType(code: RailClassCode, seat: number) {
  const types =
    code === "CC" || code === "EC"
      ? ["WINDOW", "AISLE", "AISLE", "WINDOW"]
      : code === "2A"
        ? ["LOWER", "UPPER", "LOWER", "UPPER", "SIDE_LOWER", "SIDE_UPPER"]
        : [
            "LOWER",
            "MIDDLE",
            "UPPER",
            "LOWER",
            "MIDDLE",
            "UPPER",
            "SIDE_LOWER",
            "SIDE_UPPER",
          ];
  return types[(seat - 1) % types.length]!;
}

export function registerRailRoutes(
  app: FastifyInstance,
  db: Database,
  config: Config,
  authenticate: (request: FastifyRequest) => Promise<User>,
  fail: Fail,
) {
  const enabled = !config.production && config.demoMode;
  const requireSandbox = () => {
    if (!enabled)
      fail(
        503,
        "RAIL_SANDBOX_UNAVAILABLE",
        "Railway identity and reservations require an authorized integration in production. The local simulator is disabled.",
      );
  };
  const lockUser = async (tx: Queryable, userId: string) => {
    await tx.get(
      `SELECT id FROM users WHERE id = ?${db.kind === "postgres" ? " FOR UPDATE" : ""}`,
      [userId],
    );
  };
  app.get("/api/rail/options", async (): Promise<RailOptions> => ({
    stations: STATIONS,
    classes: CLASSES.map(({ code, label }) => ({ code, label })),
    quotas: ["GENERAL", "TATKAL"],
    minDate: dateAtOffset(0),
    maxDate: dateAtOffset(60),
    suggestedDate: dateAtOffset(1),
    mode: enabled ? "sandbox" : "unavailable",
  }));
  app.get("/api/rail/trains", async (request) => {
    requireSandbox();
    const query = z
      .object({
        from: z.string().min(2).max(5),
        to: z.string().min(2).max(5),
        date: calendarSchema,
        quota: quotaSchema.default("GENERAL"),
        travelClass: z.union([classSchema, z.literal("ALL")]).default("ALL"),
      })
      .strict()
      .parse(request.query);
    if (!station(query.from) || !station(query.to) || query.from === query.to)
      return fail(
        400,
        "ROUTE_INVALID",
        "Choose two different stations from the sandbox station list.",
      );
    validateJourney(query.date, query.quota, fail);
    const trains: RailTrain[] = [];
    for (const schedule of SCHEDULES.filter(
      (item) => item.from === query.from && item.to === query.to,
    )) {
      const train = trainFrom(schedule, query.date, query.quota);
      if (train.departureAt <= new Date().toISOString()) continue;
      train.classes = train.classes.filter(
        (item) =>
          query.travelClass === "ALL" || item.code === query.travelClass,
      );
      for (const item of train.classes) {
        const row = await db.get(
          "SELECT remaining FROM rail_inventory WHERE id = ?",
          [inventoryId(schedule.id, query.date, item.code, query.quota)],
        );
        if (row) item.remaining = Number(row.remaining);
        item.status = item.remaining > 0 ? "AVAILABLE" : "NOT_AVAILABLE";
      }
      if (train.classes.length) trains.push(train);
    }
    return { trains };
  });
  app.get("/api/rail/identity", async (request): Promise<RailIdentity> => {
    const user = await authenticate(request);
    return identityFrom(
      enabled
        ? await db.get("SELECT * FROM rail_identities WHERE user_id = ?", [
            user.id,
          ])
        : undefined,
      enabled,
    );
  });
  app.get(
    "/api/rail/bookings/:reservationId",
    async (request): Promise<RailBooking> => {
      const user = await authenticate(request);
      const { reservationId } = z
        .object({ reservationId: z.string().uuid() })
        .parse(request.params);
      const reservation = await db.get(
        "SELECT id,pnr FROM rail_reservations WHERE id = ? AND user_id = ?",
        [reservationId, user.id],
      );
      if (!reservation) return fail(404, "NOT_FOUND", "Reservation not found.");
      const rows = await db.all(
        "SELECT t.* FROM tickets t JOIN rail_ticket_details r ON r.ticket_id = t.id WHERE r.reservation_id = ? AND t.user_id = ? ORDER BY t.created_at,t.id",
        [reservationId, user.id],
      );
      const tickets = await Promise.all(
        rows.map((row) => ticketFrom(row, db, config.qrSecret)),
      );
      return {
        reservationId,
        pnr: String(reservation.pnr),
        paymentMode: "sandbox",
        tickets,
        total: tickets.reduce((sum, ticket) => sum + ticket.pricePaid, 0),
      };
    },
  );
  app.post(
    "/api/rail/identity/start",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (request) => {
      requireSandbox();
      const user = await authenticate(request);
      const body = z
        .object({
          name: nameSchema,
          dateOfBirth: calendarSchema,
          gender: genderSchema,
          documentType: z.enum(["AADHAAR", "VID"]),
          identifier: z.string().max(16),
          consent: z.literal(true),
        })
        .strict()
        .parse(request.body);
      // Reject all real identifiers before hashing, persisting, or sending them anywhere.
      if (
        body.identifier !==
        (body.documentType === "AADHAAR" ? "000000000000" : "0000000000000000")
      )
        return fail(
          400,
          "TEST_IDENTITY_ONLY",
          "Only the all-zero test identifier is accepted. Do not submit a real Aadhaar number or VID.",
        );
      if (
        body.dateOfBirth > dateAtOffset(0) ||
        body.dateOfBirth < `${Number(dateAtOffset(0).slice(0, 4)) - 120}-01-01`
      )
        return fail(
          400,
          "BIRTH_DATE_INVALID",
          "Choose a valid birth date for the test profile.",
        );
      const now = new Date();
      const id = randomUUID();
      const otp = randomInt(0, 1_000_000).toString().padStart(6, "0");
      const expiresAt = new Date(now.getTime() + 300_000).toISOString();
      await db.transaction(async (tx) => {
        await lockUser(tx, user.id);
        const latest = await tx.get(
          "SELECT created_at FROM rail_identity_challenges WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
          [user.id],
        );
        if (
          latest &&
          Date.parse(String(latest.created_at)) + 30_000 > now.getTime()
        )
          return fail(
            429,
            "OTP_RESEND_COOLDOWN",
            "Wait 30 seconds before requesting another sandbox code.",
          );
        await tx.run(
          "UPDATE rail_identity_challenges SET status = 'replaced' WHERE user_id = ? AND status = 'active'",
          [user.id],
        );
        await tx.run(
          "INSERT INTO rail_identity_challenges(id,user_id,otp_hash,name,date_of_birth,gender,document_type,consent_version,created_at,expires_at,attempts,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            id,
            user.id,
            sha256(`${id}:${otp}:${config.qrSecret}`),
            body.name,
            body.dateOfBirth,
            body.gender,
            body.documentType,
            CONSENT_VERSION,
            now.toISOString(),
            expiresAt,
            0,
            "active",
          ],
        );
      });
      return {
        challengeId: id,
        expiresAt,
        resendAfterSeconds: 30,
        demoOtp: otp,
        maskedDestination: "Sandbox code shown here — no SMS sent",
        mode: "sandbox",
      };
    },
  );
  app.post(
    "/api/rail/identity/verify",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request): Promise<RailIdentity> => {
      requireSandbox();
      const user = await authenticate(request);
      const body = z
        .object({
          challengeId: z.string().uuid(),
          otp: z.string().regex(/^\d{6}$/),
        })
        .strict()
        .parse(request.body);
      const result = await db.transaction(async (tx) => {
        await lockUser(tx, user.id);
        const row = await tx.get(
          "SELECT * FROM rail_identity_challenges WHERE id = ? AND user_id = ?",
          [body.challengeId, user.id],
        );
        if (!row || row.status !== "active")
          return {
            error: "OTP_INVALID_CHALLENGE",
            message:
              "This sandbox challenge is invalid or has already been used. Request a new code.",
          };
        if (String(row.expires_at) <= new Date().toISOString())
          return {
            error: "OTP_EXPIRED",
            message: "This sandbox code has expired. Request a new code.",
          };
        if (Number(row.attempts) >= 5)
          return {
            error: "OTP_ATTEMPTS_EXHAUSTED",
            message:
              "The sandbox attempt limit has been reached. Request a new code.",
          };
        await tx.run(
          "UPDATE rail_identity_challenges SET attempts = attempts + 1 WHERE id = ?",
          [body.challengeId],
        );
        const expected = Buffer.from(String(row.otp_hash), "hex");
        const actual = Buffer.from(
          sha256(`${body.challengeId}:${body.otp}:${config.qrSecret}`),
          "hex",
        );
        if (!timingSafeEqual(expected, actual))
          return {
            error:
              Number(row.attempts) === 4
                ? "OTP_ATTEMPTS_EXHAUSTED"
                : "OTP_INCORRECT",
            message:
              Number(row.attempts) === 4
                ? "The sandbox attempt limit has been reached. Request a new code."
                : "That sandbox code is incorrect.",
          };
        const now = new Date().toISOString();
        await tx.run(
          "UPDATE rail_identity_challenges SET status = 'used' WHERE id = ?",
          [body.challengeId],
        );
        await tx.run(
          "INSERT INTO rail_identities(user_id,name,date_of_birth,gender,masked_identifier,verified_at,consent_version,consent_at,challenge_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,date_of_birth=excluded.date_of_birth,gender=excluded.gender,masked_identifier=excluded.masked_identifier,verified_at=excluded.verified_at,consent_version=excluded.consent_version,consent_at=excluded.consent_at,challenge_id=excluded.challenge_id",
          [
            user.id,
            String(row.name),
            String(row.date_of_birth),
            String(row.gender),
            `TEST ${row.document_type === "VID" ? "VID" : "AADHAAR"} •••• 0000`,
            now,
            String(row.consent_version),
            String(row.created_at),
            body.challengeId,
          ],
        );
        return {
          identity: identityFrom(
            await tx.get("SELECT * FROM rail_identities WHERE user_id = ?", [
              user.id,
            ]),
            true,
          ),
        };
      });
      // Error responses happen after commit so failed guesses cannot roll back their attempt counter.
      if (result.error) return fail(400, result.error, result.message!);
      return result.identity!;
    },
  );
  app.post(
    "/api/rail/bookings",
    { config: { rateLimit: { max: 40, timeWindow: "1 minute" } } },
    async (request, reply): Promise<RailBooking> => {
      requireSandbox();
      const user = await authenticate(request);
      const body = bookingSchema.parse(request.body);
      const key = z
        .string()
        .min(8)
        .max(128)
        .regex(/^[A-Za-z0-9._:-]+$/)
        .parse(request.headers["idempotency-key"]);
      if (body.quota === "TATKAL" && body.passengers.length > 4)
        return fail(
          400,
          "PASSENGER_LIMIT",
          "Sandbox Tatkal allows at most four passengers per reservation.",
        );
      const schedule = SCHEDULES.find((item) => item.id === body.trainId);
      if (!schedule || schedule.fares[body.travelClass] === undefined)
        return fail(
          400,
          "TRAIN_CLASS_INVALID",
          "Choose an available train and travel class.",
        );
      if (!schedule.boarding.includes(body.boardingStation))
        return fail(
          400,
          "BOARDING_STATION_INVALID",
          "Choose a boarding station on this service.",
        );
      const train = trainFrom(schedule, body.journeyDate, body.quota);
      const id = inventoryId(
        schedule.id,
        body.journeyDate,
        body.travelClass,
        body.quota,
      );
      const eventId = `evt-${id}`;
      const capacity = capacityFor(body.travelClass, body.quota);
      const price = fareFor(schedule, body.travelClass, body.quota);
      const now = new Date().toISOString();
      const requestHash = sha256(JSON.stringify(["rail-v1", body]));
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
          return JSON.parse(String(previous.response)) as RailBooking;
        }
        // A retry returns its original receipt even after the journey/Tatkal window changes.
        validateJourney(body.journeyDate, body.quota, fail);
        if (
          !(await tx.get(
            "SELECT user_id FROM rail_identities WHERE user_id = ?",
            [user.id],
          ))
        )
          return fail(
            403,
            "RAIL_IDENTITY_REQUIRED",
            "Complete the sandbox account identity check before reserving railway seats.",
          );
        if (train.departureAt <= now)
          return fail(
            409,
            "BOOKING_CLOSED",
            "Booking has closed for this departure.",
          );
        const owner = await tx.get(
          "SELECT id FROM users WHERE role = 'organizer' ORDER BY created_at ASC,id ASC LIMIT 1",
        );
        if (!owner)
          return fail(
            503,
            "RAIL_OPERATOR_UNAVAILABLE",
            "Create a sandbox organizer before booking railway seats.",
          );
        await tx.run(
          "INSERT INTO events(id,title,subtitle,category,city,venue,starts_at,ends_at,price,currency,capacity,remaining,image,featured,description,organizer_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
          [
            eventId,
            `${train.name} · ${body.travelClass}`,
            `${train.from.city} → ${train.to.city} · ${body.quota}`,
            "rail",
            train.from.city,
            train.from.name,
            train.departureAt,
            train.arrivalAt,
            price,
            "INR",
            capacity,
            capacity,
            "/images/train.jpg",
            0,
            "Sandbox railway reservation. Illustrative timetable and fare; not valid for travel. No railway or UIDAI integration.",
            String(owner.id),
          ],
        );
        await tx.run(
          "INSERT INTO rail_inventory(id,train_id,journey_date,travel_class,quota,capacity,remaining,event_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
          [
            id,
            schedule.id,
            body.journeyDate,
            body.travelClass,
            body.quota,
            capacity,
            capacity,
            eventId,
          ],
        );
        // Lock order matches cancellation (event then inventory); conditional writes serialize all seat allocators.
        const eventReserved = await tx.run(
          "UPDATE events SET remaining = remaining - ? WHERE id = ? AND remaining >= ?",
          [body.passengers.length, eventId, body.passengers.length],
        );
        const reserved = await tx.run(
          "UPDATE rail_inventory SET remaining = remaining - ? WHERE id = ? AND remaining >= ?",
          [body.passengers.length, id, body.passengers.length],
        );
        if (!eventReserved || !reserved)
          return fail(
            409,
            "SOLD_OUT",
            "There are not enough reserved seats for this group. Choose another class or train.",
          );
        const occupied = new Set(
          (
            await tx.all(
              "SELECT seat_number FROM rail_seats WHERE inventory_id = ?",
              [id],
            )
          ).map((row) => Number(row.seat_number)),
        );
        const available = Array.from(
          { length: capacity },
          (_, index) => index + 1,
        ).filter((seat) => !occupied.has(seat));
        if (available.length < body.passengers.length)
          throw new Error("Rail inventory allocation inconsistency");
        const reservationId = randomUUID();
        const pnr = `DEMO-${randomBytes(6).toString("hex").toUpperCase()}`;
        await tx.run(
          "INSERT INTO rail_reservations(id,user_id,pnr,inventory_id,contact_email,contact_mobile,payment_method,created_at) VALUES(?,?,?,?,?,?,?,?)",
          [
            reservationId,
            user.id,
            pnr,
            id,
            body.contactEmail,
            body.contactMobile,
            body.paymentMethod,
            now,
          ],
        );
        const tickets = [];
        for (const passenger of body.passengers) {
          const preferred = available.findIndex(
            (seat) =>
              berthType(body.travelClass, seat) === passenger.berthPreference,
          );
          const seat = available.splice(preferred < 0 ? 0 : preferred, 1)[0]!;
          const ticketId = randomUUID();
          const code = `CP-${randomBytes(8).toString("hex").toUpperCase()}`;
          const hash = commitment(ticketId, eventId);
          await tx.run(
            "INSERT INTO tickets(id,event_id,user_id,code,status,created_at,price_paid,commitment,chain_status,transaction_hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
            [
              ticketId,
              eventId,
              user.id,
              code,
              "valid",
              now,
              price,
              hash,
              config.blockchainEnabled ? "pending" : "disabled",
              null,
            ],
          );
          const details: RailTicketDetails = {
            reservationId,
            pnr,
            trainId: train.id,
            trainNumber: train.number,
            trainName: train.name,
            journeyDate: body.journeyDate,
            from: train.from,
            to: train.to,
            boardingStation: station(body.boardingStation),
            departureAt: train.departureAt,
            arrivalAt: train.arrivalAt,
            travelClass: body.travelClass,
            quota: body.quota,
            passenger,
            coach: `${CLASSES.find((item) => item.code === body.travelClass)!.prefix}${body.quota === "TATKAL" ? "2" : "1"}`,
            seat: String(seat),
            berthType: berthType(body.travelClass, seat),
            identityMode: "sandbox",
          };
          await tx.run(
            "INSERT INTO rail_ticket_details(ticket_id,reservation_id,inventory_id,details) VALUES(?,?,?,?)",
            [ticketId, reservationId, id, JSON.stringify(details)],
          );
          await tx.run(
            "INSERT INTO rail_seats(inventory_id,seat_number,ticket_id) VALUES(?,?,?)",
            [id, seat, ticketId],
          );
          if (config.blockchainEnabled)
            await tx.run(
              "INSERT INTO outbox(id,ticket_id,commitment,status,attempts,available_at,created_at) VALUES(?,?,?,?,?,?,?)",
              [randomUUID(), ticketId, hash, "pending", 0, now, now],
            );
          tickets.push(
            await ticketFrom(
              (await tx.get("SELECT * FROM tickets WHERE id = ?", [ticketId]))!,
              tx,
              config.qrSecret,
            ),
          );
        }
        const booking: RailBooking = {
          reservationId,
          pnr,
          paymentMode: "sandbox",
          tickets,
          total: price * body.passengers.length,
        };
        await tx.run(
          "UPDATE idempotency SET response = ? WHERE user_id = ? AND key = ?",
          [JSON.stringify(booking), user.id, key],
        );
        return booking;
      });
      reply.header("x-payment-mode", "demo-no-charge").code(201);
      return result;
    },
  );
}
