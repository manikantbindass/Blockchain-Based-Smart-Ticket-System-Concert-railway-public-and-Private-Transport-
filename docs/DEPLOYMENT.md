# Deployment and operations

## Local container stack

Start Docker Engine / Docker Desktop first, then:

```bash
docker compose up --build -d
docker compose logs -f app
```

Open http://127.0.0.1:4000. This stack deliberately runs a sandbox with PostgreSQL and demo identities. Database storage persists in the `postgres-data` volume. `docker compose down` stops containers without deleting data. Do not remove the volume unless intentionally resetting all data.

## Production container

The Dockerfile builds TypeScript, frontend assets, and the contract artifact in a separate build stage, removes development dependencies, and runs the service as the unprivileged `node` user. Static assets and API share an origin.

Supply `POSTGRES_PASSWORD`, `DATABASE_URL`, `QR_SECRET`, and `WEB_ORIGIN` through deployment secrets/configuration, then use:

```bash
docker compose -f compose.yaml -f compose.production.yaml up --build -d
```

The production override disables demo identities and checkout. A real payment integration must be completed before commercial ticket sales. To run an explicitly labelled private production sandbox, override `DEMO_MODE=true` deliberately; never represent that mode as paid processing.

Use a fresh production database. Production refuses demo seeding, but it cannot erase demo identities already present in a reused database. Provision an organizer with `npm run organizer:create`: supply `ORGANIZER_NAME`, `ORGANIZER_EMAIL`, and `ORGANIZER_PASSWORD` (at least 12 characters) through your secret manager or local ignored environment file. The command does not print the password. In the production container, invoke `node apps/api/dist/create-organizer.js` with the same environment. Public registration always creates customers.

Expose the loopback application port only through a TLS reverse proxy. Configure strict origin, body-size and request-time limits, distributed rate limiting, and log retention. Do not expose the database port or EVM development RPC publicly. Do not blindly trust forwarded headers from arbitrary clients.

## Health, data, and recovery

- `/api/health` reports liveness; `/api/ready` verifies database connectivity. Use readiness for routing traffic and deployment health checks.
- Take encrypted database backups, test restores into a separate environment, and use point-in-time recovery for deployed PostgreSQL.
- Apply schema changes with a controlled rollout and preserve a compatible previous application version for rollback.
- Monitor error rates, request latency, database connections/locks, capacity conflicts, authentication failures, pending proof jobs, worker failures, chain RPC errors, and signer balance.
- Keep a single anchoring worker per signer until nonce coordination is implemented. Restarting the worker must be safe because commitments are idempotent.
- Use separate issuer and administrator identities on public chains; do not run the service with governance privileges.

## Capacity validation

Establish representative traffic first: catalog reads, booking contention for the same event, QR check-in bursts, and intermittent chain failure. Measure p50/p95/p99 latency and error rates with realistic database size. Assert `issued + remaining = capacity` after competing bookings and cancellations. Introduce API and worker restarts during workloads and verify idempotent recovery.

Avoid throughput promises until these experiments pass on the target infrastructure. Test database restore and application rollback before a live event, not during it.
