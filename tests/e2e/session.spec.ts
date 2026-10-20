import { test, expect } from "@playwright/test";

test("late session restoration cannot sign a user back in after sign-out", async ({
  page,
  request,
}) => {
  const registration = await request.post("/api/auth/register", {
    data: {
      name: "Session Explorer",
      email: `session-${crypto.randomUUID()}@example.com`,
      password: "SessionTest123!",
    },
  });
  expect(registration.ok()).toBeTruthy();
  const session = await registration.json();
  await page.addInitScript(
    (value) =>
      sessionStorage.setItem("chainpass.session", JSON.stringify(value)),
    session,
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/me", async (route) => {
    await gate;
    await route.fulfill({ json: { user: session.user } });
  });
  await page.goto("/#rail");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  const restored = page.waitForResponse("**/api/auth/me");
  release();
  await restored;
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("chainpass.session")),
  ).toBeNull();
});
