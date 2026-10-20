import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { z } from "zod";
import type { AuthProviders, Session, User } from "@chainpass/shared";
import type { Config } from "./config.js";
import type { Database, Queryable } from "./db.js";
import { userFrom } from "./models.js";
import { sha256, verifyPassword } from "./security.js";

/** Only the verifier crosses the external trust boundary; request bodies never supply claims. */
export interface FirebaseIdentity {
  uid: string;
  authTime: number;
  provider: string;
  email?: string;
  emailVerified?: boolean;
  phoneNumber?: string;
  name?: string;
}
export interface FirebaseVerifier {
  verifyIdToken(token: string): Promise<FirebaseIdentity>;
}
interface Dependencies {
  session(user: User): Promise<Session>;
  authenticate(request: FastifyRequest): Promise<User>;
  fail(status: number, code: string, message: string): never;
  verifier?: FirebaseVerifier;
}

const tokenSchema = z
  .object({ idToken: z.string().min(1).max(16_000) })
  .strict();
const linkSchema = tokenSchema.extend({
  password: z.string().max(128).optional(),
});
const identitySchema = z.object({
  uid: z.string().min(1).max(128),
  authTime: z.number().int().positive(),
  provider: z.enum(["google.com", "phone"]),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  emailVerified: z.boolean().optional(),
  phoneNumber: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/)
    .optional(),
  name: z.string().optional(),
});

export function firebaseProviders(config: Config): AuthProviders {
  const configured = Boolean(
    config.firebaseProjectId &&
    config.firebaseApiKey &&
    config.firebaseAuthDomain &&
    config.firebaseAppId,
  );
  return {
    firebase: configured
      ? {
          projectId: config.firebaseProjectId,
          apiKey: config.firebaseApiKey,
          authDomain: config.firebaseAuthDomain,
          appId: config.firebaseAppId,
          ...(config.firebaseMessagingSenderId
            ? { messagingSenderId: config.firebaseMessagingSenderId }
            : {}),
          ...(config.firebaseStorageBucket
            ? { storageBucket: config.firebaseStorageBucket }
            : {}),
        }
      : null,
    google: configured && config.firebaseGoogleEnabled,
    phone: configured && config.firebasePhoneEnabled,
  };
}

export function createFirebaseVerifier(config: Config): FirebaseVerifier {
  if (config.production && process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error(
      "Firebase Authentication emulator is forbidden in production.",
    );
  }
  return {
    async verifyIdToken(token) {
      // Credentials come from GOOGLE_APPLICATION_CREDENTIALS / workload identity,
      // never the public Firebase web config or an incoming request.
      const name = `chainpass-auth-${sha256(config.firebaseProjectId).slice(0, 20)}`;
      const firebaseApp =
        getApps().find((app) => app.name === name) ||
        initializeApp(
          {
            projectId: config.firebaseProjectId,
            credential: applicationDefault(),
          },
          name,
        );
      const claims = await getAuth(firebaseApp).verifyIdToken(token, true);
      return {
        uid: claims.uid,
        authTime: claims.auth_time,
        provider: claims.firebase.sign_in_provider,
        email: claims.email,
        emailVerified: claims.email_verified,
        phoneNumber: claims.phone_number,
        name: typeof claims.name === "string" ? claims.name : undefined,
      };
    },
  };
}

