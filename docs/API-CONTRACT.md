# API contract

All endpoints below are prefixed with `/api`. JSON errors use `{error: string, message: string}`. Authenticated calls send `Authorization: Bearer <opaque token>`. All money is integer paise (INR). Instants use ISO 8601 UTC strings; railway journey dates use `YYYY-MM-DD` in Asia/Kolkata. Shared response interfaces are in `packages/shared/src/index.ts`.

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

## Railway sandbox

Railway requests are separate from generic event checkout, which rejects all railway categories with `RAIL_FLOW_REQUIRED`. Identity and booking operations require non-production demo mode. All routes use `/api` and the same error envelope and bearer authentication as above.

| Method | Path                          | Request                                                                  | Response                                                              |
| ------ | ----------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| GET    | /rail/options                 | public                                                                   | `RailOptions`: stations, classes, quotas, dates, sandbox availability |
| GET    | /rail/trains                  | `from`, `to`, `date` (YYYY-MM-DD), `quota`, optional `travelClass`       | `{trains: RailTrain[]}` with class fares and availability             |
| GET    | /rail/identity                | bearer                                                                   | `RailIdentity` for the current account                                |
| POST   | /rail/identity/start          | bearer; `{name,dateOfBirth,gender,documentType,identifier,consent:true}` | `RailIdentityChallenge` including an explicitly simulated `demoOtp`   |
| POST   | /rail/identity/verify         | bearer; `{challengeId,otp}`                                              | `RailIdentity`                                                        |
| POST   | /rail/bookings                | bearer, `Idempotency-Key`; `RailBookingRequest`                          | `RailBooking` with passenger tickets, total, and `DEMO-` reference    |
| GET    | /rail/bookings/:reservationId | bearer; reservation must belong to caller                                | Complete `RailBooking` with current passenger ticket statuses         |

`documentType` is `AADHAAR` or `VID`. Only `000000000000` or `0000000000000000`, respectively, is accepted. No actual identity number is supported. OTP expiry is five minutes with five attempts and a 30-second resend cooldown.

`RailBookingRequest` includes `trainId`, `journeyDate`, `travelClass`, `quota`, `boardingStation` (station code), `passengers` (`name`, `age`, `gender`, `berthPreference`), `contactEmail`, `contactMobile`, `paymentMethod`, and `acceptedTerms:true`. Payment methods are `DEMO_UPI`, `DEMO_CARD`, and `DEMO_NETBANKING`. All money remains integer paise. The server derives the price and seat assignment. No caller-supplied fare or identity assertion is trusted.

Wallet tickets include optional `rail` metadata with the reservation, journey, passenger, coach, seat, and sandbox identity mode. Existing cancellation operates per passenger ticket. The receipt retrieves the complete reservation independently of the wallet's display limit. Public verification remains free of identity and passenger information and adds `sandboxRail:true` for railway tickets. See [the railway guide](RAILWAY-BOOKING.md) for simulator limits.
