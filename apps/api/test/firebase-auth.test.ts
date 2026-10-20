import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Database } from "../src/db.js";
import {
  createFirebaseVerifier,
  type FirebaseIdentity,
  type FirebaseVerifier,
} from "../src/firebase-auth.js";

// These tests inject only the external verifier. All account, session, SQL,
// linking, and authorization behavior runs through the real HTTP routes.
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Database;
let pool: pg.Pool | undefined;
let schema: string | undefined;
let address = 0;
const claims = new Map<string, FirebaseIdentity | Error>();
const verifier: FirebaseVerifier = {
  async verifyIdToken(token) {
    const value = claims.get(token);
    if (!value || value instanceof Error)
      throw value || new Error("Invalid token");
    return value;
  },
};
const config = loadConfig({
  production: false,
  seedDemo: false,
  demoMode: true,
  databaseUrl: undefined,
  sqlitePath: ":memory:",
  qrSecret: "firebase-tests-secret-with-more-than-thirty-two-characters",
  blockchainEnabled: false,
  firebaseProjectId: "chainpass-auth-test",
  firebaseApiKey: "public-api-key-for-tests",
  firebaseAuthDomain: "chainpass-auth-test.firebaseapp.com",
  firebaseAppId: "1:123456789:web:test",
  firebaseGoogleEnabled: true,
  firebasePhoneEnabled: true,
});
function identity(overrides: Partial<FirebaseIdentity> = {}): FirebaseIdentity {
  return {
    uid: randomUUID(),
    authTime: Math.floor(Date.now() / 1000),
    provider: "google.com",
    email: `${randomUUID()}@example.com`,
    emailVerified: true,
    name: "Verified Traveller",
    ...overrides,
  };
}
function registerToken(value: FirebaseIdentity | Error) {
  const token = randomUUID();
  claims.set(token, value);
  return token;
}
function request(url: string, payload: object, token?: string, target = app) {
  return target.inject({
    method: "POST",
    url,
    payload,
    // Auth rate limiting has a separate test; isolate each case's API client.
    remoteAddress: `127.0.0.${++address}`,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}
const login = (value: FirebaseIdentity | Error, target = app) =>
  request(
    "/api/auth/firebase",
    { idToken: registerToken(value) },
    undefined,
    target,
  );
const password = "Current-password-123!";
async function passwordAccount(email = `${randomUUID()}@example.com`) {
  const response = await request("/api/auth/register", {
    email,
    password,
    name: "Existing Traveller",
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    schema = `chainpass_firebase_test_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    config.databaseUrl = url.toString();
  }
  db = await openDatabase(config);
  app = await buildApp({
    config,
    database: db,
    firebaseVerifier: verifier,
    logger: false,
  });
});
after(async () => {
  await app?.close();
  await db?.close();
  if (schema && pool) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool?.end();
});

test("Firebase provider discovery exposes only public web configuration", async () => {
  const response = await app.inject("/api/auth/providers");
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.firebase.apiKey, config.firebaseApiKey);
  assert.equal(body.google, true);
  assert.equal(body.phone, true);
  assert.deepEqual(Object.keys(body).sort(), ["firebase", "google", "phone"]);
  assert.equal(response.body.includes(config.qrSecret), false);
});

test("verified Google sign-in creates a customer and an ordinary revocable app session", async () => {
  const verified = identity();
  const response = await login({
    ...verified,
    role: "organizer",
  } as FirebaseIdentity);
  assert.equal(response.statusCode, 200, response.body);
  const session = response.json();
  assert.equal(session.user.email, verified.email);
  assert.equal(session.user.role, "customer");
  assert.match(session.token, /^[A-Za-z0-9_-]{40,100}$/);
  const me = await app.inject({
    url: "/api/auth/me",
    headers: { authorization: `Bearer ${session.token}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.id, session.user.id);
  const again = await login(verified);
  assert.equal(again.json().user.id, session.user.id);
  await request("/api/auth/logout", {}, session.token);
  const loggedOut = await app.inject({
    url: "/api/auth/me",
    headers: { authorization: `Bearer ${session.token}` },
  });
  assert.equal(loggedOut.statusCode, 401);
});

test("phone sign-in stores verified mobile and hides internal email without enabling password login", async () => {
  const verified = identity({
    provider: "phone",
    email: undefined,
    emailVerified: undefined,
    phoneNumber: "+919000000001",
    name: undefined,
  });
  const response = await login(verified);
  assert.equal(response.statusCode, 200, response.body);
  const user = response.json().user;
  assert.equal(user.email, "");
  assert.equal(user.phone, verified.phoneNumber);
  assert.equal(user.name, "Traveller");
  assert.equal(response.body.includes("firebase.chainpass.invalid"), false);
  const row = await db.get("SELECT * FROM users WHERE id = ?", [user.id]);
  assert.equal(row?.password_hash, "!firebase");
  assert.equal(Number(row?.email_is_placeholder), 1);
  const passwordLogin = await request("/api/auth/login", {
    email: String(row?.email),
    password,
  });
  assert.equal(passwordLogin.statusCode, 401);
  const me = await app.inject({
    url: "/api/auth/me",
    headers: { authorization: `Bearer ${response.json().token}` },
  });
  assert.equal(me.json().user.email, "");
  assert.equal(me.json().user.phone, verified.phoneNumber);
});

test("invalid, revoked, disabled, unsupported and unverified credentials cannot create accounts", async () => {
  const beforeCount = Number(
    (await db.get("SELECT COUNT(*) AS count FROM users"))?.count,
  );
  const cases: Array<FirebaseIdentity | Error> = [
    new Error("Revoked / disabled / invalid signature"),
    identity({ provider: "password" }),
    identity({ emailVerified: false }),
    identity({ email: undefined }),
    identity({ provider: "phone", phoneNumber: undefined }),
    identity({ provider: "phone", phoneNumber: "9000000000" }),
    identity({ authTime: Math.floor(Date.now() / 1000) + 3600 }),
    identity({ uid: "" }),
  ];
  for (const candidate of cases) {
    const response = await login(candidate);
    assert.equal(response.statusCode, 401, response.body);
  }
  assert.equal(
    Number((await db.get("SELECT COUNT(*) AS count FROM users"))?.count),
    beforeCount,
  );
  const injected = await request("/api/auth/firebase", {
    idToken: registerToken(identity()),
    role: "organizer",
  });
  assert.equal(injected.statusCode, 400);
});

test("concurrent exchange of one Firebase identity creates one account", async () => {
  const verified = identity();
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => login(verified)),
  );
  for (const response of responses)
    assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    new Set(responses.map((response) => response.json().user.id)).size,
    1,
  );
  assert.equal(
    Number(
      (
        await db.get(
          "SELECT COUNT(*) AS count FROM auth_identities WHERE firebase_uid = ?",
          [verified.uid],
        )
      )?.count,
    ),
    1,
  );
});

