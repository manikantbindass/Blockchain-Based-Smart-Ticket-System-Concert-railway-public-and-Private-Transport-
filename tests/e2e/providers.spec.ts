import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import type { Event, PaymentOrder, Session, Ticket } from "@chainpass/shared";

const session: Session = {
  token: "browser-provider-session",
  user: {
    id: "browser-provider-user",
    name: "Payment Explorer",
    email: "provider@example.com",
    role: "customer",
  },
};

// Hosted provider responses are deliberately mocked here. The API tests exercise
// signature validation, capture checks, inventory, and webhook processing.
async function paymentFixture(
  page: Page,
  request: APIRequestContext,
  behavior: "confirm" | "dismiss" | "throw",
) {
  const response = await request.get("/api/events/evt-neon-nights");
  expect(response.ok()).toBeTruthy();
  const event = (await response.json()).event as Event;
  const ticket: Ticket = {
    id: "browser-paid-ticket",
    eventId: event.id,
    event,
    userId: session.user.id,
    code: "CP-PROVIDER-BROWSER",
    status: "valid",
    createdAt: new Date().toISOString(),
    pricePaid: event.price,
    qrPayload: "browser-only-qr",
    commitment: "browser-only-commitment",
    chainStatus: "disabled",
    transactionHash: null,
    payment: { orderId: "checkout-browser", mode: "test" },
  };
  const order: PaymentOrder = {
    id: "checkout-browser",
    providerOrderId: "order_browser",
    keyId: "rzp_test_browser",
    amount: event.price,
    currency: "INR",
    status: "pending",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    mode: "test",
  };
  const calls = {
    creates: 0,
    reads: 0,
    confirms: 0,
    freeBookings: 0,
    wallets: 0,
    keys: [] as string[],
  };
  await page.addInitScript(
    (value) =>
      sessionStorage.setItem("chainpass.session", JSON.stringify(value)),
    session,
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { user: session.user } }),
  );
  await page.route("**/api/events", (route) =>
    route.fulfill({ json: { events: [event] } }),
  );
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        mode: "demo",
        database: "sqlite",
        blockchain: "disabled",
        chainId: null,
      },
    }),
  );
  await page.route("**/api/payments/config", (route) =>
    route.fulfill({
      json: { enabled: true, mode: "test", keyId: order.keyId },
    }),
  );
  await page.route("**/api/bookings", (route) => {
    calls.freeBookings++;
    return route.fulfill({
      status: 500,
      json: {
        error: "UNEXPECTED_FREE_BOOKING",
        message: "Paid checkout must not use demo booking.",
      },
    });
  });
  await page.route("**/api/payments/orders", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { orders: [] } });
    calls.creates++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      eventId: event.id,
      quantity: 1,
    });
    expect(route.request().headers().authorization).toBe(
      `Bearer ${session.token}`,
    );
    calls.keys.push(route.request().headers()["idempotency-key"]);
    return route.fulfill({ status: 201, json: order });
  });
  await page.route(`**/api/payments/orders/${order.id}`, (route) => {
    calls.reads++;
    return route.fulfill({ json: order });
  });
  await page.route(`**/api/payments/orders/${order.id}/confirm`, (route) => {
    calls.confirms++;
    expect(route.request().postDataJSON()).toEqual({
      razorpay_order_id: order.providerOrderId,
      razorpay_payment_id: "pay_browser",
      razorpay_signature: "browser-test-signature",
    });
    if (calls.confirms > 1) {
      order.status = "paid";
      order.booking = { tickets: [ticket], total: ticket.pricePaid };
    }
    return route.fulfill({ json: order });
  });
  await page.route("**/api/tickets", (route) => {
    calls.wallets++;
    return route.fulfill({
      json: { tickets: order.status === "paid" ? [ticket] : [] },
    });
  });
  await page.route("https://checkout.razorpay.com/v1/checkout.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
      window.__checkoutBehavior = ${JSON.stringify(behavior)};
      window.__checkoutOrders = [];
      window.Razorpay = class {
        constructor(options) { this.options = options; }
        close() {}
        on() {}
        open() {
          window.__checkoutOrders.push(this.options.order_id);
          if (window.__checkoutBehavior === "throw") throw new Error("Checkout window unavailable");
          if (window.__checkoutBehavior === "dismiss") return this.options.modal.ondismiss();
          this.options.handler({
            razorpay_order_id: this.options.order_id,
            razorpay_payment_id: "pay_browser",
            razorpay_signature: "browser-test-signature"
          });
        }
      };
    `,
    }),
  );
  await page.goto("/#explore");
  await page.getByRole("button", { name: /Neon Nights.*from/ }).click();
  await expect(
    page.getByText("Secure Razorpay checkout", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Test mode", { exact: true })).toBeVisible();
  return { calls, order, ticket };
}

test("unconfigured Google and phone options explain availability while email sign-in works", async ({
  page,
}) => {
  await page.goto("/#explore");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Continue with Google" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Continue with mobile" }),
  ).toBeDisabled();
  await expect(
    dialog.getByText(
      /Google and mobile sign-in will be available after Firebase is configured/,
    ),
  ).toBeVisible();
  await dialog.getByLabel("Email address").fill("explorer@chainpass.local");
  await dialog.getByLabel("Password", { exact: true }).fill("Explore123!");
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
});

test("hosted checkout waits for server capture and retries the same order without free booking", async ({
  page,
  request,
}) => {
  const { calls, order, ticket } = await paymentFixture(
    page,
    request,
    "confirm",
  );
  await page.getByRole("button", { name: "Pay with UPI or card" }).click();
  await expect(
    page.getByText(/Payment is not confirmed yet. No ticket has been issued/),
  ).toBeVisible();
  await expect(page).toHaveURL(/#explore$/);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  expect(calls.wallets).toBe(0);
  expect(calls.confirms).toBe(1);
  expect(calls.freeBookings).toBe(0);

  await page.getByRole("button", { name: "Resume secure checkout" }).click();
  await expect(page).toHaveURL(/#tickets$/);
  await expect(
    page.locator(".wallet-card").filter({ hasText: ticket.code }),
  ).toBeVisible();
  expect(calls.creates).toBe(1);
  expect(calls.reads).toBe(1);
  expect(calls.confirms).toBe(2);
  expect(calls.keys[0]).toMatch(/^[a-f0-9-]{36}$/);
  expect(calls.freeBookings).toBe(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __checkoutOrders: string[] }).__checkoutOrders,
    ),
  ).toEqual([order.providerOrderId, order.providerOrderId]);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem(
        "chainpass.payment.browser-provider-user.evt-neon-nights",
      ),
    ),
  ).toBeNull();
});

test("closing checkout and reloading preserves the pending order for recovery", async ({
  page,
  request,
}) => {
  const { calls, order } = await paymentFixture(page, request, "dismiss");
  await page.getByRole("button", { name: "Pay with UPI or card" }).click();
  await expect(
    page.getByText(/Payment is not confirmed yet. No ticket has been issued/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resume secure checkout" }),
  ).toBeEnabled();
  await page.reload();
  await page.getByRole("button", { name: /Neon Nights.*from/ }).click();
  await expect(
    page.getByText(/A previous checkout is waiting for confirmation/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check payment status" }).click();
  await expect(
    page.getByText(`Order: ${order.id}`, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Resume secure checkout" }).click();
  await expect(
    page.getByRole("button", { name: "Resume secure checkout" }),
  ).toBeEnabled();
  expect(calls.creates).toBe(1);
  expect(calls.reads).toBe(4);
  expect(calls.confirms).toBe(0);
  expect(calls.freeBookings).toBe(0);
  expect(calls.wallets).toBe(0);
  await expect(page).toHaveURL(/#explore$/);
});

test("wallet payment history recovers a capture after checkout storage is lost", async ({
  page,
  request,
}) => {
  const { order, ticket } = await paymentFixture(page, request, "dismiss");
  await page.route("**/api/payments/orders", async (route) => {
    if (route.request().method() === "GET")
      await route.fulfill({ json: { orders: [order] } });
    else await route.fallback();
  });
  await page.getByRole("button", { name: "Pay with UPI or card" }).click();
  await expect(
    page.getByRole("button", { name: "Resume secure checkout" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.evaluate(() =>
    sessionStorage.removeItem(
      "chainpass.payment.browser-provider-user.evt-neon-nights",
    ),
  );
  await page.goto("/#tickets");
  const history = page.getByRole("region", { name: "Payment activity" });
  await expect(
    history.getByText("Awaiting confirmation", { exact: true }),
  ).toBeVisible();
  order.status = "paid";
  order.booking = { tickets: [ticket], total: order.amount };
  await history
    .getByRole("button", { name: `Check payment status for order ${order.id}` })
    .click();
  await expect(
    history.getByText("Tickets issued", { exact: true }),
  ).toBeVisible();
  const card = page.locator(".wallet-card").filter({ hasText: ticket.code });
  await expect(card).toBeVisible();
  await card.click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("Razorpay test payment", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel ticket", exact: true }),
  ).toHaveCount(0);
});

test("a hosted checkout opening failure leaves the saved order retryable", async ({
  page,
  request,
}) => {
  const { calls } = await paymentFixture(page, request, "throw");
  await page.getByRole("button", { name: "Pay with UPI or card" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Checkout window unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Resume secure checkout" }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as { __checkoutBehavior: string }).__checkoutBehavior =
      "dismiss";
  });
  await page.getByRole("button", { name: "Resume secure checkout" }).click();
  await expect(
    page.getByText(/Payment is not confirmed yet. No ticket has been issued/),
  ).toBeVisible();
  expect(calls.creates).toBe(1);
  expect(calls.freeBookings).toBe(0);
  expect(calls.wallets).toBe(0);
});
