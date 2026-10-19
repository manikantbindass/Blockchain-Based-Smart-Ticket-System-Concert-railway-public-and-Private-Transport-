import type { Session } from "@chainpass/shared";

const SESSION_KEY = "chainpass.session";

export function readSession(): Session | null {
  try {
    const saved: unknown = JSON.parse(
      sessionStorage.getItem(SESSION_KEY) || "null",
    );
    if (
      saved &&
      typeof saved === "object" &&
      "token" in saved &&
      typeof saved.token === "string" &&
      "user" in saved
    )
      return saved as Session;
  } catch {
    /* A disabled or invalid storage entry starts a signed-out session. */
  }
  return null;
}

export function saveSession(session: Session | null) {
  try {
    session
      ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
      : sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* The in-memory session remains usable if storage is unavailable. */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey)
    headers["Idempotency-Key"] = options.idempotencyKey;
  const response = await fetch(`/api${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
  const result = (await response.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
  };
  if (!response.ok)
    throw new ApiError(
      result.message || "Something went wrong. Please try again.",
      response.status,
      result.error || "request_failed",
    );
  return result as T;
}

export function errorMessage(error: unknown) {
  if (error instanceof TypeError)
    return "Unable to reach ChainPass. Check your connection and try again.";
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
