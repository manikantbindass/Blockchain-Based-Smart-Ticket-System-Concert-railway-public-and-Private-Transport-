# Testing

Run `npm ci`, then `npm run check` for type checking, API tests, local-EVM contract tests, and production builds. API tests use an isolated in-memory SQLite database; no development tickets are modified. Contract tests use a fresh in-process Hardhat chain, not the chain on port 8545.

The API suite exercises password/session handling, role escalation, ownership, concurrent inventory contention, idempotency collisions and retries, cancellation, public-response privacy, QR tampering, replay prevention, expired tickets, production configuration, and outbox retry/crash recovery.

Railway coverage adds test-identity challenge ownership, expiry, attempt limits, replacement/replay protection, production gating, generic-checkout bypass rejection, per-journey inventory, seat allocation, idempotent reservations, and passenger cancellation. The railway browser journey exercises search through printable confirmation and wallet cancellation with test data only.

For PostgreSQL verification, set `TEST_DATABASE_URL` to a test database whose user can create and drop schemas, then run `npm test -w @chainpass/api`. Tests create a unique schema and remove only that schema on cleanup. Use a dedicated test database.

## Browser workflows

```bash
npm run build
npx playwright install chromium
npm run test:e2e
```

The runner starts the built app on port 4173 with isolated in-memory data. It checks desktop and mobile browsing, login, booking, QR rendering, verification, organizer admission, replay rejection, registration, cancellation, and listing creation. It also checks for application errors and horizontal page overflow. Failure traces and screenshots are written to ignored `test-results`.

Set `CAPTURE_RAIL_UI=true` when running the railway browser tests to save passenger, identity, confirmation, and print screenshots under `test-results`. `node scripts/capture-rail-ui.mjs` refreshes the documentation's railway search screenshots from the running development server; it respects `PLAYWRIGHT_CHANNEL` and `PREVIEW_URL`.

To use an already installed Chrome browser in PowerShell instead of downloading Chromium:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
npm.cmd run test:e2e
```

CI additionally runs the API invariants against PostgreSQL 17 and builds the Docker image. The dependency audit fails on known high/critical vulnerabilities. These checks are regression coverage, not an independent security audit or proof of a production capacity target.

With a local chain running and `npm run chain:deploy` complete, `node scripts/verify-chain.mjs` exercises booking → transactional outbox → actual mined commitment → wallet receipt using isolated in-memory application data. Run `npm run build` first. It does not alter customer data in the development database.
