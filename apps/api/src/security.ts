import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [algorithm, salt, hash] = stored.split(":");
  if (algorithm !== "scrypt" || !salt || !hash) return false;
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export const newToken = () => randomBytes(32).toString("base64url");
export function commitment(ticketId: string, eventId: string): string {
  // Versioned canonical tuple and independent entropy prevent guessing identities.
  return `0x${sha256(JSON.stringify(["chainpass-ticket-v1", ticketId, eventId, randomBytes(32).toString("hex")]))}`;
}
export function signQr(ticketId: string, code: string, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, ticketId, code }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}
export function verifyQr(
  value: string,
  secret: string,
): { ticketId: string; code: string } | null {
  try {
    const parts = value.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const expected = createHmac("sha256", secret).update(parts[0]).digest();
    const actual = Buffer.from(parts[1], "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return null;
    const decoded = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    if (
      decoded.v !== 1 ||
      typeof decoded.ticketId !== "string" ||
      typeof decoded.code !== "string"
    )
      return null;
    return { ticketId: decoded.ticketId, code: decoded.code };
  } catch {
    return null;
  }
}
