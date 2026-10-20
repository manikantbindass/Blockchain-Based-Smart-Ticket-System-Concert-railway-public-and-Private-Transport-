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
| `DEMO_MODE`          | true outside production | Enables free sandbox booking when Razorpay is disabled                  |
| `SEED_DEMO`          | true outside production | Demo customers, organizer, and catalog; forbidden in production          |
| `WEB_DIST`           | `apps/web/dist`         | Built static frontend directory                                          |
| `BLOCKCHAIN_ENABLED` | false                   | Create chain proof jobs for new bookings                                 |
| `RPC_URL`            | `http://127.0.0.1:8545` | EVM JSON-RPC endpoint                                                    |
| `CHAIN_ID`           | `31337`                 | Expected network identity                                                |
| `CONTRACT_ADDRESS`   | unset                   | Deployed commitment registry                                             |
| `CHAIN_PRIVATE_KEY`  | unset                   | Issuer signer secret; required in production when blockchain is enabled  |
| `FIREBASE_PROJECT_ID` | unset                  | Firebase project identity shared by web and Admin SDK                    |
| `FIREBASE_API_KEY` | unset                     | Public Firebase web app API key                                         |
| `FIREBASE_AUTH_DOMAIN` | unset                 | Firebase auth hostname, without scheme/path                              |
| `FIREBASE_APP_ID` | unset                      | Public Firebase web app ID                                              |
| `FIREBASE_MESSAGING_SENDER_ID` | unset         | Optional public Firebase configuration                                  |
| `FIREBASE_STORAGE_BUCKET` | unset             | Optional public Firebase configuration                                  |
| `FIREBASE_GOOGLE_ENABLED` | true              | Allow Google when Firebase configuration is complete                     |
| `FIREBASE_PHONE_ENABLED` | true               | Allow phone when Firebase configuration is complete                      |
| `GOOGLE_APPLICATION_CREDENTIALS` | unset      | External service-account file for Admin SDK; alternatively use workload ADC |
| `RAZORPAY_KEY_ID` | unset                      | Public checkout key; `rzp_test_...` or `rzp_live_...`                      |
| `RAZORPAY_KEY_SECRET` | unset                  | Server-only Razorpay API and callback-signature secret                    |
| `RAZORPAY_WEBHOOK_SECRET` | unset              | Separate server-only webhook-signature secret                             |
| `PAYMENT_HOLD_MINUTES` | 15                    | Inventory hold duration, integer 1–30 minutes                             |

`REGISTRY_ADDRESS` and `ISSUER_PRIVATE_KEY` are accepted aliases for the contract address and signer. Prefer the canonical names above in deployments.

Generate a signing secret locally without placing a literal secret in shell history:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Store the result in `.env` or your secret manager. Changing this secret invalidates existing QR credentials. Development data should not be reused as production data.

For PostgreSQL TLS, use the managed provider's validated connection configuration and trusted CA. Do not disable certificate verification. Budget the connection pool across all replicas.

Firebase's four required public fields and Razorpay's three credentials must each be supplied together. Partial configuration fails startup. Firebase Auth emulator configuration is forbidden in production. Razorpay live keys require production with both demo switches off. Keep Firebase service-account JSON outside the repository and container image; mount it at runtime or use workload credentials. See [provider setup](AUTH-AND-PAYMENTS.md).
