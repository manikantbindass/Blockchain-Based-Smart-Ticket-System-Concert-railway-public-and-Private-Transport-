# API contract

All endpoints below are prefixed with `/api`. JSON errors use `{error: string, message: string}`. Authenticated calls send `Authorization: Bearer <opaque token>`. All money is integer paise (INR). Dates are ISO 8601 UTC strings. Shared response interfaces are in `packages/shared/src/index.ts`.

| Method | Path                 | Request                                                          | Response                                                                                                          |
| ------ | -------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | /health              |                                                                  | status                                                                                                            |
| GET    | /status              |                                                                  | SystemStatus                                                                                                      |
| GET    | /events              | optional category, q, city                                       | {events: Event[]}                                                                                                 |
| GET    | /events/:id          |                                                                  | {event: Event}                                                                                                    |
| POST   | /auth/register       | {name,email,password}                                            | Session                                                                                                           |
| POST   | /auth/login          | {email,password}                                                 | Session                                                                                                           |
| GET    | /auth/me             | bearer                                                           | {user: User}                                                                                                      |
| POST   | /auth/logout         | bearer                                                           | {ok:true}                                                                                                         |
| POST   | /bookings            | bearer, Idempotency-Key header; {eventId,quantity}               | Booking                                                                                                           |
| GET    | /tickets             | bearer                                                           | {tickets: Ticket[]}                                                                                               |
| POST   | /tickets/:id/cancel  | bearer                                                           | {ticket: Ticket}                                                                                                  |
| GET    | /verify/:code        | public                                                           | {valid:boolean,status:string,eventTitle:string,commitment:string,chainStatus:string,transactionHash:string\|null} |
| GET    | /organizer/dashboard | organizer bearer                                                 | Dashboard                                                                                                         |
| POST   | /organizer/events    | organizer bearer; event fields except id, remaining, organizerId | {event: Event}                                                                                                    |
| POST   | /check-in            | organizer bearer; {qrPayload:string}                             | {ticket: Ticket}                                                                                                  |

Local demo identities: `explorer@chainpass.local` / `Explore123!` and `organizer@chainpass.local` / `Organize123!`. Seed demo only outside production. Seed event IDs stable e.g. `evt-neon-nights`, city Bengaluru. Demo checkout books immediately with no real charge; production booking disabled until explicit deployment configuration permits a sandbox (a real PSP integration is not implemented).

Blockchain: registry anchors a bytes32 SHA-256 commitment per issued ticket. Database stores no fake transaction hashes. API transactional outbox is processed separately; disabled chain reports `disabled`. QR is a signed bearer credential; do not put it on-chain or in public verification results.
