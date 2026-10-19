import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const repositoryRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
);
const envPath = resolve(repositoryRoot, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

export interface Config {
  production: boolean;
  demoMode: boolean;
  seedDemo: boolean;
  databaseUrl?: string;
  sqlitePath: string;
  qrSecret: string;
  webOrigins: string[];
  port: number;
  host: string;
  sessionTtlHours: number;
  blockchainEnabled: boolean;
  chainId: number;
  rpcUrl: string;
  registryAddress: string;
  issuerPrivateKey: string;
  webDist: string;
}
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const production = process.env.NODE_ENV === "production";
  const config: Config = {
    production,
    demoMode:
      process.env.DEMO_MODE === undefined
        ? !production
        : process.env.DEMO_MODE === "true",
    seedDemo:
      process.env.SEED_DEMO === undefined
        ? !production
        : process.env.SEED_DEMO === "true",
    databaseUrl: process.env.DATABASE_URL || undefined,
    sqlitePath:
      process.env.SQLITE_PATH ||
      resolve(repositoryRoot, "data/chainpass.sqlite"),
    qrSecret:
      process.env.QR_SECRET ||
      (production
        ? ""
        : "development-only-change-this-secret-before-deployment-2026"),
    webOrigins: (
      process.env.WEB_ORIGIN ||
      "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4000"
    )
      .split(",")
      .map((x) => x.trim()),
    port: Number(process.env.PORT || 4000),
    host: process.env.HOST || "127.0.0.1",
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 168),
    blockchainEnabled: process.env.BLOCKCHAIN_ENABLED === "true",
    chainId: Number(process.env.CHAIN_ID || 31337),
    rpcUrl: process.env.RPC_URL || "http://127.0.0.1:8545",
    registryAddress:
      process.env.CONTRACT_ADDRESS || process.env.REGISTRY_ADDRESS || "",
    issuerPrivateKey:
      process.env.CHAIN_PRIVATE_KEY || process.env.ISSUER_PRIVATE_KEY || "",
    webDist: process.env.WEB_DIST || resolve(repositoryRoot, "apps/web/dist"),
    ...overrides,
  };
  if (config.qrSecret.length < 32)
    throw new Error("QR_SECRET must be at least 32 characters.");
  if (config.production && config.qrSecret.startsWith("development-only"))
    throw new Error("Production requires a unique QR_SECRET.");
  if (config.production && config.seedDemo)
    throw new Error(
      "Demo identities must never be seeded in production. Set SEED_DEMO=false.",
    );
  if (
    config.blockchainEnabled &&
    (!/^0x[0-9a-fA-F]{40}$/.test(config.registryAddress) ||
      ((config.production || config.issuerPrivateKey) &&
        !/^0x[0-9a-fA-F]{64}$/.test(config.issuerPrivateKey)))
  ) {
    throw new Error(
      "Blockchain requires CONTRACT_ADDRESS and, in production, CHAIN_PRIVATE_KEY.",
    );
  }
  if (
    config.blockchainEnabled &&
    !config.issuerPrivateKey &&
    config.chainId !== 31337
  )
    throw new Error(
      "An unlocked signer is only permitted on the local development chain.",
    );
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error("Invalid PORT.");
  if (
    !Number.isFinite(config.sessionTtlHours) ||
    config.sessionTtlHours < 1 ||
    config.sessionTtlHours > 720
  )
    throw new Error("SESSION_TTL_HOURS must be between 1 and 720.");
  return config;
}
