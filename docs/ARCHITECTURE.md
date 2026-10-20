# Architecture and consistency

ChainPass is a modular monorepo. A thin React client communicates with a Fastify service. The service owns authentication, authorization, inventory, bookings, and admission. PostgreSQL is the shared source of truth for deployed systems; SQLite is the zero-configuration local adapter. A separately scheduled worker anchors issuance commitments on an EVM registry.

## Boundaries

The browser never decides price, remaining capacity, ownership, organizer privileges, payment completion, or ticket validity. All are enforced by the API. Monetary values are integer paise. API responses use UTC ISO timestamps; presentation uses localized dates and Indian rupees.

Sessions are opaque bearer tokens with server-side expiry and revocation. The database stores token hashes. The browser persists its token in session storage for the current tab, so XSS remains a session theft risk: avoid untrusted scripts and maintain a restrictive Content Security Policy in deployment. No public registration can create an organizer. Demo organizer seeding is disabled in production.

## Booking transaction

1. Authenticate the customer and validate event and quantity.
2. Associate the idempotency key with the caller and request fingerprint.
3. Conditionally decrement inventory only if enough capacity is available and the event is bookable.
4. Insert tickets and blockchain outbox jobs in the same transaction.
5. Commit before returning issued tickets.

Concurrent requests cannot spend the same remaining inventory. A repeated key with the same request resolves to the same booking; a different request with that key is rejected. A database rollback leaves no partial booking or orphaned proof job. Client retries must preserve their key.

Cancellation conditionally transitions an owned valid ticket and restores inventory once. Check-in conditionally consumes a valid ticket once, after verifying both the signed credential and organizer ownership. Competing cancellations and admissions serialize on the same durable state; only one transition succeeds.

## Provider boundaries

Firebase verifies Google and phone sign-in. The API verifies Firebase ID tokens through the Admin SDK before mapping a UID to a local user and issuing its own opaque session. Explicit account linking requires reauthentication; an email match does not merge accounts. Firebase phone authentication is unrelated to the railway test identity.

Razorpay checkout reserves inventory before contacting the provider. External requests are outside database transactions; a durable local order and receipt allow retry recovery. A capture can be received by a signed webhook, browser confirmation followed by provider verification, or reconciliation. Fulfillment serializes on the order, inserts tickets and outbox jobs once, and consumes the reservation in the same transaction.

Expired holds release capacity. A late capture reacquires inventory if available; otherwise it produces a durable `refund_required` state and no ticket. Paid tickets cannot use the free cancellation path. Automated refunds are not implemented. See [provider setup and operational limits](AUTH-AND-PAYMENTS.md).

## Railway domain

Railway booking uses a separate API flow with account identity simulation, a fixed timetable, and inventory partitioned by train, journey date, class, and quota. The selected journey is represented by an internal event so ticket signing, ownership, cancellation, and the outbox keep the same infrastructure. One reservation groups individual passenger tickets. Seat allocation is durable and occurs in the booking transaction; a class selection in the browser does not reserve inventory.

The railway schema is introduced by an additive versioned migration. Existing tickets and local accounts remain intact. A cancellation removes the active seat allocation while retaining the original passenger ticket and reservation metadata for the receipt. A later reservation may reuse the released seat; the cancelled QR remains invalid.

Identity challenges belong to the account and store a hash of the simulated OTP, its deadline, attempts, and consent version. Account verification never implies that all passengers were authenticated. These endpoints are explicitly unavailable in production. A real provider integration must replace the simulator's trust boundary and fulfill the operational requirements in the [railway guide](RAILWAY-BOOKING.md).

## Blockchain boundary

The chain stores only opaque 32-byte commitments and issuance metadata. The QR credential and customer identity never leave the application boundary. A receipt is evidence of issuance, not evidence of current admission eligibility. Cancellation and used status are deliberately checked online against the database.

The outbox separates user latency from chain latency. A worker can retry after a crash; already anchored commitments are recognized rather than duplicated. Pending and disabled states are visible, and no fake transaction hash is returned. Retry exhaustion and RPC outages require operator visibility and intervention. Never advertise finality without considering the target network's reorganization and confirmation policy.

## Scaling path

| Component     | Initial deployment              | Growth path                                                           |
| ------------- | ------------------------------- | --------------------------------------------------------------------- |
| Frontend      | API static serving              | CDN with immutable hashed assets                                      |
| API           | One stateless container         | Replicas behind TLS ingress                                           |
| Database      | PostgreSQL primary              | Managed HA, pool limits, backups; read replicas for noncritical reads |
| Rate limiting | Per-process guard               | Shared gateway/Redis limiter before multiple replicas                 |
| Chain worker  | One signer/worker               | Partitioned jobs and explicit nonce coordination                      |
| Search        | Indexed catalog filtering       | Dedicated search only when measured needs justify it                  |
| Monitoring    | Structured request logs, health | Metrics, tracing, SLO alerts, dashboards                              |

Correctness-critical inventory and admission reads must go to the primary. A stale read replica must not authorize a booking or check-in. Each API replica's database pool consumes database capacity: cap pools and scale replicas within the database connection budget.

Do not run multiple uncoordinated workers sharing an EVM signer. Database job leasing is not an EVM nonce coordinator. A managed signer queue or explicit nonce reservation is needed for that topology.

## Product work before paid production

- Validate Firebase/Razorpay configuration in the target accounts, establish refund/dispute and settlement operations, and exercise recovery under provider outages. Do not issue paid tickets based on browser success callbacks.
- Add verified email delivery, password reset, account recovery, MFA for operators, and an authenticated organizer onboarding process.
- Complete independent API and contract security review, dependency review, accessibility testing, and workload-specific load tests.
- Define the real transport operator integration. Seeded rail/bus/metro listings are demo inventory, not live carrier inventory.
- Establish data retention, deletion, support, accessibility, privacy, and regional commerce policies.

These are deployment requirements beyond the implemented authentication and payment adapters.

## Current operational bounds

Catalog responses return up to 100 listings; personal wallets and organizer listing tables return up to 200 records, with recent organizer activity limited to 12 tickets. The frontend filters the loaded catalog. Add cursor pagination and server-driven discovery before operating a catalog beyond these bounds. Summary ticket/revenue and active-event counts query the full organizer dataset. These limits keep initial responses bounded; they are not a substitute for large-catalog pagination.

The worker retries with exponential backoff capped at five minutes. A confirmed reverted transaction is cleared for a new submission; an unconfirmed transaction retains its hash for reconciliation. Monitor long-lived pending jobs and reconcile dropped or replaced transactions operationally. Confirmation currently waits for one block; a public-network rollout needs configurable finality and reorganization handling.
