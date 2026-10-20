# Security

Please report vulnerabilities privately to the repository owner through GitHub's available private reporting channel. Do not post live credentials or exploitable customer data in a public issue.

## Implemented controls

- Salted password hashing and opaque expiring sessions; only session hashes persist server-side.
- Role and resource ownership checks on privileged operations.
- Firebase Admin token verification with revocation checks, provider restrictions, and explicit account linking; public browser config never contains Admin credentials.
- Razorpay capture verification, raw-body webhook signatures, durable checkout idempotency, inventory holds, and duplicate-issuance prevention.
- Input validation and parameterized database queries.
- Transactional conditional inventory and ticket-state updates.
- Signed QR credentials, with online validation and one-time check-in.
- Request identifiers, structured logs, security headers, and request rate limits.
- No PII or admission credential written to the blockchain.
- Local environment files, databases, private keys, and deployment artifacts excluded from version control.
- Railway verification accepts only fixed invalid test identifiers, hashes short-lived OTP challenges, enforces attempt/cooldown limits and account ownership, and records sandbox consent. Railway booking and verification fail closed in production.

## Operational requirements

The lockfile overrides Firebase's transitive `@grpc/grpc-js` to `1.14.6`, which includes the maintainer's fixes for [certificate-context handling](https://github.com/grpc/grpc-node/security/advisories/GHSA-m9gg-hp2v-232j) and [error-message disclosure](https://github.com/grpc/grpc-node/security/advisories/GHSA-f596-whhp-79r4). Keep the audit gate enabled when updating Firebase dependencies.

Use HTTPS, a narrowly configured origin, a high-entropy QR signing secret, encrypted storage/backups, and a least-privilege database role. Secrets belong in a secret manager. Set `NODE_ENV=production`, disable demo seeding, and validate all configuration before opening traffic. Do not expose the local EVM JSON-RPC server publicly.

QR credentials are bearer admission credentials. Anyone who photographs one can attempt to use it; first authorized check-in wins. Protect ticket screens and exports accordingly. The public verifier exposes limited ticket metadata and must not return QR payloads or customer identities.

Rotating the QR secret invalidates existing QR credentials. A production migration should use versioned signing keys and a defined overlap window; this starter does not implement automatic key rotation. Browser sessions use session storage and remain vulnerable to XSS; keep dependencies current and restrict third-party scripts to the configured identity and checkout providers. Firebase tokens are kept in memory during sign-in.

Rate limiting is process-local and applies to API routes; static frontend assets do not consume the API allowance. Multi-replica deployments need a shared edge limiter, including separate protection for static traffic. Smart contracts have automated local-EVM tests but have not received an independent audit. Free sandbox checkout does not process payments. Razorpay refunds require operator handling; paid-ticket self-service cancellation is blocked.

The railway OTP is deliberately displayed by the simulator and is not a real authentication factor. Do not submit real Aadhaar/VID numbers or treat sandbox identity status as verified identity. Passenger names and receipt contact fields are application data; use fictitious values for demonstrations. No Aadhaar, passenger information, or OTP is placed on-chain. Approved provider integrations and reviewed data-retention controls are required before handling real railway reservations or identity verification.
