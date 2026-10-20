import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { RailBookingRequest } from "@chainpass/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Database } from "../src/db.js";

const secret = "rail-tests-secret-with-more-than-thirty-two-characters";
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Database;
let customer: string;
let customerId: string;
let stranger: string;
let date: string;
let testPool: pg.Pool | undefined;
let schema: string | undefined;
const auth = (token = customer) => ({ authorization: `Bearer ${token}` });
const identityBody = {
  name: "Demo Traveller",
  dateOfBirth: "1995-06-15",
  gender: "X",
  documentType: "AADHAAR",
  identifier: "000000000000",
  consent: true,
};
const startIdentity = (payload = identityBody, token = customer) =>
  app.inject({
    method: "POST",
    url: "/api/rail/identity/start",
    headers: auth(token),
    payload,
  });
const verifyIdentity = (challengeId: string, otp: string, token = customer) =>
  app.inject({
    method: "POST",
    url: "/api/rail/identity/verify",
    headers: auth(token),
    payload: { challengeId, otp },
  });
const clearCooldown = () =>
  db.run(
    "UPDATE rail_identity_challenges SET created_at = ? WHERE user_id = ?",
    [new Date(Date.now() - 31_000).toISOString(), customerId],
  );
const passenger = {
  name: "Sample Passenger",
  age: 30,
  gender: "X" as const,
  berthPreference: "WINDOW" as const,
};
function bookingBody(
  overrides: Partial<RailBookingRequest> = {},
): RailBookingRequest {
  return {
    trainId: "demo-vande-bharat",
    journeyDate: date,
    travelClass: "CC",
    quota: "GENERAL",
    boardingStation: "SBC",
    passengers: [{ ...passenger }],
    contactEmail: "traveller@example.com",
    contactMobile: "9000000000",
    paymentMethod: "DEMO_UPI",
    acceptedTerms: true,
    ...overrides,
  };
}
const book = (
  body = bookingBody(),
  key = randomUUID(),
  token = customer,
  target = app,
) =>
  target.inject({
    method: "POST",
    url: "/api/rail/bookings",
    headers: { ...auth(token), "idempotency-key": key },
    payload: body,
  });
const trains = (quota = "GENERAL", day = date) =>
  app.inject(`/api/rail/trains?from=SBC&to=MAS&date=${day}&quota=${quota}`);
const cancel = (ticketId: string, token = customer) =>
  app.inject({
    method: "POST",
    url: `/api/tickets/${ticketId}/cancel`,
    headers: auth(token),
  });

before(async () => {
  let databaseUrl: string | undefined;
  if (process.env.TEST_DATABASE_URL) {
    testPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    schema = `chainpass_rail_test_${randomUUID().replaceAll("-", "")}`;
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
    blockchainEnabled: true,
    chainId: 31337,
    issuerPrivateKey: "",
    registryAddress: `0x${"1".repeat(40)}`,
  });
  db = await openDatabase(config);
  app = await buildApp({ config, database: db, logger: false });
  for (const [index, email] of [
    "rail-traveller@example.com",
    "rail-other@example.com",
  ].entries()) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Rail Test User",
        email,
        password: "RailTestSecure123!",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    if (index === 0) {
      customer = response.json().token;
      customerId = response.json().user.id;
    } else stranger = response.json().token;
  }
  date = (await app.inject("/api/rail/options")).json().suggestedDate;
});
after(async () => {
  await app?.close();
  await db?.close();
  if (testPool && schema) {
    await testPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await testPool.end();
  }
});

test("rail search validates calendar dates, stations, quota, and class with empty unsupported routes", async () => {
  const options = (await app.inject("/api/rail/options")).json();
  assert.equal(options.mode, "sandbox");
  assert.ok(
    options.stations.some(
      (station: { code: string }) => station.code === "SBC",
    ),
  );
  const results = (await trains()).json().trains;
  assert.equal(results.length, 2);
  assert.equal(
    results[0].classes.find((item: { code: string }) => item.code === "CC")
      .fare,
    125000,
  );
  assert.equal(
    (
      await app.inject(
        `/api/rail/trains?from=SBC&to=MAS&date=${date}&travelClass=EC`,
      )
    ).json().trains.length,
    1,
  );
  assert.deepEqual(
    (await app.inject(`/api/rail/trains?from=NDLS&to=MAO&date=${date}`)).json()
      .trains,
    [],
  );
  for (const url of [
    `/api/rail/trains?from=SBC&to=SBC&date=${date}`,
    `/api/rail/trains?from=BAD&to=MAS&date=${date}`,
    "/api/rail/trains?from=SBC&to=MAS&date=2027-02-30",
    "/api/rail/trains?from=SBC&to=MAS&date=2000-01-01",
    `/api/rail/trains?from=SBC&to=MAS&date=${date}&travelClass=FAKE`,
    `/api/rail/trains?from=SBC&to=MAS&date=${options.maxDate}&quota=TATKAL`,
  ])
    assert.equal((await app.inject(url)).statusCode, 400, url);
});

