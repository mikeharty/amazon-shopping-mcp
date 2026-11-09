import { readFile } from "node:fs/promises";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
} from "playwright";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Result } from "../packages/contracts/index.js";
import type { PurchaseTerms } from "../packages/core/purchasing.js";
import type { ModernCheckoutOrigins } from "../packages/providers/amazon-web/checkout/modern-origins.js";
import { submitModernPurchase } from "../packages/providers/amazon-web/checkout/modern-submit.js";
import * as orderControls from "../packages/providers/amazon-web/checkout/modern-order-control.js";
const state = vi.hoisted(() => ({ fresh: undefined as Result | undefined }));
vi.mock("../packages/providers/amazon-web/checkout/modern-purchase.js", () => ({
  loadModernPurchaseQuote: vi.fn(async (page: Page, url: string) => {
    await page.goto(url);
    return state.fresh;
  }),
}));
const review =
  "https://www.amazon.com/checkout/p/p-123-1111111-2222222/spc?pipelineType=Chewbacca&isBuyNow=1";
const money = (minorUnits: number) => ({
  currency: "USD" as const,
  minorUnits,
});
function terms(): PurchaseTerms {
  return {
    schemaVersion: 1,
    flow: "buy_now",
    reviewUrl: review,
    lines: [
      {
        asin: "B0FIXTURE1",
        title: "Fixture cable",
        sellerId: "A1FIXTURE",
        condition: "New",
        purchaseMode: "one_time",
        quantity: 1,
        unitPrice: money(740),
      },
    ],
    subtotal: money(740),
    shipping: money(0),
    tax: money(83),
    discount: money(0),
    total: money(823),
    funding: { giftCardApplied: money(823), additionalAmountDue: money(0) },
    address: {
      ref: "a",
      summary: "Fixture address",
      fingerprint: "a".repeat(64),
    },
    payment: {
      ref: "p",
      summary: "Gift card balance",
      fingerprint: "b".repeat(64),
    },
    shippingGroups: [
      { ref: "g", delivery: "Tuesday", speed: "Free", asins: ["B0FIXTURE1"] },
    ],
    promotions: [],
    warnings: [],
  };
}
const nativeForm =
  '<main id="checkout-experience-container"><section id="checkout-pyo-button-block"><form method="post" action="/checkout/p/p-123-1111111-2222222/spc/place-order?pipelineType=Chewbacca&amp;isBuyNow=1"><input type="hidden" name="anti-csrftoken-a2z" value="PRIVATE_CSRF"><input type="hidden" name="consistencyToken" value="PRIVATE_CONSISTENCY"><input type="hidden" name="hasWorkingJavascript" value="1"><input id="placeOrder" name="placeYourOrder1" type="submit" value="Place your order"></form></section></main>';
const hello =
  '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span>';
const confirmation =
  '<main id="order-confirmation"><h1>Order placed, thanks!</h1><a href="/gp/your-account/order-details?orderID=123-1111111-2222222">Order details</a></main>';
