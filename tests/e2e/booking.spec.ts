import { test, expect } from "@playwright/test";

test("browse, book, verify, check in once, and reject replay", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /Neon Nights.*from/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Railways", exact: true }).click();
  await expect(page).toHaveURL(/#rail$/);
  await expect(
    page.getByRole("button", { name: "Search trains", exact: true }),
  ).toBeVisible();
  await page.goto("/#explore");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Demo explorer", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /Neon Nights.*from/ }).click();
  await expect(page.getByText("Demo checkout", { exact: true })).toBeVisible();
  const booked = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/bookings") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Confirm booking", exact: true })
    .click();
  const response = await booked;
  expect(response.status()).toBe(201);
  const ticket = (await response.json()).tickets[0];
  await expect(
    page.locator(".wallet-card").filter({ hasText: ticket.code }),
  ).toBeVisible();
  await page.locator(".wallet-card").filter({ hasText: ticket.code }).click();
  await expect(
    page.getByRole("dialog").locator('img[src^="data:image/png"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();

  await page.goto(`/#verify/${ticket.code}`);
  await page.getByLabel("Ticket verification code").fill(ticket.code);
  await page
    .getByRole("button", { name: "Verify ticket", exact: true })
    .last()
    .click();
  await expect(
    page.getByText("This ticket is valid", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Demo organizer", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto("/#organizer");
  await page
    .getByRole("button", { name: "Open check-in", exact: true })
    .click();
  await page.getByLabel("Signed QR payload").fill(ticket.qrPayload);
  await page
    .getByRole("button", { name: "Confirm check-in", exact: true })
    .click();
  await expect(
    page.getByText("This ticket is now marked as used."),
  ).toBeVisible();
  await page.getByLabel("Signed QR payload").fill(ticket.qrPayload);
  await page
    .getByRole("button", { name: "Confirm check-in", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("already been used");
  const verification = await request.get(`/api/verify/${ticket.code}`);
  expect((await verification.json()).status).toBe("used");
  expect(errors).toEqual([]);
});

test("registration and cancellation restore inventory without collecting payment", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await page.getByLabel("Full name").fill("Browser Explorer");
  await page
    .getByLabel("Email address")
    .fill(`browser-${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password").fill("BrowserTest123!");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const before = (
    await (await request.get("/api/events/evt-neon-nights")).json()
  ).event.remaining;
  await page.getByRole("button", { name: /Neon Nights.*from/ }).click();
  const booked = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/bookings") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Confirm booking", exact: true })
    .click();
  const ticket = (await (await booked).json()).tickets[0];
  await page.locator(".wallet-card").filter({ hasText: ticket.code }).click();
  await page
    .getByRole("button", { name: "Cancel ticket", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Yes, cancel ticket", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Cancelled", { exact: true }),
  ).toBeVisible();
  const after = (
    await (await request.get("/api/events/evt-neon-nights")).json()
  ).event.remaining;
  expect(after).toBe(before);
  expect(
    (await (await request.get(`/api/verify/${ticket.code}`)).json()).valid,
  ).toBe(false);
});

test("organizer publishes a listing and mobile layout stays inside the viewport", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Demo organizer", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto("/#organizer");
  await page
    .getByRole("button", { name: "Create experience", exact: true })
    .click();
  const title = `Browser Live ${Date.now()}`;
  await page.getByLabel("Experience title").fill(title);
  await page
    .getByLabel("Short description")
    .fill("A fully tested ticketed experience");
  await page.getByLabel("City", { exact: true }).fill("Bengaluru");
  await page.getByLabel("Venue / departure point").fill("Live Studio");
  const start = new Date(Date.now() + 172_800_000).toISOString().slice(0, 16);
  const end = new Date(Date.now() + 180_000_000).toISOString().slice(0, 16);
  await page.getByLabel("Starts at").fill(start);
  await page.getByLabel("Ends at").fill(end);
  await page.getByLabel("Price per ticket").fill("999");
  await page.getByLabel("Capacity", { exact: true }).fill("50");
  await page
    .getByLabel("About this experience")
    .fill("Live music, good company, and a reliable ticketing experience.");
  await page
    .getByRole("button", { name: "Publish experience", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("table").getByText(title, { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});
