# Firebase authentication and Razorpay payments

The default local app works without provider accounts. Google and phone sign-in become available when Firebase is configured. Catalog checkout switches to Razorpay when its three credentials are present; it cannot fall back to free booking on a provider error. Railway reservations remain free simulations and cannot be sold through Razorpay.

## Firebase setup

1. Create a Firebase project and register a web app. Copy its public `apiKey`, `authDomain`, `projectId`, and `appId` to the corresponding `FIREBASE_*` variables in the root `.env`. The public configuration is returned by `/api/auth/providers`; it is not an Admin credential.
2. Enable Google in Authentication's sign-in providers and set the support email. Add the application's hostname to **Authorized domains**. For local Google testing, add `localhost` and use `http://localhost:5173`.
3. Enable Phone and configure an SMS region policy for the countries you serve. Use an authorized HTTPS hostname for real SMS testing; Firebase's phone-auth guide excludes localhost as a hosted domain. An HTTPS development tunnel must forward to your app and its origin must be included in `WEB_ORIGIN`. Configure fictional phone numbers/codes in Firebase for test accounts. The app keeps reCAPTCHA enabled and never substitutes the railway simulator's OTP.
4. Give the API Firebase Admin credentials for the same project, preferably through Application Default Credentials in your hosting environment. For local development, store the service-account JSON **outside the repository**, set `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path in `.env`, and restrict file access. Do not paste the JSON or private key into a browser variable, commit, or chat.
5. Restart `npm run dev`, open Sign in, and use Google or Phone. For SMS, enter an international-format number (for example, an Indian number starts with `+91`), accept the disclosure, complete reCAPTCHA, and enter the received code.

`FIREBASE_GOOGLE_ENABLED=false` or `FIREBASE_PHONE_ENABLED=false` hides availability for that provider independently. These switches do not replace enabling providers in the Firebase console. Check your project's SMS billing, quota, and region settings before using real numbers.

The browser keeps Firebase credentials in memory and exchanges a Firebase ID token for a ChainPass session. The API verifies signature, project, revocation, provider, and identity claims through the Admin SDK. It grants new users only the customer role. Phone-only accounts have no public email address. Existing accounts are not merged by matching an email address: first sign in to the existing ChainPass account, then explicitly connect the Firebase identity. A recently authenticated provider identity is required for linking.

The railway identity step is separate. Google/phone login authenticates an account; it does not perform Aadhaar verification or establish eligibility for railway travel.

References: [Google sign-in](https://firebase.google.com/docs/auth/web/google-signin), [phone authentication and test numbers](https://firebase.google.com/docs/auth/web/phone-auth), [Admin setup](https://firebase.google.com/docs/admin/setup), [ID-token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens).

## Razorpay test checkout

1. Create or use your Razorpay merchant account and generate **Test Mode** API credentials.
2. Set `RAZORPAY_KEY_ID=rzp_test_...`, `RAZORPAY_KEY_SECRET`, and a separate random `RAZORPAY_WEBHOOK_SECRET` in `.env`. Set all three together. Only the key ID is public.
3. In the Razorpay dashboard, configure automatic capture. An authorized but uncaptured payment does not issue tickets.
4. Add an HTTPS webhook endpoint at `https://your-app.example/api/payments/webhook`, using the same webhook secret. Subscribe to `payment.captured` and `order.paid`. For development, use an HTTPS tunnel to the local app/API. Keep test and live webhook settings separate.
5. Restart the API, sign in, and book a concert, bus, or metro listing. The checkout shows **test mode**. Complete a supported Razorpay test payment in its hosted interface. Available UPI/card options depend on Razorpay account, device, and test-mode support; the app does not collect card details or UPI PINs.
6. Verify the ticket wallet, retry confirmation, and test a closed/interrupted checkout. Test webhook retries and delayed capture before live use. Use provider test instruments from Razorpay's current documentation.

The amount is calculated from the database in integer paise. The server creates an order and reserves inventory for `PAYMENT_HOLD_MINUTES` (default 15). The browser passes only a server-created order to Razorpay. Confirmation checks the signature and fetches the payment; the order ID, amount, currency, and captured status must match. Webhooks verify the original raw request bytes, not reserialized JSON.

An idempotency key identifies one checkout attempt. Reusing it with different contents is rejected. Retrying the same request or webhook cannot issue tickets twice. An interrupted provider-order creation is recovered using its receipt instead of blindly creating another order. The owned order-status endpoint reconciles provider payment state when the browser returns.

Expired holds release inventory. If a payment arrives late, fulfillment reacquires available inventory; when that is impossible, the order becomes `refund_required` and no ticket is issued. This is an operator action, not an automatic refund promise.

References: [Standard Checkout integration](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/), [webhook verification](https://razorpay.com/docs/webhooks/validate-test/).

## Live operation and current limits

The ticket wallet's **Payment activity** section retrieves the latest 20 owned checkouts from the server. Use **Check status** to recover a pending payment even after browser checkout storage is lost. Account linking is available through **Manage sign-in methods** after signing in; it requires the current ChainPass password.

The API runs an expiry sweep every 30 seconds while payments are enabled. It also reconciles batches of up to 20 unresolved orders from the last seven days, with at least a minute between claims. Each replica coordinates its work through the database. These bounded sweeps are a recovery aid: monitor backlog and provider latency, and reconcile older unresolved orders operationally. Webhooks and explicit owned-order checks can process older captures.

For container deployments, public Firebase and Razorpay settings are forwarded by `compose.yaml`. For Firebase Admin, attach workload credentials or mount the service-account file read-only at runtime and set `GOOGLE_APPLICATION_CREDENTIALS` to its path inside the container. Host `.env` paths are not automatically mounted. Keep credentials outside the image and repository.

Live keys require `NODE_ENV=production`, `DEMO_MODE=false`, and `SEED_DEMO=false`. Use a fresh PostgreSQL database, production identity/merchant accounts, HTTPS, real organizer listings, and your own secrets. Seeded demo listings and railway simulations cannot accept live payments. Provider approval, merchant settings, payment-method availability, and business fulfillment remain the operator's responsibility.

The integration does not implement automated refunds, disputes, settlement accounting, taxes/invoices, or a refund dashboard. Paid-ticket cancellation returns an actionable error and leaves the ticket/inventory unchanged. For a paid ticket that must be cancelled, reconcile the payment and ticket with the organizer before issuing a refund in Razorpay; refunding in the provider dashboard alone does not cancel a ChainPass ticket. Do not enable self-service paid cancellations until a coordinated refund workflow is added.

Monitor unresolved orders and `refund_required` cases. Preserve the order/payment identifiers for support; do not log ID tokens, session credentials, OTPs, card details, or webhook secrets. Alert on signature failures and repeated provider errors, and reconcile provider captures against issued tickets. Back up the database and test recovery before commercial operation.

Provider adapters are covered by automated tests with controlled responses. Running those tests does not prove that your Firebase domain, SMS policy, merchant settings, webhook reachability, or live credentials are configured correctly. Complete the provider-account acceptance checks above before launch.