test("rail reservations require authentication and account identity; generic rail checkout is blocked", async () => {
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/rail/bookings",
        payload: bookingBody(),
      })
    ).statusCode,
    401,
  );
  assert.equal((await book()).json().error, "RAIL_IDENTITY_REQUIRED");
  const bypass = await app.inject({
    method: "POST",
    url: "/api/bookings",
    headers: { ...auth(), "idempotency-key": randomUUID() },
    payload: { eventId: "evt-vande-bharat", quantity: 1 },
  });
  assert.equal(bypass.statusCode, 409);
  assert.equal(bypass.json().error, "RAIL_FLOW_REQUIRED");
  assert.equal(
    (
      await db.get("SELECT COUNT(*) AS count FROM tickets WHERE user_id = ?", [
        customerId,
      ])
    )?.count,
    db.kind === "postgres" ? "0" : 0,
  );
});

test("identity accepts only test identifiers with consent and never stores raw OTP or identifiers", async () => {
  assert.equal(
    (
      await startIdentity({ ...identityBody, identifier: "234567890123" })
    ).json().error,
    "TEST_IDENTITY_ONLY",
  );
  assert.equal(
    (await startIdentity({ ...identityBody, consent: false })).statusCode,
    400,
  );
  assert.equal(
    (await startIdentity({ ...identityBody, dateOfBirth: "2027-02-30" }))
      .statusCode,
    400,
  );
  assert.equal(
    Number(
      (await db.get("SELECT COUNT(*) AS count FROM rail_identity_challenges"))
        ?.count,
    ),
    0,
  );
  const [first, second] = await Promise.all([startIdentity(), startIdentity()]);
  const success = [first, second].find((result) => result.statusCode === 200)!;
  assert.equal(
    [first, second].filter((result) => result.statusCode === 429).length,
    1,
  );
  const challenge = success.json();
  assert.match(challenge.demoOtp, /^\d{6}$/);
  const row = await db.get(
    "SELECT * FROM rail_identity_challenges WHERE id = ?",
    [challenge.challengeId],
  );
  assert.match(String(row?.otp_hash), /^[a-f0-9]{64}$/);
  assert.notEqual(row?.otp_hash, challenge.demoOtp);
  assert.equal(row?.identifier, undefined);
  assert.equal(row?.otp, undefined);
  assert.equal(row?.consent_version, "rail-sandbox-v1");
  assert.equal(
    (
      await verifyIdentity(challenge.challengeId, challenge.demoOtp, stranger)
    ).json().error,
    "OTP_INVALID_CHALLENGE",
  );
  assert.equal(
    Number(
      (
        await db.get(
          "SELECT attempts FROM rail_identity_challenges WHERE id = ?",
          [challenge.challengeId],
        )
      )?.attempts,
    ),
    0,
  );
  const wrong = challenge.demoOtp === "111111" ? "222222" : "111111";
  const guesses = await Promise.all(
    Array.from({ length: 5 }, () =>
      verifyIdentity(challenge.challengeId, wrong),
    ),
  );
  assert.ok(guesses.every((response) => response.statusCode === 400));
  assert.equal(
    Number(
      (
        await db.get(
          "SELECT attempts FROM rail_identity_challenges WHERE id = ?",
          [challenge.challengeId],
        )
      )?.attempts,
    ),
    5,
  );
  assert.equal(
    (await verifyIdentity(challenge.challengeId, challenge.demoOtp)).json()
      .error,
    "OTP_ATTEMPTS_EXHAUSTED",
  );
  assert.equal(
    (await app.inject({ url: "/api/rail/identity", headers: auth() })).json()
      .verified,
    false,
  );
});

