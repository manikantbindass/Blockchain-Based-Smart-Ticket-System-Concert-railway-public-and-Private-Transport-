import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";

test("static assets do not consume the API budget while API and login limits remain enforced", async () => {
  const webDist = await mkdtemp(join(tmpdir(), "chainpass-rate-test-"));
  const index = join(webDist, "index.html");
  const asset = join(webDist, "asset.js");
  await writeFile(index, "<!doctype html><title>Rate limit fixture</title>");
  await writeFile(asset, "export const fixture = true;");
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    app = await buildApp({
      logger: false,
      config: {
        production: true,
        demoMode: false,
        seedDemo: false,
        databaseUrl: undefined,
        sqlitePath: ":memory:",
        blockchainEnabled: false,
        webDist,
        qrSecret:
          "isolated-rate-limit-test-secret-at-least-thirty-two-characters",
      },
    });
    for (let i = 0; i < 200; i++) {
      const response = await app.inject({
        url: i % 2 ? "/asset.js" : "/",
        remoteAddress: "192.0.2.10",
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    for (let i = 0; i < 180; i++) {
      const response = await app.inject({
        url: "/api/status",
        remoteAddress: "192.0.2.10",
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.equal(
      (
        await app.inject({
          url: "/api/status?asset=style.css",
          remoteAddress: "192.0.2.10",
        })
      ).statusCode,
      429,
    );
    for (let i = 0; i < 15; i++) {
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/login",
            remoteAddress: "192.0.2.11",
            payload: {},
          })
        ).statusCode,
        400,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: "192.0.2.11",
          payload: {},
        })
      ).statusCode,
      429,
    );
  } finally {
    await app?.close();
    await unlink(asset);
    await unlink(index);
    await rmdir(webDist);
  }
});