describe("One modern dispatch with independent receipt verification", () => {
  let browser: Browser,
    context: BrowserContext,
    page: Page,
    receiptFixture: string,
    submitted: number,
    scenario: string,
    allowed: boolean,
    approved: PurchaseTerms;
  const proof = () =>
    ({
      authorizesTerms: vi.fn(() => allowed),
      invalidate: vi.fn(),
    }) as unknown as ModernCheckoutOrigins;
  const ctx = () => ({
    ownerId: "fixture-owner",
    accountRef: "fixture-account",
    marketplace: "amazon.com" as const,
    sessionGeneration: 1,
    intentExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const submit = (origins = proof(), execution = ctx()) =>
    submitModernPurchase(page, approved, execution, origins, {
      confirmationTimeoutMs: 150,
      pollIntervalMs: 10,
    });
  beforeAll(async () => {
    browser = await chromium.launch();
    receiptFixture = await readFile(
      new URL("./fixtures/modern-order-details.html", import.meta.url),
      "utf8",
    );
  });
  afterAll(async () => {
    await browser.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({ offline: true });
    page = await context.newPage();
    submitted = 0;
    scenario = "ok";
    allowed = true;
    approved = terms();
    state.fresh = { status: "ok", data: structuredClone(approved) };
    await page.route("**/*", (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      let html = hello;
      if (path.includes("order-history")) {
        html +=
          '<div id="ordersContainer"><div class="order-card" data-order-id="999-1111111-2222222">Prior order</div></div>';
        if (scenario === "wrong_history_context")
          html +=
            '<script>history.replaceState(null,"","/gp/css/homepage.html")</script>';
        if (scenario === "baseline_auth_form")
          html += '<input type="password">';
      } else if (request.method() === "POST") {
        submitted++;
        html =
          scenario === "old_confirmation"
            ? confirmation.replaceAll(
                "123-1111111-2222222",
                "999-1111111-2222222",
              )
            : scenario === "challenge"
              ? '<input type="password">'
              : confirmation;
      } else if (path.includes("order-details")) {
        html += receiptFixture;
        if (scenario !== "missing_funding")
          html = html.replace(
            '<div id="od-subtotals">',
            '<div id="od-subtotals"><div class="od-line-item-row"><div class="od-line-item-row-label">Gift Card:</div><div class="od-line-item-row-content">-$8.23</div></div>',
          );
        if (scenario === "wrong_item")
          html = html.replace("B0FIXTURE1", "B0OTHER001");
      } else
        html +=
          scenario === "ambiguous_control"
            ? nativeForm.replace(
                "</form>",
                '<input id="placeOrder" name="placeYourOrder1" type="submit" value="Place your order"></form>',
              )
            : nativeForm;
      return route.fulfill({ contentType: "text/html", body: html });
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await context.close();
  });
  it("submits once and returns observed and derived verification without copying omitted receipt fields", async () => {
    const origins = proof();
    const result = await submit(origins);
    expect(result).toMatchObject({
      status: "ok",
      data: {
        orderIds: ["123-1111111-2222222"],
        verification: {
          profile: "modern_single_item_funded_order",
          preSubmitOnlyFields: ["condition", "purchaseMode"],
        },
      },
    });
    expect(submitted).toBe(1);
    expect(origins.invalidate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
  });
  it("does not navigate or submit without an authorized origin", async () => {
    allowed = false;
    expect(await submit()).toMatchObject({ status: "unsupported" });
    expect(submitted).toBe(0);
  });
  it("rejects changed funding before any final click", async () => {
    const changed = structuredClone(approved);
    changed.funding = {
      giftCardApplied: money(500),
      additionalAmountDue: money(323),
    };
    state.fresh = { status: "ok", data: changed };
    expect(await submit()).toMatchObject({
      status: "conflict",
      error: { code: "TERMS_CHANGED_OR_UNVERIFIED" },
    });
    expect(submitted).toBe(0);
  });
  it("rejects expired approval and ambiguous final controls without dispatch", async () => {
    expect(
      await submit(proof(), {
        ...ctx(),
        intentExpiresAt: new Date(Date.now() - 1).toISOString(),
      }),
    ).toMatchObject({ status: "conflict", error: { code: "STALE_INTENT" } });
    scenario = "ambiguous_control";
    expect(await submit()).toMatchObject({ status: "unsupported" });
    expect(submitted).toBe(0);
  });
  it("rejects origin revocation at the last check before dispatch", async () => {
    const origins = proof();
    vi.mocked(origins.authorizesTerms)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    expect(await submit(origins)).toMatchObject({
      status: "conflict",
      error: { code: "STALE_INTENT" },
    });
    expect(submitted).toBe(0);
  });
  it.each(["wrong_history_context", "baseline_auth_form"])(
    "does not trust a greeting on an invalid baseline %s",
    async (value) => {
      scenario = value;
      expect(await submit()).toMatchObject({ status: "requires_user_action" });
      expect(submitted).toBe(0);
    },
  );
  it("never retries a click that dispatches and then throws", async () => {
    const original = orderControls.getModernOrderControl;
    vi.spyOn(orderControls, "getModernOrderControl").mockImplementationOnce(
      async (p, url) => {
        const native = await original(p, url);
        if (!native) return undefined;
        return {
          click: async () => {
            await native.click({ timeout: 5000, noWaitAfter: true });
            await p.waitForURL("**/spc/place-order?**");
            await p.waitForLoadState("domcontentloaded");
            throw Error("Synthetic timeout after dispatch");
          },
        } as unknown as Locator;
      },
    );
    const origins = proof();
    expect(await submit(origins)).toMatchObject({
      status: "outcome_unknown",
      error: { retryable: false },
    });
    expect(submitted).toBe(1);
    expect(origins.invalidate).toHaveBeenCalledTimes(1);
  });
  it.each(["old_confirmation", "missing_funding", "wrong_item", "challenge"])(
    "returns nonretryable uncertainty after one dispatch for %s",
    async (value) => {
      scenario = value;
      const origins = proof();
      const result = await submit(origins);
      expect(result).toMatchObject({
        status: "outcome_unknown",
        error: { retryable: false },
      });
      expect(submitted).toBe(1);
      expect(origins.invalidate).toHaveBeenCalledTimes(1);
      if (value === "missing_funding")
        expect(result.data).toMatchObject({
          observedConfirmationOrderId: "123-1111111-2222222",
        });
    },
  );
});