test("identity challenges expire, replacements invalidate old codes, and successful verification is single use", async () => {
  await clearCooldown();
  const expired = (await startIdentity()).json();
  await db.run(
    "UPDATE rail_identity_challenges SET expires_at = ? WHERE id = ?",
    [new Date(Date.now() - 1000).toISOString(), expired.challengeId],
  );
  assert.equal(
    (await verifyIdentity(expired.challengeId, expired.demoOtp)).json().error,
    "OTP_EXPIRED",
  );
  await clearCooldown();
  const replaced = (await startIdentity()).json();
  await clearCooldown();
  const fresh = (
    await startIdentity({
      ...identityBody,
      documentType: "VID",
      identifier: "0000000000000000",
    })
  ).json();
  assert.equal(
    (await verifyIdentity(replaced.challengeId, replaced.demoOtp)).json().error,
    "OTP_INVALID_CHALLENGE",
  );
  const responses = await Promise.all([
    verifyIdentity(fresh.challengeId, fresh.demoOtp),
    verifyIdentity(fresh.challengeId, fresh.demoOtp),
  ]);
  assert.equal(
    responses.filter((response) => response.statusCode === 200).length,
    1,
  );
  assert.equal(
    responses.filter((response) => response.statusCode === 400).length,
    1,
  );
  const identity = (
    await app.inject({ url: "/api/rail/identity", headers: auth() })
  ).json();
  assert.equal(identity.verified, true);
  assert.equal(identity.mode, "sandbox");
  assert.match(identity.maskedIdentifier, /^TEST VID/);
  assert.equal(
    (
      await app.inject({ url: "/api/rail/identity", headers: auth(stranger) })
    ).json().verified,
    false,
  );
  const audit = await db.get(
    "SELECT consent_version,challenge_id FROM rail_identities WHERE user_id = ?",
    [customerId],
  );
  assert.equal(audit?.consent_version, "rail-sandbox-v1");
  assert.equal(audit?.challenge_id, fresh.challengeId);
});

test("rail booking derives fare, assigns distinct seats, persists passenger metadata and atomic outbox", async () => {
  const response = await book(
    bookingBody({
      passengers: [
        { ...passenger },
        { ...passenger, name: "Second Passenger", age: 11 },
      ],
      boardingStation: "BNC",
    }),
  );
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.headers["x-payment-mode"], "demo-no-charge");
  const result = response.json();
  assert.equal(result.total, 250000);
  assert.match(result.pnr, /^DEMO-/);
  assert.equal(result.paymentMode, "sandbox");
  assert.equal(
    new Set(
      result.tickets.map(
        (ticket: any) => `${ticket.rail.coach}-${ticket.rail.seat}`,
      ),
    ).size,
    2,
  );
  for (const ticket of result.tickets) {
    assert.equal(ticket.rail.pnr, result.pnr);
    assert.equal(ticket.rail.boardingStation.code, "BNC");
    assert.equal(ticket.rail.identityMode, "sandbox");
    assert.equal(ticket.chainStatus, "pending");
    assert.equal(
      (
        await db.get("SELECT status FROM outbox WHERE ticket_id = ?", [
          ticket.id,
        ])
      )?.status,
      "pending",
    );
  }
  assert.equal(
    Number(
      (
        await db.get(
          "SELECT COUNT(*) AS count FROM outbox o JOIN rail_ticket_details r ON r.ticket_id = o.ticket_id WHERE r.reservation_id = ?",
          [result.reservationId],
        )
      )?.count,
    ),
    result.tickets.length,
  );
  assert.equal(
    (await trains())
      .json()
      .trains[0].classes.find((item: any) => item.code === "CC").remaining,
    62,
  );
  assert.equal(
    (await app.inject("/api/events?category=rail")).json().events.length,
    2,
  );
  const wallet = (
    await app.inject({ url: "/api/tickets", headers: auth() })
  ).json().tickets;
  assert.deepEqual(
    wallet.find((ticket: any) => ticket.id === result.tickets[0].id).rail,
    result.tickets[0].rail,
  );
  const read = await app.inject({
    url: `/api/rail/bookings/${result.reservationId}`,
    headers: auth(),
  });
  assert.equal(read.json().tickets.length, 2);
  assert.equal(read.json().total, result.total);
  assert.equal(
    (
      await app.inject({
        url: `/api/rail/bookings/${result.reservationId}`,
        headers: auth(stranger),
      })
    ).statusCode,
    404,
  );
  const publicResponse = await app.inject(
    `/api/verify/${result.tickets[0].code}`,
  );
  assert.equal(publicResponse.json().sandboxRail, true);
  assert.deepEqual(Object.keys(publicResponse.json()).sort(), [
    "chainStatus",
    "commitment",
    "eventTitle",
    "sandboxRail",
    "status",
    "transactionHash",
    "valid",
  ]);
  for (const sensitive of [
    result.pnr,
    result.reservationId,
    "Sample Passenger",
    customerId,
    result.tickets[0].qrPayload,
  ])
    assert.ok(!publicResponse.body.includes(sensitive));
  const bypass = await app.inject({
    method: "POST",
    url: "/api/bookings",
    headers: { ...auth(), "idempotency-key": randomUUID() },
    payload: { eventId: result.tickets[0].eventId, quantity: 1 },
  });
  assert.equal(bypass.json().error, "RAIL_FLOW_REQUIRED");
});

