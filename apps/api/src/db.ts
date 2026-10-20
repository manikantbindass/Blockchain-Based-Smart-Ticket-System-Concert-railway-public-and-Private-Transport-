import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import type { Config } from "./config.js";

export type Row = Record<string, unknown>;
type Value = string | number | null;
export interface Queryable {
  all<T extends Row = Row>(sql: string, values?: Value[]): Promise<T[]>;
  get<T extends Row = Row>(
    sql: string,
    values?: Value[],
  ): Promise<T | undefined>;
  run(sql: string, values?: Value[]): Promise<number>;
}
export interface Database extends Queryable {
  kind: "sqlite" | "postgres";
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function pgQuery(client: Pick<pg.Pool, "query"> | pg.PoolClient): Queryable {
  const prepare = (sql: string) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  return {
    async all<T extends Row>(sql: string, values: Value[] = []) {
      return (await client.query(prepare(sql), values)).rows as T[];
    },
    async get<T extends Row>(sql: string, values: Value[] = []) {
      return (await client.query(prepare(sql), values)).rows[0] as
        T | undefined;
    },
    async run(sql: string, values: Value[] = []) {
      return (await client.query(prepare(sql), values)).rowCount || 0;
    },
  };
}

export async function openDatabase(config: Config): Promise<Database> {
  let db: Database;
  if (config.databaseUrl) {
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    db = {
      ...pgQuery(pool),
      kind: "postgres",
      async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const value = await fn(pgQuery(client));
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      async close() {
        await pool.end();
      },
    };
  } else {
    if (config.sqlitePath !== ":memory:")
      mkdirSync(dirname(config.sqlitePath), { recursive: true });
    const sqlite = new DatabaseSync(config.sqlitePath);
    sqlite.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const direct: Queryable = {
      async all<T extends Row>(sql: string, values: Value[] = []) {
        return sqlite.prepare(sql).all(...values) as T[];
      },
      async get<T extends Row>(sql: string, values: Value[] = []) {
        return sqlite.prepare(sql).get(...values) as T | undefined;
      },
      async run(sql: string, values: Value[] = []) {
        return Number(sqlite.prepare(sql).run(...values).changes);
      },
    };
    // All SQLite access shares this FIFO so async transaction bodies cannot interleave.
    let tail: Promise<unknown> = Promise.resolve();
    const exclusive = <T>(fn: () => Promise<T>) => {
      const result = tail.then(fn, fn);
      tail = result.catch(() => undefined);
      return result;
    };
    db = {
      kind: "sqlite",
      all: (sql, values) => exclusive(() => direct.all(sql, values)),
      get: (sql, values) => exclusive(() => direct.get(sql, values)),
      run: (sql, values) => exclusive(() => direct.run(sql, values)),
      transaction: (fn) =>
        exclusive(async () => {
          sqlite.exec("BEGIN IMMEDIATE");
          try {
            const value = await fn(direct);
            sqlite.exec("COMMIT");
            return value;
          } catch (error) {
            sqlite.exec("ROLLBACK");
            throw error;
          }
        }),
      async close() {
        await tail;
        sqlite.close();
      },
    };
  }
  await migrate(db);
  return db;
}

const migrations = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('customer','organizer')), created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)`,
      `CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('concert','rail','bus','metro')), city TEXT NOT NULL, venue TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 0), currency TEXT NOT NULL DEFAULT 'INR', capacity INTEGER NOT NULL CHECK(capacity > 0), remaining INTEGER NOT NULL CHECK(remaining >= 0 AND remaining <= capacity), image TEXT NOT NULL, featured INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL, organizer_id TEXT NOT NULL REFERENCES users(id))`,
      `CREATE INDEX IF NOT EXISTS idx_events_catalog ON events(category, starts_at)`,
      `CREATE INDEX IF NOT EXISTS idx_events_organizer ON events(organizer_id, starts_at)`,
      `CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), user_id TEXT NOT NULL REFERENCES users(id), code TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('valid','used','cancelled')), created_at TEXT NOT NULL, price_paid INTEGER NOT NULL, commitment TEXT NOT NULL UNIQUE, chain_status TEXT NOT NULL CHECK(chain_status IN ('pending','anchored','disabled')), transaction_hash TEXT)`,
      `CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_tickets_event_status ON tickets(event_id, status)`,
      `CREATE TABLE IF NOT EXISTS idempotency (user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,key))`,
      `CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets(id), commitment TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','complete')), attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, lease_until TEXT, lease_token TEXT, transaction_hash TEXT, last_error TEXT, created_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status, available_at, lease_until)`,
      `CREATE TABLE IF NOT EXISTS checkin_audit (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), organizer_id TEXT NOT NULL REFERENCES users(id), checked_in_at TEXT NOT NULL)`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE rail_identity_challenges (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, otp_hash TEXT NOT NULL, name TEXT NOT NULL, date_of_birth TEXT NOT NULL, gender TEXT NOT NULL, document_type TEXT NOT NULL, consent_version TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), status TEXT NOT NULL CHECK(status IN ('active','used','replaced')))`,
      `CREATE INDEX idx_rail_challenges_user ON rail_identity_challenges(user_id,created_at)`,
      `CREATE TABLE rail_identities (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, date_of_birth TEXT NOT NULL, gender TEXT NOT NULL, masked_identifier TEXT NOT NULL, verified_at TEXT NOT NULL, consent_version TEXT NOT NULL, consent_at TEXT NOT NULL, challenge_id TEXT NOT NULL REFERENCES rail_identity_challenges(id))`,
      `CREATE TABLE rail_inventory (id TEXT PRIMARY KEY, train_id TEXT NOT NULL, journey_date TEXT NOT NULL, travel_class TEXT NOT NULL, quota TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity > 0), remaining INTEGER NOT NULL CHECK(remaining >= 0 AND remaining <= capacity), event_id TEXT NOT NULL UNIQUE REFERENCES events(id), UNIQUE(train_id,journey_date,travel_class,quota))`,
      `CREATE TABLE rail_reservations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), pnr TEXT NOT NULL UNIQUE, inventory_id TEXT NOT NULL REFERENCES rail_inventory(id), contact_email TEXT NOT NULL, contact_mobile TEXT NOT NULL, payment_method TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE INDEX idx_rail_reservations_user ON rail_reservations(user_id,created_at)`,
      `CREATE TABLE rail_ticket_details (ticket_id TEXT PRIMARY KEY REFERENCES tickets(id), reservation_id TEXT NOT NULL REFERENCES rail_reservations(id), inventory_id TEXT NOT NULL REFERENCES rail_inventory(id), details TEXT NOT NULL)`,
      `CREATE TABLE rail_seats (inventory_id TEXT NOT NULL REFERENCES rail_inventory(id), seat_number INTEGER NOT NULL CHECK(seat_number > 0), ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets(id), PRIMARY KEY(inventory_id,seat_number))`,
    ],
  },
  {
    version: 3,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_rail_ticket_details_reservation ON rail_ticket_details(reservation_id)`,
      `CREATE INDEX IF NOT EXISTS idx_users_role_created ON users(role,created_at,id)`,
    ],
  },
];

async function migrate(db: Database) {
  await db.transaction(async (tx) => {
    // Prevent two PostgreSQL processes racing startup migrations.
    if (db.kind === "postgres")
      await tx.get("SELECT pg_advisory_xact_lock(861371042)");
    await tx.run(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const migration of migrations) {
      if (
        await tx.get(
          "SELECT version FROM schema_migrations WHERE version = ?",
          [migration.version],
        )
      )
        continue;
      for (const sql of migration.statements) await tx.run(sql);
      await tx.run(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(?,?)",
        [migration.version, new Date().toISOString()],
      );
    }
  });
}
