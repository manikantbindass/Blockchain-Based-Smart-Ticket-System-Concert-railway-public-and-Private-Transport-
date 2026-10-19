# Configuration

The API reads the repository-root `.env` on startup. Already-set process environment variables take priority. Never commit this file. The contracts tooling describes its own environment handling in its README.

| Variable             | Local default           | Meaning                                                                  |
| -------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `NODE_ENV`           | development             | `production` activates stricter configuration checks                     |
| `HOST`               | `127.0.0.1`             | Bind address; use `0.0.0.0` inside containers                            |
| `PORT`               | `4000`                  | API and built frontend port                                              |
| `WEB_ORIGIN`         | local dev origins       | Comma-separated exact browser origins allowed by CORS                    |
| `DATABASE_URL`       | unset                   | PostgreSQL connection URL; enables PostgreSQL when set                   |
| `SQLITE_PATH`        | `data/chainpass.sqlite` | SQLite file used when PostgreSQL is unset                                |
| `QR_SECRET`          | development-only value  | At least 32 characters; use a cryptographically random deployment secret |
| `SESSION_TTL_HOURS`  | `168`                   | Session lifetime, between 1 and 720 hours                                |
| `DEMO_MODE`          | true outside production | Explicit sandbox booking switch; false disables checkout                 |
| `SEED_DEMO`          | true outside production | Demo customers, organizer, and catalog; forbidden in production          |
| `WEB_DIST`           | `apps/web/dist`         | Built static frontend directory                                          |
| `BLOCKCHAIN_ENABLED` | false                   | Create chain proof jobs for new bookings                                 |
| `RPC_URL`            | `http://127.0.0.1:8545` | EVM JSON-RPC endpoint                                                    |
| `CHAIN_ID`           | `31337`                 | Expected network identity                                                |
| `CONTRACT_ADDRESS`   | unset                   | Deployed commitment registry                                             |
| `CHAIN_PRIVATE_KEY`  | unset                   | Issuer signer secret; required in production when blockchain is enabled  |

`REGISTRY_ADDRESS` and `ISSUER_PRIVATE_KEY` are accepted aliases for the contract address and signer. Prefer the canonical names above in deployments.

Generate a signing secret locally without placing a literal secret in shell history:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Store the result in `.env` or your secret manager. Changing this secret invalidates existing QR credentials. Development data should not be reused as production data.

For PostgreSQL TLS, use the managed provider's validated connection configuration and trusted CA. Do not disable certificate verification. Budget the connection pool across all replicas.