test("rail validation rejects invalid classes, boarding, extra prices, passenger limits and consent", async () => {
  for (const patch of [
    { travelClass: "SL" },
    { trainId: "missing" },
    { boardingStation: "NDLS" },
    { passengers: [{ ...passenger, age: 4 }] },
    { passengers: [{ ...passenger, name: "<script>" }] },
    { quota: "TATKAL", passengers: Array(5).fill(passenger) },
    { passengers: Array(7).fill(passenger) },
    { acceptedTerms: false },
    { price: 1 },
  ])
    assert.equal(
      (await book({ ...bookingBody(), ...patch } as RailBookingRequest))
        .statusCode,
      400,
      JSON.stringify(patch),
    );
});

test("rail idempotency coalesces concurrent retries and conflicts across payloads and generic bookings", async () => {
  const key = randomUUID();
  const responses = await Promise.all([
    book(bookingBody(), key),
    book(bookingBody(), key),
  ]);
  for (const response of responses)
    assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(responses[0].json(), responses[1].json());
  assert.equal(
    (await book(bookingBody({ paymentMethod: "DEMO_CARD" }), key)).json().error,
    "IDEMPOTENCY_CONFLICT",
  );
  const generic = await app.inject({
    method: "POST",
    url: "/api/bookings",
    headers: { ...auth(), "idempotency-key": key },
    payload: { eventId: "evt-neon-nights", quantity: 1 },
  });
  assert.equal(generic.json().error, "IDEMPOTENCY_CONFLICT");
});

test("rail idempotency still returns its original receipt after the Tatkal and journey windows close", async () => {
  const key = randomUUID();
  const body = bookingBody({ travelClass: "CC", quota: "TATKAL" });
  const original = await book(body, key);
  assert.equal(original.statusCode, 201, original.body);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 3 * 86_400_000;
    const replay = await book(body, key);
    assert.equal(replay.statusCode, 201, replay.body);
    assert.deepEqual(replay.json(), original.json());
    assert.equal((await book(body)).json().error, "JOURNEY_DATE_INVALID");
  } finally {
    Date.now = realNow;
  }
});

test("failure midway through rail issuance rolls back stock, reservations, tickets, outbox, and idempotency", async () => {
  const tables = [
    "events",
    "rail_inventory",
    "rail_reservations",
    "tickets",
    "rail_ticket_details",
    "rail_seats",
    "outbox",
    "idempotency",
  ];
  const counts = async () =>
    Promise.all(
      tables.map(async (table) =>
        Number((await db.get(`SELECT COUNT(*) AS count FROM ${table}`))?.count),
      ),
    );
  const beforeCounts = await counts();
  let detailsWritten = 0;
  const faultDatabase: Database = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          ...tx,
          run: async (sql, values) => {
            if (
              sql.startsWith("INSERT INTO rail_ticket_details") &&
              ++detailsWritten === 2
            )
              throw new Error("Injected second-passenger persistence failure");
            return tx.run(sql, values);
          },
        }),
      ),
  };
  const faultApp = await buildApp({
    database: faultDatabase,
    logger: false,
    config: {
      production: false,
      seedDemo: false,
      demoMode: true,
      qrSecret: secret,
      blockchainEnabled: true,
      chainId: 31337,
      issuerPrivateKey: "",
      registryAddress: `0x${"1".repeat(40)}`,
    },
  });
  try {
    const response = await book(
      bookingBody({
        trainId: "demo-taj-intercity",
        boardingStation: "NDLS",
        passengers: [
          { ...passenger },
          { ...passenger, name: "Another Passenger" },
        ],
      }),
      randomUUID(),
      customer,
      faultApp,
    );
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(detailsWritten, 2);
    assert.deepEqual(await counts(), beforeCounts);
  } finally {
    await faultApp.close();
  }
});

