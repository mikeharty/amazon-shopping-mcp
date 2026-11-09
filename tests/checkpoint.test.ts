import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyPage } from "../packages/browser-runtime/index.js";
import { PersistentBrowserRuntime } from "../packages/browser-runtime/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
describe("Amazon human checkpoint recognition", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });
  it("rechecks the actual page when an immediate redirect changes the execution context", async () => {
    const context = await browser.newContext({ offline: true });
    try {
      const page = await context.newPage();
      await page.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            new URL(route.request().url()).pathname === "/checkpoint/continue"
              ? '<form id="checkpointForm" action="/checkpoint/validate"><input type="checkbox" name="continueCheck">I am human</form>'
              : '<meta http-equiv="refresh" content="0; url=/checkpoint/continue">',
        }),
      );
      await page.goto("https://www.amazon.com/dp/B0FIXTURE1", {
        waitUntil: "domcontentloaded",
      });
      expect(await classifyPage(page)).toMatchObject({
        kind: "challenge",
        challenge: "robot_check",
      });
    } finally {
      await context.close();
    }
  });
  it("pauses the dedicated runtime at the checkpoint and rejects later automation", async () => {
    const profileDir = await mkdtemp(
      join(tmpdir(), "amazon-checkpoint-fixture-"),
    );
    const runtime = new PersistentBrowserRuntime({
      profileDir,
      headless: true,
    });
    try {
      await runtime.start();
      await runtime.run(async (page) => {
        await page.route("**/*", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<form id="checkpointForm" action="/checkpoint/validate"><input type="checkbox" name="continueCheck">I am human</form>',
          }),
        );
        await page.goto("https://www.amazon.com/checkpoint/continue");
      });
      expect(runtime.isPaused).toBe(true);
      await expect(
        runtime.run(async () => "must not execute"),
      ).rejects.toMatchObject({ code: "handoff_in_progress" });
    } finally {
      await runtime.close();
      await rm(profileDir, { recursive: true, force: true });
    }
  });
  it.each([
    [
      "/checkpoint/continue",
      '<form id="checkpointForm" action="/checkpoint/validate"><input type="checkbox" name="continueCheck">I am human</form>',
      true,
    ],
    ["/checkpoint/validate", "<main>Loading verification</main>", true],
    [
      "/dp/B0FIXTURE1",
      '<form id="checkpointForm" action="/checkpoint/validate"><input type="checkbox" name="continueCheck">I am human</form>',
      true,
    ],
    [
      "/dp/B0FIXTURE1",
      '<form hidden id="checkpointForm" action="/checkpoint/validate"><input type="checkbox" name="continueCheck">I am human</form>',
      false,
    ],
    [
      "/dp/B0FIXTURE1",
      '<form id="checkpointForm" action="https://evil.example/checkpoint/validate"><input type="checkbox" name="continueCheck">I am human</form>',
      false,
    ],
  ] as const)(
    "classifies %s without submitting the checkpoint",
    async (path, html, challenge) => {
      const context = await browser.newContext({ offline: true });
      try {
        const page = await context.newPage();
        let writes = 0;
        await page.route("**/*", (route) => {
          if (route.request().method() !== "GET") writes++;
          return route.fulfill({ contentType: "text/html", body: html });
        });
        await page.goto("https://www.amazon.com" + path);
        const state = await classifyPage(page);
        expect(state.kind).toBe(challenge ? "challenge" : "ready");
        if (challenge)
          expect(state).toMatchObject({ challenge: "robot_check" });
        expect(writes).toBe(0);
        const checkboxes = page.locator('input[name="continueCheck"]');
        if (await checkboxes.count())
          expect(await checkboxes.isChecked()).toBe(false);
      } finally {
        await context.close();
      }
    },
  );
});
