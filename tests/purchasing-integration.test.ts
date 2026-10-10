import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import pg from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Store } from "../packages/store/index.js";
import { Executor } from "../packages/core/execution.js";
import { AmazonWebProvider } from "../packages/providers/amazon-web/provider.js";
import { extractCheckout } from "../packages/providers/amazon-web/checkout/index.js";
import { createRegistry } from "../apps/gateway/registry.js";
import { createGateway } from "../apps/gateway/transport.js";
import { createOwnerUi } from "../apps/gateway/owner-ui.js";
import { serve } from "../apps/gateway/server.js";
import type { Result } from "../packages/contracts/index.js";

const connection = process.env.TEST_DATABASE_URL;
const owner = "purchasing-integration-owner";
const reviewUrl = "https://www.amazon.com/checkout/p/review";
const greeting = '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span>';
const read = (name: string) => readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8");
describe.skipIf(!connection)("Real MCP, owner approval, Postgres journal and fixture purchase adapter", () => {
  let store: Store, admin: pg.Pool, server: Server, client: Client, browser: Browser, context: BrowserContext, amazonPage: Page;
  let executor: Executor, origin: string, review: string, detail: string, clicks = 0, denyScope = false;
  const db = `purchase_test_${randomUUID().replaceAll("-", "")}`;
  const ownerToken = randomBytes(32).toString("hex");
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: connection }); await admin.query(`CREATE DATABASE ${db}`);
    const dbUrl = new URL(connection!); dbUrl.pathname = `/${db}`;
    store = new Store(dbUrl.toString(), randomBytes(32).toString("base64")); await store.migrate();
    const ownerConfig = { ownerId: owner, ownerToken, origin: "" };
    const registryConfig = { liveEnabled: true, retainObservations: false, origin: "", purchasingEnabled: true };
    const registry = createRegistry(store, registryConfig);
    const gateway = createGateway({ ...registry, authenticate: (r) => r.headers.get("authorization") === "Bearer fixture-token" ? { id: owner, scopes: ["catalog:read", "account:read", "checkout:prepare", ...(denyScope ? [] : ["checkout:commit", "subscriptions:write"])] } : undefined });
    const ownerUi = createOwnerUi(store, ownerConfig);
    server = serve((request) => new URL(request.url).pathname.startsWith("/owner") ? ownerUi(request) : gateway(request), 0);
    await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
    origin = `http://127.0.0.1:${address.port}`; ownerConfig.origin = origin; registryConfig.origin = origin;
    client = new Client({ name: "purchasing-integration", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: { token: async () => "fixture-token" } }));
    browser = await chromium.launch(); context = await browser.newContext(); amazonPage = await context.newPage();
    [review, detail] = await Promise.all([read("purchase-review.html"), read("purchase-order.html")]);
    await context.route("**/*", (route) => {
      const target = new URL(route.request().url());
      if (target.origin !== "https://www.amazon.com") return route.abort("blockedbyclient");
      let body = review;
      if (target.pathname.includes("order-history")) body = `${greeting}<main id="ordersContainer">No orders</main>`;
      else if (target.pathname.includes("order-details")) body = detail;
      else if (target.pathname.includes("viewsubscriptions")) body = `${greeting}<main id="subscriptions-container">No active subscriptions</main>`;
      else if (target.pathname === "/checkout/spc/place-order") { clicks++; body = `${greeting}<main id="order-confirmation">Order 222-3333333-4444444 confirmed</main>`; }
      return route.fulfill({ contentType: "text/html", body });
    });
    executor = new Executor(store, new AmazonWebProvider({ sessionGeneration: 1, run: (fn) => fn(amazonPage), close: async () => {} }), "purchase-fixture-worker", false, false, false, true, origin);
  }, 30_000);
  afterAll(async () => {
    await client?.close(); await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await store?.close(); await admin?.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); await admin?.end();
  });
  beforeEach(async () => {
    [review, detail] = await Promise.all([read("purchase-review.html"), read("purchase-order.html")]);
    clicks = 0; denyScope = false;
    await amazonPage.goto(reviewUrl);
  });
  async function call(name: string, args: Record<string, unknown>) {
    return (await client.callTool({ name, arguments: args })).structuredContent as Result<any>;
  }
  async function prepare(key: string) {
    const account = await store.account(owner);
    await amazonPage.goto(reviewUrl); const expectedRevision = (await extractCheckout(amazonPage)).revision;
    const args = { accountRef: account.id, url: reviewUrl, expectedRevision, idempotencyKey: key };
    const pending = await call("checkout_prepare", args);
    expect(await call("checkout_prepare", args)).toMatchObject({ operationId: pending.operationId });
    await executor.run(pending.operationId!);
    const operation = await store.getOperation(owner, pending.operationId!);
    expect(operation.result?.status).toBe("ok");
    const data = operation.result?.data as { intentId: string; reviewUrl: string };
    expect(data.reviewUrl).toBe(`${origin}/owner/intents/${data.intentId}`);
    return { account, intent: await store.getIntent(owner, data.intentId), operation };
  }
  async function approve(id: string, viewport = { width: 1100, height: 1000 }, colorScheme: "light" | "dark" = "light") {
    const ctx = await browser.newContext({ viewport, colorScheme }); const page = await ctx.newPage();
    await page.goto(`${origin}/owner`); await page.getByLabel("Owner token").fill(ownerToken);
    await page.getByRole("button", { name: "Sign in" }).click(); await page.waitForURL(`${origin}/owner`);
    await page.goto(`${origin}/owner/intents/${id}`);
    expect(await page.locator("body").innerText()).not.toMatch(/Expires \d{4}-\d{2}-\d{2}T/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await mkdir(".local/evidence", { recursive: true });
    await page.screenshot({ path: `.local/evidence/purchase-review-${colorScheme}.png`, fullPage: true });
    await page.getByRole("button", { name: "Approve these exact terms once" }).click();
    await page.getByRole("heading", { name: "Intent approved" }).waitFor(); await ctx.close();
  }
  it("discovers the new tools while the read-only profile retains its original surface", async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ["buy_now_prepare", "checkout_prepare", "checkout_submit", "subscriptions_prepare", "subscriptions_submit", "buying_options_get", "purchase_intent_get"]) expect(tools.some((tool) => tool.name === name)).toBe(true);
    expect(tools.find((tool) => tool.name === "checkout_submit")?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    const readonly = createRegistry(store, { liveEnabled: true, retainObservations: false, origin });
    expect(readonly.tools.some((tool) => tool.name === "checkout_submit")).toBe(false);
    expect(readonly.tools).toHaveLength(38);
  });
  it("prepares via MCP, approves through the actual owner page and executes one purchase across concurrent retries", async () => {
    const { account, intent } = await prepare("integration-preparation");
    const input = { accountRef: account.id, intentId: intent.id, idempotencyKey: "integration-submit" };
    expect(await call("checkout_submit", input)).toMatchObject({ status: "conflict", error: { code: "CONSENT_REQUIRED" } });
    expect(clicks).toBe(0); await approve(intent.id);
    const [first, second] = await Promise.all([call("checkout_submit", input), call("checkout_submit", { ...input, idempotencyKey: "another-submit-key" })]);
    expect(first.operationId).toBe(second.operationId);
    await executor.run(first.operationId!); await executor.run(second.operationId!);
    expect((await store.getOperation(owner, first.operationId!)).result).toMatchObject({ status: "ok", data: { verified: true } });
    expect(clicks).toBe(1);
    expect(await call("purchase_intent_get", { accountRef: account.id, intentId: intent.id })).toMatchObject({ status: "ok", data: { approved: true, consumed: true } });
  }, 20_000);
  it("rejects wrong action, foreign owner, forged approval and insufficient scope", async () => {
    const { account, intent } = await prepare("integration-boundaries");
    const args = { accountRef: account.id, intentId: intent.id, idempotencyKey: "boundary-submit" };
    expect(await call("subscriptions_submit", args)).toMatchObject({ status: "conflict", error: { code: "INTENT_MISMATCH" } });
    const foreign = await store.account("foreign-purchase-owner");
    const foreignIntent = await store.prepare("foreign-purchase-owner", foreign.id, "checkout_submit", intent.terms);
    expect(await call("checkout_submit", { ...args, intentId: foreignIntent.id })).toMatchObject({ status: "failed", error: { code: "NOT_FOUND" } });
    expect((await client.callTool({ name: "checkout_submit", arguments: { ...args, approved: true } })).isError).toBe(true);
    denyScope = true; expect(await call("checkout_submit", args)).toMatchObject({ status: "failed", error: { code: "FORBIDDEN" } }); denyScope = false;
    expect(clicks).toBe(0);
  });
  it("shows recurring terms in dark mobile review and blocks changed frequency without a second purchase", async () => {
    review = (await read("purchase-review.html")).replace('data-purchase-mode="one_time"', 'data-purchase-mode="subscribe_and_save"').replace('value="Place your order"', 'value="Place your order and subscribe"').replace('</main>', '<section id="sns-terms" data-frequency-ref="2" data-creates-immediate-order="true"><p class="frequency">Every 2 months</p><p class="next-delivery">October 15, 2026</p><p class="sns-discount">Save 5%</p><p class="future-price-policy">Prices may change before future deliveries.</p></section></main>');
    // A subscription intent must be supplied by the trusted browser provider.
    const account = await store.account(owner);
    const quote = await (await import("../packages/providers/amazon-web/checkout/purchasing.js")).purchaseQuote(amazonPage, "cart");
    expect(quote.status).toBe("ok");
    await amazonPage.goto(reviewUrl);
    const observed = await (await import("../packages/providers/amazon-web/checkout/purchasing.js")).purchaseQuote(amazonPage, "subscribe_and_save");
    expect(observed.status).toBe("ok");
    const intent = await store.prepare(owner, account.id, "subscriptions_submit", observed.data as Record<string, unknown>);
    await approve(intent.id, { width: 390, height: 844 }, "dark");
    review = review.replace("Every 2 months", "Every month").replace('data-frequency-ref="2"', 'data-frequency-ref="1"');
    const pending = await call("subscriptions_submit", { accountRef: account.id, intentId: intent.id, idempotencyKey: "changed-frequency" });
    await executor.run(pending.operationId!);
    expect((await store.getOperation(owner, pending.operationId!)).result).toMatchObject({ status: "conflict", error: { code: "TERMS_CHANGED_OR_UNVERIFIED" } });
    expect(clicks).toBe(0);
    review = await read("purchase-review.html");
  }, 20_000);
  it("blocks previously approved queued commits when purchasing is disabled and rejects non-commit writes", async () => {
    const { account, intent } = await prepare("integration-disable");
    await store.approve(owner, intent.id, intent.digest);
    const queued = await store.submit(owner, intent.id, "disabled-submit");
    let mutations = 0;
    const fake = { read: async () => ({ status: "ok" as const }), mutate: async () => { mutations++; return { status: "ok" as const }; }, close: async () => {} };
    await new Executor(store, fake, "disabled-purchase-worker").run(queued.id);
    expect((await store.getOperation(owner, queued.id)).result).toMatchObject({ error: { code: "PURCHASING_DISABLED" } });
    const unsafe = await store.start(owner, account.id, "checkout_submit", "write", intent.terms, "unsafe-write");
    await new Executor(store, fake, "unsafe-purchase-worker", false, false, false, true).run(unsafe.id);
    expect((await store.getOperation(owner, unsafe.id)).result).toMatchObject({ error: { code: "OWNER_APPROVED_INTENT_REQUIRED" } });
    expect(mutations).toBe(0);
  });
  it("quarantines an uncertain real adapter result and never repeats the consumed intent", async () => {
    const { account, intent } = await prepare("integration-unknown");
    await store.approve(owner, intent.id, intent.digest);
    detail = detail.replace('data-quantity="1"', 'data-quantity="2"');
    const args = { accountRef: account.id, intentId: intent.id, idempotencyKey: "unknown-submit" };
    const pending = await call("checkout_submit", args); await executor.run(pending.operationId!);
    expect((await store.getOperation(owner, pending.operationId!)).result).toMatchObject({ status: "outcome_unknown", error: { retryable: false } });
    expect((await store.getAccount(owner, account.id)).quarantined).toBe(true);
    expect(await call("checkout_submit", { ...args, idempotencyKey: "never-a-second-purchase" })).toMatchObject({ operationId: pending.operationId });
    await executor.run(pending.operationId!); expect(clicks).toBe(1);
    await expect(store.prepare(owner, account.id, "checkout_submit", intent.terms)).rejects.toMatchObject({ code: "ACCOUNT_QUARANTINED" });
    await expect(store.start(owner, account.id, "cart_add", "write", {}, "no-new-write")).rejects.toMatchObject({ code: "ACCOUNT_QUARANTINED" });
  });
});