test("concurrent rail bookings cannot oversell final seats and quota coach pools never overlap", async () => {
  const tatkal = bookingBody({ travelClass: "EC", quota: "TATKAL" });
  for (const count of [4, 3])
    assert.equal(
      (await book({ ...tatkal, passengers: Array(count).fill(passenger) }))
        .statusCode,
      201,
    );
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () => book(tatkal)),
  );
  assert.equal(
    attempts.filter((response) => response.statusCode === 201).length,
    1,
  );
  assert.equal(
    attempts.filter((response) => response.json().error === "SOLD_OUT").length,
    4,
  );
  assert.equal(
    (await trains("TATKAL"))
      .json()
      .trains[0].classes.find((item: any) => item.code === "EC").remaining,
    0,
  );
  const general = await book(bookingBody({ travelClass: "EC" }));
  assert.equal(general.statusCode, 201, general.body);
  assert.equal(general.json().tickets[0].rail.coach, "E1");
  assert.equal(
    (await trains())
      .json()
      .trains[0].classes.find((item: any) => item.code === "EC").remaining,
    23,
  );
  assert.equal(
    attempts.find((response) => response.statusCode === 201)!.json().tickets[0]
      .rail.coach,
    "E2",
  );
  const allocated = await db.all(
    "SELECT s.seat_number FROM rail_seats s JOIN rail_inventory i ON i.id = s.inventory_id WHERE i.train_id = ? AND i.quota = 'TATKAL' AND i.travel_class = 'EC'",
    [tatkal.trainId],
  );
  assert.equal(allocated.length, 8);
  assert.equal(new Set(allocated.map((row) => row.seat_number)).size, 8);
});

test("partial rail cancellation releases precisely one seat once and reservation reads show current status", async () => {
  const initial = await book(
    bookingBody({
      trainId: "demo-lalbagh",
      travelClass: "SL",
      passengers: [
        { ...passenger, berthPreference: "LOWER" },
        { ...passenger, name: "Remaining Passenger", berthPreference: "UPPER" },
      ],
    }),
  );
  assert.equal(initial.statusCode, 201, initial.body);
  const result = initial.json();
  const first = result.tickets[0];
  assert.equal((await cancel(first.id, stranger)).statusCode, 404);
  const cancellations = await Promise.all([cancel(first.id), cancel(first.id)]);
  assert.ok(cancellations.some((response) => response.statusCode === 200));
  const inventory = await db.get(
    "SELECT remaining,capacity FROM rail_inventory WHERE event_id = ?",
    [first.eventId],
  );
  assert.equal(Number(inventory?.remaining), Number(inventory?.capacity) - 1);
  assert.equal(
    Number(
      (
        await db.get("SELECT remaining FROM events WHERE id = ?", [
          first.eventId,
        ])
      )?.remaining,
    ),
    Number(inventory?.remaining),
  );
  assert.equal(
    await db.get("SELECT ticket_id FROM rail_seats WHERE ticket_id = ?", [
      first.id,
    ]),
    undefined,
  );
  assert.equal(
    (await app.inject(`/api/verify/${first.code}`)).json().valid,
    false,
  );
  const read = (
    await app.inject({
      url: `/api/rail/bookings/${result.reservationId}`,
      headers: auth(),
    })
  ).json();
  assert.equal(
    read.tickets.find((ticket: any) => ticket.id === first.id).status,
    "cancelled",
  );
  assert.equal(
    read.tickets.find((ticket: any) => ticket.id === result.tickets[1].id)
      .status,
    "valid",
  );
  const replacement = (
    await book(
      bookingBody({
        trainId: "demo-lalbagh",
        travelClass: "SL",
        passengers: [{ ...passenger, berthPreference: "LOWER" }],
      }),
    )
  ).json().tickets[0];
  assert.equal(replacement.rail.seat, first.rail.seat);
  assert.equal(replacement.rail.coach, first.rail.coach);
});

test("rail sandbox fails closed in production even when demo payments are enabled", async () => {
  for (const mode of [
    { production: true, demoMode: true },
    { production: false, demoMode: false },
  ]) {
    const disabled = await buildApp({
      database: db,
      logger: false,
      config: {
        ...mode,
        seedDemo: false,
        qrSecret: secret,
        blockchainEnabled: false,
      },
    });
    try {
      assert.equal(
        (await disabled.inject("/api/rail/options")).json().mode,
        "unavailable",
      );
      assert.deepEqual(
        (
          await disabled.inject({ url: "/api/rail/identity", headers: auth() })
        ).json(),
        { verified: false, mode: "unavailable" },
      );
      for (const url of [
        "/api/rail/identity/start",
        "/api/rail/identity/verify",
        "/api/rail/bookings",
      ])
        assert.equal(
          (
            await disabled.inject({
              method: "POST",
              url,
              headers: auth(),
              payload: {},
            })
          ).json().error,
          "RAIL_SANDBOX_UNAVAILABLE",
        );
      assert.equal(
        (await disabled.inject(`/api/rail/trains?from=SBC&to=MAS&date=${date}`))
          .statusCode,
        503,
      );
    } finally {
      await disabled.close();
    }
  }
});