test("an existing email requires explicit authenticated linking and password confirmation", async () => {
  const account = await passwordAccount();
  const verified = identity({ email: account.user.email });
  const collision = await login(verified);
  assert.equal(collision.statusCode, 409);
  assert.equal(collision.json().error, "ACCOUNT_LINK_REQUIRED");
  const token = registerToken(verified);
  const unauthenticated = await request("/api/auth/firebase/link", {
    idToken: token,
    password,
  });
  assert.equal(unauthenticated.statusCode, 401);
  const missingPassword = await request(
    "/api/auth/firebase/link",
    { idToken: token },
    account.token,
  );
  assert.equal(missingPassword.statusCode, 401);
  const wrongPassword = await request(
    "/api/auth/firebase/link",
    { idToken: token, password: "Wrong-password-123!" },
    account.token,
  );
  assert.equal(wrongPassword.statusCode, 401);
  const stale = await request(
    "/api/auth/firebase/link",
    {
      idToken: registerToken({
        ...verified,
        authTime: Math.floor(Date.now() / 1000) - 301,
      }),
      password,
    },
    account.token,
  );
  assert.equal(stale.statusCode, 401);
  assert.equal(stale.json().error, "RECENT_SIGN_IN_REQUIRED");
  const linked = await request(
    "/api/auth/firebase/link",
    { idToken: token, password },
    account.token,
  );
  assert.equal(linked.statusCode, 200, linked.body);
  assert.equal(linked.json().user.id, account.user.id);
  assert.equal((await login(verified)).json().user.id, account.user.id);
});

test("linking rejects mismatched emails and cannot move an identity between users", async () => {
  const first = await passwordAccount();
  const second = await passwordAccount();
  const mismatch = await request(
    "/api/auth/firebase/link",
    { idToken: registerToken(identity()), password },
    first.token,
  );
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.json().error, "LINK_EMAIL_MISMATCH");
  const verified = identity({ email: first.user.email });
  const idToken = registerToken(verified);
  assert.equal(
    (
      await request(
        "/api/auth/firebase/link",
        { idToken, password },
        first.token,
      )
    ).statusCode,
    200,
  );
  const reassign = await request(
    "/api/auth/firebase/link",
    { idToken, password },
    second.token,
  );
  assert.equal(reassign.statusCode, 409);
  const replacement = await request(
    "/api/auth/firebase/link",
    { idToken: registerToken(identity({ email: first.user.email })), password },
    first.token,
  );
  assert.equal(replacement.statusCode, 409);
  const row = await db.get(
    "SELECT user_id FROM auth_identities WHERE firebase_uid = ?",
    [verified.uid],
  );
  assert.equal(row?.user_id, first.user.id);
});

test("simultaneous different identities for one email never merge accounts implicitly", async () => {
  const email = `${randomUUID()}@example.com`;
  const responses = await Promise.all([
    login(identity({ email })),
    login(identity({ email })),
  ]);
  assert.deepEqual(
    responses.map((response) => response.statusCode).sort(),
    [200, 409],
  );
  assert.equal(
    Number(
      (
        await db.get("SELECT COUNT(*) AS count FROM users WHERE email = ?", [
          email,
        ])
      )?.count,
    ),
    1,
  );
});

test("unconfigured and disabled Firebase methods fail closed", async () => {
  const unconfigured = await buildApp({
    config: {
      ...config,
      firebaseApiKey: "",
      firebaseProjectId: "",
      firebaseAuthDomain: "",
      firebaseAppId: "",
    },
    database: db,
    firebaseVerifier: verifier,
    logger: false,
  });
  try {
    const status = await unconfigured.inject("/api/auth/providers");
    assert.deepEqual(status.json(), {
      firebase: null,
      google: false,
      phone: false,
    });
    assert.equal((await login(identity(), unconfigured)).statusCode, 503);
  } finally {
    await unconfigured.close();
  }
  const disabled = await buildApp({
    config: { ...config, firebaseGoogleEnabled: false },
    database: db,
    firebaseVerifier: verifier,
    logger: false,
  });
  try {
    assert.equal((await login(identity(), disabled)).statusCode, 403);
  } finally {
    await disabled.close();
  }
});

test("production cannot use an unsigned-token Firebase emulator", () => {
  const previous = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
  try {
    assert.throws(
      () => createFirebaseVerifier({ ...config, production: true }),
      /emulator is forbidden/,
    );
  } finally {
    if (previous === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    else process.env.FIREBASE_AUTH_EMULATOR_HOST = previous;
  }
});