export function registerFirebaseRoutes(
  app: FastifyInstance,
  db: Database,
  config: Config,
  dependencies: Dependencies,
): void {
  const { session, authenticate } = dependencies;
  const fail: (status: number, code: string, message: string) => never =
    dependencies.fail;
  const providers = firebaseProviders(config);
  // Check before accepting any requests, even when an injected verifier is used.
  if (config.production && process.env.FIREBASE_AUTH_EMULATOR_HOST)
    throw new Error(
      "Firebase Authentication emulator is forbidden in production.",
    );
  const verifier = dependencies.verifier || createFirebaseVerifier(config);

  async function verified(token: string, fresh = false) {
    if (!providers.firebase || (!providers.google && !providers.phone))
      fail(
        503,
        "AUTH_PROVIDER_UNAVAILABLE",
        "Google and phone sign-in are not configured yet.",
      );
    let raw: FirebaseIdentity;
    try {
      raw = await verifier.verifyIdToken(token);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (
        [
          "app/invalid-credential",
          "auth/invalid-credential",
          "app/network-error",
          "auth/internal-error",
          "app/network-timeout",
        ].includes(code)
      )
        fail(
          503,
          "AUTH_PROVIDER_UNAVAILABLE",
          "Sign-in is temporarily unavailable. Please try again shortly.",
        );
      fail(
        401,
        "INVALID_FIREBASE_TOKEN",
        "Sign-in could not be verified. Please sign in again.",
      );
    }
    const parsed = identitySchema.safeParse(raw);
    if (!parsed.success)
      fail(
        401,
        "INVALID_FIREBASE_IDENTITY",
        "This sign-in method could not be verified.",
      );
    const identity = parsed.data;
    const now = Math.floor(Date.now() / 1000);
    if (identity.authTime > now + 60)
      fail(
        401,
        "INVALID_FIREBASE_IDENTITY",
        "This sign-in method could not be verified.",
      );
    if (fresh && now - identity.authTime > 300)
      fail(
        401,
        "RECENT_SIGN_IN_REQUIRED",
        "Sign in with Google or phone again before linking an account.",
      );
    if (identity.provider === "google.com") {
      if (!providers.google)
        fail(403, "AUTH_PROVIDER_DISABLED", "Google sign-in is not enabled.");
      if (!identity.email || identity.emailVerified !== true)
        fail(
          401,
          "VERIFIED_EMAIL_REQUIRED",
          "Google sign-in requires a verified email address.",
        );
    } else {
      if (!providers.phone)
        fail(403, "AUTH_PROVIDER_DISABLED", "Phone sign-in is not enabled.");
      if (!identity.phoneNumber)
        fail(
          401,
          "VERIFIED_PHONE_REQUIRED",
          "Phone sign-in requires a verified mobile number.",
        );
    }
    // A phone provider's unrelated email claim does not establish email ownership.
    if (identity.provider === "phone" && identity.emailVerified !== true)
      identity.email = undefined;
    return identity;
  }

  async function lockIdentity(tx: Queryable, uid: string) {
    if (db.kind === "postgres") {
      // Serialize registrations/linking for the same uid across API replicas.
      await tx.get("SELECT pg_advisory_xact_lock(?)", [
        parseInt(sha256(uid).slice(0, 12), 16),
      ]);
    }
  }

  app.get("/api/auth/providers", async () => providers);
  app.post(
    "/api/auth/firebase",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request) => {
      const { idToken } = tokenSchema.parse(request.body);
      const identity = await verified(idToken);
      const user = await db.transaction(async (tx) => {
        await lockIdentity(tx, identity.uid);
        const existing = await tx.get(
          "SELECT u.* FROM users u JOIN auth_identities a ON a.user_id = u.id WHERE a.firebase_uid = ?",
          [identity.uid],
        );
        if (existing) {
          if (
            config.production &&
            String(existing.email).endsWith("@chainpass.local")
          )
            fail(
              403,
              "DEMO_ACCOUNT_DISABLED",
              "Demo accounts cannot sign in to production.",
            );
          if (identity.phoneNumber) {
            await tx.run("UPDATE users SET phone = ? WHERE id = ?", [
              identity.phoneNumber,
              String(existing.id),
            ]);
            existing.phone = identity.phoneNumber;
          }
          return userFrom(existing);
        }
        const id = randomUUID();
        const now = new Date().toISOString();
        const email = identity.email || `${id}@firebase.chainpass.invalid`;
        if (config.production && email.endsWith("@chainpass.local"))
          fail(
            403,
            "DEMO_ACCOUNT_DISABLED",
            "Demo accounts cannot sign in to production.",
          );
        const name =
          identity.name?.trim().slice(0, 80) ||
          (identity.phoneNumber ? "Traveller" : "Explorer");
        const inserted = await tx.run(
          "INSERT INTO users(id,name,email,password_hash,role,created_at,phone,email_is_placeholder) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(email) DO NOTHING",
          [
            id,
            name,
            email,
            "!firebase",
            "customer",
            now,
            identity.phoneNumber || null,
            identity.email ? 0 : 1,
          ],
        );
        if (!inserted)
          fail(
            409,
            "ACCOUNT_LINK_REQUIRED",
            "An account already uses this email. Sign in with its password, then link Google or phone from your account.",
          );
        await tx.run(
          "INSERT INTO auth_identities(firebase_uid,user_id,provider,created_at) VALUES(?,?,?,?)",
          [identity.uid, id, identity.provider, now],
        );
        return userFrom({
          id,
          name,
          email,
          role: "customer",
          phone: identity.phoneNumber,
          email_is_placeholder: identity.email ? 0 : 1,
        });
      });
      return session(user);
    },
  );

  app.post(
    "/api/auth/firebase/link",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const user = await authenticate(request);
      const body = linkSchema.parse(request.body);
      const identity = await verified(body.idToken, true);
      const linked = await db.transaction(async (tx) => {
        await lockIdentity(tx, identity.uid);
        const account = await tx.get(
          `SELECT * FROM users WHERE id = ?${db.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [user.id],
        );
        if (!account) fail(401, "UNAUTHORIZED", "Please sign in again.");
        const current = await tx.get(
          "SELECT * FROM auth_identities WHERE user_id = ? OR firebase_uid = ?",
          [user.id, identity.uid],
        );
        if (current) {
          if (
            current.user_id !== user.id ||
            current.firebase_uid !== identity.uid
          )
            fail(
              409,
              "IDENTITY_ALREADY_LINKED",
              "This account or sign-in identity is already linked. Sign in with the existing method.",
            );
          return userFrom(account);
        }
        // Recheck the existing account password so a stolen, older app session
        // cannot silently add a persistent sign-in method.
        if (
          !body.password ||
          !(await verifyPassword(body.password, String(account.password_hash)))
        )
          fail(
            401,
            "PASSWORD_CONFIRMATION_REQUIRED",
            "Confirm your current account password to link this sign-in method.",
          );
        if (
          identity.email &&
          identity.email !== String(account.email).toLowerCase()
        )
          fail(
            409,
            "LINK_EMAIL_MISMATCH",
            "Use the Google account that matches your account email.",
          );
        const inserted = await tx.run(
          "INSERT INTO auth_identities(firebase_uid,user_id,provider,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
          [identity.uid, user.id, identity.provider, new Date().toISOString()],
        );
        if (!inserted)
          fail(
            409,
            "IDENTITY_ALREADY_LINKED",
            "This account or sign-in identity is already linked.",
          );
        if (identity.phoneNumber) {
          await tx.run("UPDATE users SET phone = ? WHERE id = ?", [
            identity.phoneNumber,
            user.id,
          ]);
          account.phone = identity.phoneNumber;
        }
        return userFrom(account);
      });
      return { user: linked };
    },
  );
}
