import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";

async function captureRailScreen(page: Page, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  if (process.env.CAPTURE_RAIL_UI === "true") {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: test.info().outputPath(`${name}.png`),
      fullPage: true,
    });
  }
}

async function railAccount(page: Page, request: APIRequestContext) {
  const response = await request.post("/api/auth/register", {
    data: {
      name: "Rail Explorer",
      email: `rail-${crypto.randomUUID()}@example.com`,
      password: "RailExplorer123!",
    },
  });
  expect(response.status()).toBe(201);
  const session = await response.json();
  await page.addInitScript(
    (value) =>
      sessionStorage.setItem("chainpass.session", JSON.stringify(value)),
    session,
  );
  return session;
}

test("rail search, passengers, test identity, payment, receipt and partial cancellation", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await railAccount(page, request);
  await page.goto("/#rail");
  await page
    .getByRole("button", { name: "Search trains", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Book CC on Vande Bharat Express",
      exact: true,
    })
    .first()
    .click();
  await page
    .getByLabel("Passenger 1 full name", { exact: true })
    .fill("Sample Explorer");
  await page.getByLabel("Passenger 1 age", { exact: true }).fill("29");
  await page
    .getByLabel("Passenger 1 gender", { exact: true })
    .selectOption("F");
  await page
    .getByLabel("Passenger 1 berth preference", { exact: true })
    .selectOption("WINDOW");
  await page
    .getByRole("button", { name: "Add passenger", exact: true })
    .click();
  await page
    .getByLabel("Passenger 2 full name", { exact: true })
    .fill("Sample Companion");
  await page.getByLabel("Passenger 2 age", { exact: true }).fill("31");
  await page
    .getByLabel("Passenger 2 gender", { exact: true })
    .selectOption("M");
  await page
    .getByLabel("Contact email", { exact: true })
    .fill("rail-demo@example.com");
  await page.getByLabel("Contact mobile", { exact: true }).fill("9000000000");
  await captureRailScreen(page, "passengers");
  await page
    .getByRole("button", { name: "Continue to verification", exact: true })
    .click();
  await page
    .getByLabel("Account holder name", { exact: true })
    .fill("Sample Explorer");
  await page
    .getByLabel("Account date of birth", { exact: true })
    .fill("1997-05-14");
  await page.getByLabel("Account gender", { exact: true }).selectOption("F");
  await expect(
    page.getByLabel("Test identifier", { exact: true }),
  ).toHaveAttribute("readonly", "");
  await expect(page.getByLabel("Test identifier", { exact: true })).toHaveValue(
    "000000000000",
  );
  await page
    .getByRole("checkbox", {
      name: /I consent to sandbox account verification/,
    })
    .check();
  const challengeResponse = page.waitForResponse("**/api/rail/identity/start");
  await page
    .getByRole("button", { name: "Generate test OTP", exact: true })
    .click();
  const challenge = await (await challengeResponse).json();
  await captureRailScreen(page, "identity");
  await page
    .getByLabel("Sandbox OTP", { exact: true })
    .fill(challenge.demoOtp === "000000" ? "111111" : "000000");
  await page
    .getByRole("button", { name: "Verify test OTP", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("incorrect");
  await page.getByLabel("Sandbox OTP", { exact: true }).fill(challenge.demoOtp);
  await page
    .getByRole("button", { name: "Verify test OTP", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue to payment", exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: /I understand this is a sandbox reservation/,
    })
    .check();
  const bookingResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/rail/bookings") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Confirm sandbox booking", exact: true })
    .click();
  const response = await bookingResponse;
  expect(response.status()).toBe(201);
  const booking = await response.json();
  expect(booking.tickets).toHaveLength(2);
  expect(booking.paymentMode).toBe("sandbox");
  expect(booking.pnr).toMatch(/^DEMO-/);
  expect(
    new Set(
      booking.tickets.map(
        (ticket: any) => `${ticket.rail.coach}/${ticket.rail.seat}`,
      ),
    ).size,
  ).toBe(2);
  await expect(page.locator(".rail-receipt")).toContainText(booking.pnr);
  await expect(page.locator(".rail-receipt")).toContainText("Sample Companion");
  await captureRailScreen(page, "confirmation");
  await expect(page.locator(".rail-receipt")).toContainText(
    /not valid for travel/i,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);

  await page.goto("/#tickets");
  await page
    .locator(".wallet-card")
    .filter({ hasText: booking.tickets[0].code })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Not valid for travel");
  await page
    .getByRole("button", { name: "Cancel ticket", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Yes, cancel ticket", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Cancelled", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View reservation slip", exact: true })
    .click();
  await expect(page.locator(".rail-receipt")).toContainText("Sample Companion");
  await expect(page.locator(".rail-receipt")).toContainText(/cancelled/i);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".rail-receipt")).toBeVisible();
  if (process.env.CAPTURE_RAIL_UI === "true")
    await page.screenshot({
      path: test.info().outputPath("printed-slip.png"),
      fullPage: true,
    });
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const stillValid = await request.get(
    `/api/verify/${booking.tickets[1].code}`,
  );
  expect((await stillValid.json()).valid).toBe(true);
  await page.goto(`/#verify/${booking.tickets[1].code}`);
  await page
    .getByRole("button", { name: "Verify ticket", exact: true })
    .last()
    .click();
  await expect(
    page.getByText("Valid sandbox reservation", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("railway cards preserve routes and unsupported routes show empty results", async ({
  page,
}) => {
  await page.goto("/#explore");
  await page
    .getByRole("button", { name: /Western Coast Express.*search demo trains/ })
    .click();
  await expect(page.getByLabel("From station", { exact: true })).toHaveValue(
    "CSMT",
  );
  await expect(page.getByLabel("To station", { exact: true })).toHaveValue(
    "MAO",
  );
  await page
    .getByRole("button", { name: "Search trains", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Book SL on Western Coast Express",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("From station", { exact: true }).selectOption("SBC");
  await page.getByLabel("To station", { exact: true }).selectOption("AGC");
  await page
    .getByRole("button", { name: "Search trains", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /^Book / })).toHaveCount(0);
  await expect(page.getByText(/no .*trains/i)).toBeVisible();
});
