# Contributing

Use Node 24.x and run `npm ci`. Start the application with `npm run dev`.

Before opening a pull request, run `npm run check` and the browser workflows relevant to the change. Add tests for behavior and security invariants rather than implementation details. Database changes must remain valid for both supported adapters, preserve existing data, and include a migration strategy. Do not edit an already deployed migration in place.

Keep API response types synchronized with `packages/shared` and `docs/API-CONTRACT.md`. Record monetary values as integer minor units and timestamps in UTC. Never move authorization or inventory decisions into the client. Preserve idempotency for retryable mutations.

Never commit `.env`, databases, access tokens, RPC private keys, generated local deployment addresses, or real customer information. Use the demo seed for reproducible local workflows.

Commit messages use Conventional Commits, for example `fix(api): reject reused admission credentials`.
