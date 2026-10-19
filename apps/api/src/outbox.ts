import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";

export interface ChainAdapter {
  findAnchor(commitment: string): Promise<string | null>;
  submit(commitment: string): Promise<string>;
  confirm(transactionHash: string): Promise<void>;
}

/** A recoverable lease protects a job. Run one worker per issuer key to serialize EVM nonces. */
export async function processOne(
  db: Database,
  chain: ChainAdapter,
): Promise<boolean> {
  const token = randomUUID();
  const now = new Date().toISOString();
  const leaseUntil = () => new Date(Date.now() + 120_000).toISOString();
  const job = await db.transaction(async (tx) => {
    const row = await tx.get(
      `SELECT * FROM outbox WHERE (status = 'pending' AND available_at <= ?) OR (status = 'processing' AND lease_until <= ?) ORDER BY created_at ASC LIMIT 1${db.kind === "postgres" ? " FOR UPDATE SKIP LOCKED" : ""}`,
      [now, now],
    );
    if (!row) return null;
    await tx.run(
      "UPDATE outbox SET status = 'processing', lease_until = ?, lease_token = ?, attempts = attempts + 1 WHERE id = ?",
      [leaseUntil(), token, String(row.id)],
    );
    return row;
  });
  if (!job) return false;
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void db
      .run(
        "UPDATE outbox SET lease_until = ? WHERE id = ? AND lease_token = ? AND status = 'processing'",
        [leaseUntil(), String(job.id), token],
      )
      .then((changes) => {
        if (!changes) leaseLost = true;
      })
      .catch(() => {
        leaseLost = true;
      });
  }, 30_000);
  heartbeat.unref();
  try {
    // Read the registry first: a previous worker may have mined before its DB commit.
    let transactionHash = await chain.findAnchor(String(job.commitment));
    if (!transactionHash && job.transaction_hash) {
      await chain.confirm(String(job.transaction_hash));
      transactionHash = await chain.findAnchor(String(job.commitment));
    }
    if (!transactionHash) {
      if (leaseLost) throw new Error("Outbox lease lost before submit");
      transactionHash = await chain.submit(String(job.commitment));
      await db.run(
        "UPDATE outbox SET transaction_hash = ? WHERE id = ? AND lease_token = ?",
        [transactionHash, String(job.id), token],
      );
      await chain.confirm(transactionHash);
      const anchoredHash = await chain.findAnchor(String(job.commitment));
      if (!anchoredHash)
        throw new Error("Confirmed transaction did not anchor the ticket");
      transactionHash = anchoredHash;
    }
    await db.transaction(async (tx) => {
      const changed = await tx.run(
        "UPDATE outbox SET status = 'complete', transaction_hash = ?, lease_token = NULL, lease_until = NULL, last_error = NULL WHERE id = ? AND lease_token = ?",
        [transactionHash, String(job.id), token],
      );
      if (changed)
        await tx.run(
          "UPDATE tickets SET chain_status = 'anchored', transaction_hash = ? WHERE id = ?",
          [transactionHash, String(job.ticket_id)],
        );
    });
  } catch (error) {
    const attempts = Number(job.attempts) + 1;
    const delay = Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8));
    // Error codes only; RPC messages can contain provider credentials or signed data.
    const message =
      error instanceof Error ? error.name.slice(0, 80) : "ChainProcessingError";
    // A mined revert cannot succeed on another confirmation attempt. Allow a
    // fresh submission on retry; timeouts retain their hash for reconciliation.
    if (message === "TransactionRevertedError")
      await db.run(
        "UPDATE outbox SET transaction_hash = NULL WHERE id = ? AND lease_token = ?",
        [String(job.id), token],
      );
    await db.run(
      "UPDATE outbox SET status = 'pending', available_at = ?, lease_until = NULL, lease_token = NULL, last_error = ? WHERE id = ? AND lease_token = ?",
      [
        new Date(Date.now() + delay).toISOString(),
        message,
        String(job.id),
        token,
      ],
    );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
