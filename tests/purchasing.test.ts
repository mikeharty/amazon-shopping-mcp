import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { AmazonWebProvider } from "../packages/providers/amazon-web/provider.js";
import { extractCheckout } from "../packages/providers/amazon-web/checkout/index.js";
import { purchaseQuote } from "../packages/providers/amazon-web/checkout/purchasing.js";
import { extractCart } from "../packages/providers/amazon-web/cart/index.js";
import { isReviewUrl, purchaseTermsSchema, type PurchaseTerms } from "../packages/core/purchasing.js";
import type { ProviderContext } from "../packages/contracts/index.js";
import { loadConfig } from "../packages/core/config.js";

const read = (name: string) => readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const url = "https://www.amazon.com/checkout/p/review";
const ctx: ProviderContext = { ownerId: "fixture-owner", accountRef: "fixture-account", marketplace: "amazon.com", sessionGeneration: 1, intentExpiresAt: new Date(Date.now() + 60_000).toISOString() };
const productInput = { asin: "B0FIXTURE1", quantity: 1, expectedSellerId: "A1FIXTURE", expectedCondition: "New" };
const greeting = '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span>';
const subscriptionCard = `${greeting}<main id="subscriptions-container"><div data-subscription-id="new-subscription" data-asin="B0FIXTURE1" data-seller-id="A1FIXTURE" data-quantity="1" data-frequency-ref="2"><h2 class="product-title">Fixture Travel Mug</h2><div class="frequency">Every 2 months</div><div class="next-delivery">October 15, 2026</div></div></main>`;
function sns(html: string, immediate = true) {
  return html.replace('data-purchase-mode="one_time"', 'data-purchase-mode="subscribe_and_save"')
    .replace('value="Place your order"', 'value="Place your order and subscribe"')
    .replace('</main>', `<section id="sns-terms" data-frequency-ref="2" data-creates-immediate-order="${immediate}"><p class="frequency">Every 2 months</p><p class="next-delivery">October 15, 2026</p><p class="sns-discount">Save 5%</p><p class="future-price-policy">Prices may change before future deliveries.</p></section></main>`);
}

describe("Purchasing through offline Amazon browser fixtures", () => {
  let browser: Browser, context: BrowserContext, page: Page, provider: AmazonWebProvider;
  let review: string, product: string, detail: string, history: string, subscriptions: string;
  let clicks: number, enteredReview: number, brokenResponse: boolean, oldConfirmation: boolean, noInitialOrder: boolean;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => {
    [review, product, detail] = await Promise.all([read("purchase-review.html"), read("purchase-product.html"), read("purchase-order.html")]);
    history = `${greeting}<main id="ordersContainer">No orders</main>`;
    subscriptions = `${greeting}<main id="subscriptions-container">No active subscriptions</main>`;
    clicks = 0; enteredReview = 0; brokenResponse = false; oldConfirmation = false; noInitialOrder = false;
    context = await browser.newContext(); page = await context.newPage();
    await context.route("**/*", async (route) => {
      const target = new URL(route.request().url());
      let body = review;
      if (target.pathname.startsWith("/dp/")) body = product;
      else if (target.pathname.includes("order-history")) body = history;
      else if (target.pathname.includes("order-details")) body = detail;
      else if (target.pathname.includes("viewsubscriptions")) body = subscriptions;
      else if (target.pathname.startsWith("/checkout/entry/")) {
        enteredReview++;
        return route.fulfill({ contentType: "text/html", body: `<meta http-equiv="refresh" content="0;url=${url}">` });
      } else if (target.pathname === "/checkout/spc/place-order") {
        clicks++;
        if (brokenResponse) return route.abort("failed");
        const recurring = review.includes("sns-terms");
        if (recurring) subscriptions = subscriptionCard;
        body = `${greeting}<main id="order-confirmation" ${recurring ? 'data-subscription-id="new-subscription"' : ""}>${noInitialOrder ? "Subscription confirmed" : oldConfirmation ? "Order 111-2222222-3333333 confirmed" : "Order 222-3333333-4444444 confirmed"}</main>`;
      }
      return route.fulfill({ contentType: "text/html", body });
    });
    provider = new AmazonWebProvider({ sessionGeneration: 1, run: (fn) => fn(page), close: async () => {} });
  });
  afterEach(async () => { await context?.close(); });
  async function quote() {
    await page.goto(url);
    const result = await purchaseQuote(page, review.includes("sns-terms") ? "subscribe_and_save" : "cart");
    expect(result.status).toBe("ok");
    return purchaseTermsSchema.parse(result.data);
  }
  function omitProductEvidence() {
    product = product.replace('<span id="condition">New</span>', '').replace(/<label data-purchase-mode="[\s\S]*?<\/label>/g, '');
  }
  it("hands off a verified Amazon address step without producing terms or submitting", async () => {
    omitProductEvidence();
    const addressUrl = 'https://www.amazon.com/checkout/p/p-106-9344849-4773810/address';
    await page.route('**/checkout/entry/buynow', (route) => {
      enteredReview++;
      return route.fulfill({ contentType: 'text/html', body: `<meta http-equiv="refresh" content="0;url=${addressUrl}?ref_=checkout">` });
    });
    const result = await provider.read('purchase_buy_now_prepare', productInput, ctx);
    expect(result).toEqual({ status: 'requires_user_action', error: { code: 'checkout_address_selection_required', retryable: false }, action: { kind: 'checkout_address_selection', url: addressUrl } });
    expect(result.data).toBeUndefined(); expect(enteredReview).toBe(1); expect(clicks).toBe(0);
  });
  it("rejects an untrusted address-step destination without offering a handoff", async () => {
    omitProductEvidence();
    await page.route('**/checkout/entry/buynow', (route) => route.fulfill({ contentType: 'text/html', body: '<meta http-equiv="refresh" content="0;url=https://untrusted.example/checkout/p/p-106-9344849-4773810/address">' }));
    const result = await provider.read('purchase_buy_now_prepare', productInput, ctx);
    expect(result).toMatchObject({ status: 'unsupported', error: { code: 'review_page_unavailable' } });
    expect(result.action).toBeUndefined(); expect(result.data).toBeUndefined(); expect(clicks).toBe(0);
  });
  it("prepares a one-time-only page with missing pre-review terms only from complete matching review evidence", async () => {
    omitProductEvidence();
    const options = await provider.read("buying_options_get", { asin: "B0FIXTURE1" }, ctx);
    expect(options).toMatchObject({ data: { modes: [] } });
    expect((options.data as Record<string, unknown>).condition).toBeUndefined();
    expect(await provider.read("purchase_buy_now_prepare", productInput, ctx)).toMatchObject({ status: "ok", data: { purchaseTerms: { lines: [{ asin: "B0FIXTURE1", sellerId: "A1FIXTURE", condition: "New", purchaseMode: "one_time", quantity: 1 }] } } });
    expect(enteredReview).toBe(1); expect(clicks).toBe(0);
  });
  it.each([
    ['condition', 'data-condition="New"', 'data-condition="Used"'],
    ['missing condition', 'data-condition="New"', ''],
    ['mode', 'data-purchase-mode="one_time"', 'data-purchase-mode="subscribe_and_save"'],
    ['missing mode', 'data-purchase-mode="one_time"', ''],
    ['ASIN', 'data-asin="B0FIXTURE1"', 'data-asin="B0WRONG001"'],
    ['seller', 'data-seller-id="A1FIXTURE"', 'data-seller-id="WRONGSELLER"'],
    ['quantity', 'data-quantity="1"', 'data-quantity="2"'],
  ])("rejects incomplete or changed review %s after safe fallback entry", async (_, from, to) => {
    omitProductEvidence(); review = review.replace(from, to);
    const result = await provider.read("purchase_buy_now_prepare", productInput, ctx);
    expect(result.status).not.toBe('ok');
    expect(result.data).toBeUndefined(); expect(enteredReview).toBe(1); expect(clicks).toBe(0);
  });
  it.each([
    ['cart route', 'action="/checkout/entry/buynow"', 'action="/checkout/entry/cart"'],
    ['subscription route', 'action="/checkout/entry/buynow"', 'action="/checkout/entry/sns"'],
    ['instant route', 'action="/checkout/entry/buynow"', 'action="/checkout/spc/place-order"'],
    ['final label', 'value="Buy Now"', 'value="Place your order"'],
    ['inline click', 'id="buy-now-button"', 'id="buy-now-button" onclick="return false"'],
    ['inline submit', 'method="post"', 'method="post" onsubmit="return false"'],
    ['unapproved query', 'action="/checkout/entry/buynow"', 'action="/checkout/entry/buynow?unsafe=1"'],
  ])("rejects fallback %s before entering review", async (_, from, to) => {
    omitProductEvidence(); product = product.replace(from, to);
    expect(await provider.read("purchase_buy_now_prepare", productInput, ctx)).toMatchObject({ status: "unsupported", error: { code: "safe_review_control_unavailable" } });
    expect(enteredReview).toBe(0); expect(clicks).toBe(0);
  });
  it.each(['unselected', 'conflicting', 'ambiguous'])("rejects present %s modes instead of using the empty-mode fallback", async (state) => {
    omitProductEvidence();
    const modes = state === 'unselected' ? '<div data-purchase-mode="one_time">One-time</div>' : state === 'conflicting' ? '<div data-purchase-mode="subscribe_and_save" aria-checked="true">Subscribe</div>' : '<div data-purchase-mode="one_time" aria-checked="true">One-time</div><div data-purchase-mode="subscribe_and_save" aria-checked="true">Subscribe</div>';
    product += modes;
    expect(await provider.read("purchase_buy_now_prepare", productInput, ctx)).toMatchObject({ status: "unsupported", error: { code: "purchase_mode_not_observed" } });
    expect(enteredReview).toBe(0); expect(clicks).toBe(0);
  });
  it("never uses missing-evidence fallback for Used or subscription preparation", async () => {
    omitProductEvidence();
    expect(await provider.read("purchase_buy_now_prepare", { ...productInput, expectedCondition: 'Used' }, ctx)).toMatchObject({ status: 'conflict', error: { code: 'offer_changed' } });
    expect(await provider.read("purchase_subscriptions_prepare", { ...productInput, frequency: '2' }, ctx)).toMatchObject({ status: 'conflict', error: { code: 'offer_changed' } });
    expect(enteredReview).toBe(0); expect(clicks).toBe(0);
  });
  it("still blocks a known condition mismatch or seller mismatch when mode evidence is absent", async () => {
    product = product.replace(/<label data-purchase-mode="[\s\S]*?<\/label>/g, '').replace('<span id="condition">New</span>', '<span id="condition">Used</span>');
    expect(await provider.read("purchase_buy_now_prepare", productInput, ctx)).toMatchObject({ status: 'conflict', error: { code: 'offer_changed' } });
    product = product.replace('<span id="condition">Used</span>', '');
    expect(await provider.read("purchase_buy_now_prepare", { ...productInput, expectedSellerId: 'WRONGSELLER' }, ctx)).toMatchObject({ status: 'conflict', error: { code: 'offer_changed' } });
    expect(enteredReview).toBe(0); expect(clicks).toBe(0);
  });

  it("prepares Buy It Now into review without submitting a purchase", async () => {
    const result = await provider.read("purchase_buy_now_prepare", productInput, ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: { commitKind: "checkout_submit", purchaseTerms: { flow: "buy_now", total: { minorUnits: 2675 } } }, observation: { authentication: "verified" } });
    expect(enteredReview).toBe(1); expect(clicks).toBe(0);
  });
  it("reports safe product layout diagnostics without inferring missing offer terms", async () => {
    product = `${greeting}<input id="ASIN" value="B0FIXTURE1"><h1 id="productTitle">Fixture cable</h1>
      <div id="buybox"><a id="sellerProfileTriggerId" href="https://www.amazon.com/sp?seller=A1FIXTURE">Seller</a>
      <div id="newAccordionRow">New — deliver to Private Person, 123 Secret Street</div>
      <div id="purchase-option"><label id="retail-option"><input id="retail-radio" type="radio" checked>Purchase</label></div>
      <div id="deliveryBlockMessage">Selected delivery location Private Person, 123 Secret Street is beyond our shipping coverage</div>
      <form action="/checkout/entry/buynow?offeringID=SECRET_TOKEN"><input type="hidden" name="offeringID.1" value="SECRET_OFFER"><input type="hidden" name="condition" value="PRIVATE_CONDITION"><input type="hidden" name="csrfToken" value="SECRET_CSRF"><input id="buy-now-button" type="submit" value="Buy Now"></form>
      <a id="aod-ingress-link" href="/gp/product/ajax?aod=1&amp;token=SECRET_AOD">Other sellers</a>
      <a href="/gp/offer-listing/B0FIXTURE1?token=SECRET_LISTING">See buying choices</a>
      <a href="https://example.com/gp/offer-listing/B0FIXTURE1">External offer</a>
      <a style="display:none" href="/gp/offer-listing/HIDDEN">Hidden offer</a></div>`;
    const result = await provider.read("buying_options_get", { asin: "B0FIXTURE1" }, ctx);
    expect(result).toMatchObject({ status: "ok", data: {
      modes: [], diagnostics: {
        purchaseControls: [{ id: "buy-now-button", label: "Buy Now", formPath: "/checkout/entry/buynow" }],
        conditionEvidence: [{ selectorId: "newAccordionRow", text: "New" }],
        availabilityMessages: ["Selected delivery location is beyond shipping coverage"],
        modeContainers: [{ id: "retail-radio", parentId: "retail-option", containerIds: ["purchase-option", "retail-option", "retail-radio"] }],
        offerFieldNames: ["offeringID.1", "condition"],
        offerContainerIds: ["newAccordionRow"],
        offerNavigationControls: [
          { id: "aod-ingress-link", label: "Other sellers", path: "/gp/product/ajax" },
          { label: "See buying choices", path: "/gp/offer-listing/B0FIXTURE1" },
        ],
      },
    } });
    expect((result.data as Record<string, unknown>).condition).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|PRIVATE_CONDITION|csrfToken|Private Person|Secret Street|External offer|Hidden offer/);
    expect(await provider.read("purchase_buy_now_prepare", productInput, ctx)).toMatchObject({ status: "unsupported", error: { code: "quantity_control_unavailable" } });
    expect(enteredReview).toBe(0); expect(clicks).toBe(0);
  });
  it("keeps missing purchase-mode evidence blocking for subscription preparation", async () => {
    product = product.replace(/<label data-purchase-mode="[\s\S]*?<\/label>/g, "");
    expect(await provider.read("purchase_subscriptions_prepare", { ...productInput, frequency: '2' }, ctx)).toMatchObject({ status: "unsupported", error: { code: "purchase_mode_not_observed" } });
    expect(enteredReview).toBe(0); expect(clicks).toBe(0);
  });
  it("uses the visible broad buybox region instead of an earlier hidden template", async () => {
    product = `${greeting}<input id="ASIN" value="B0FIXTURE1">
      <div id="buybox" style="display:none"><div id="condition">Used</div><input type="hidden" name="hiddenTemplateOffering" value="SECRET_TEMPLATE"></div>
      <div id="rightCol"><div id="desktop_buybox">Partial nested buybox</div>
      <div id="conditionCondition">New</div><input type="hidden" name="offeringID.1" value="SECRET_VISIBLE"></div>`;
    const result = await provider.read("buying_options_get", { asin: "B0FIXTURE1" }, ctx);
    expect(result).toMatchObject({ status: "ok", data: { diagnostics: {
      conditionEvidence: [{ selectorId: "conditionCondition", text: "New" }],
      offerFieldNames: ["offeringID.1"], offerContainerIds: ["conditionCondition"],
    } } });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|hiddenTemplateOffering/);
    expect(enteredReview).toBe(0); expect(clicks).toBe(0);
  });
  it("prepares cart checkout from the exact cart revision", async () => {
    const cart = (await read("cart.html")).replace('</body>', '<form method="post" action="/checkout/entry/cart"><input type="submit" name="proceedToRetailCheckout" value="Proceed to checkout"></form></body>');
    await page.route("**/gp/cart/view.html", (route) => route.fulfill({ contentType: "text/html", body: cart }));
    await page.goto("https://www.amazon.com/gp/cart/view.html");
    const revision = (await extractCart(page)).revision;
    expect(await provider.read("purchase_checkout_prepare", { expectedRevision: "stale" }, ctx)).toMatchObject({ status: "conflict", error: { code: "stale_cart" } });
    expect(await provider.read("purchase_checkout_prepare", { expectedRevision: revision }, ctx)).toMatchObject({ status: "ok", data: { purchaseTerms: { flow: "cart" } } });
    expect(clicks).toBe(0);
  });
  it("prepares an existing checkout only at its current revision", async () => {
    await page.goto(url); const expectedRevision = (await extractCheckout(page)).revision;
    expect(await provider.read("purchase_checkout_prepare", { url, expectedRevision }, ctx)).toMatchObject({ status: "ok", data: { purchaseTerms: { address: { summary: expect.stringContaining("123 Example St") }, payment: { summary: "Visa ending in 4242" } } } });
    expect(await provider.read("purchase_checkout_prepare", { url, expectedRevision: "stale" }, ctx)).toMatchObject({ status: "conflict" });
    expect(clicks).toBe(0);
  });
  it("returns observed subscription options and prepares recurring plus immediate-order terms", async () => {
    review = sns(review); detail = detail.replace('data-purchase-mode="one_time"', 'data-purchase-mode="subscribe_and_save"');
    const options = await provider.read("buying_options_get", { asin: "B0FIXTURE1" }, ctx);
    expect(options).toMatchObject({ status: "ok", data: { sellerId: "A1FIXTURE", frequencies: [{ value: "1" }, { value: "2" }] } });
    const result = await provider.read("purchase_subscriptions_prepare", { ...productInput, frequency: "2" }, ctx);
    expect(result).toMatchObject({ status: "ok", data: { commitKind: "subscriptions_submit", purchaseTerms: { recurring: { frequency: "Every 2 months", createsImmediateOrder: true, futurePricePolicy: expect.stringContaining("Prices may change") } } } });
    expect(clicks).toBe(0);
  });
  it.each([
    ["seller", { expectedSellerId: "WRONGSELLER" }], ["condition", { expectedCondition: "Used" }],
  ])("stops Buy It Now on a changed %s before entering checkout", async (_, input) => {
    expect(await provider.read("purchase_buy_now_prepare", { ...productInput, ...input }, ctx)).toMatchObject({ status: "conflict" });
    expect(enteredReview).toBe(0); expect(clicks).toBe(0);
  });
  it("refuses a direct-order Buy Now control and unsupported subscription frequency", async () => {
    product = product.replace('action="/checkout/entry/buynow"', 'action="/checkout/spc/place-order"');
    expect(await provider.read("purchase_buy_now_prepare", productInput, ctx)).toMatchObject({ status: "unsupported", error: { code: "safe_review_control_unavailable" } });
    expect(await provider.read("purchase_subscriptions_prepare", { ...productInput, frequency: "99" }, ctx)).toMatchObject({ status: "unsupported", error: { code: "frequency_unavailable" } });
    expect(clicks).toBe(0);
  });
  it.each([
    ["quantity", (html: string) => html.replace('data-quantity="1"', "")],
    ["seller", (html: string) => html.replace('data-seller-id="A1FIXTURE"', "")],
    ["tax", (html: string) => html.replace('<div id="tax-total">$2.25</div>', "")],
    ["shipping", (html: string) => html.replace('<div id="shipping-total">$0.00</div>', "")],
    ["total", (html: string) => html.replace('$26.75', '$26.76')],
    ["currency", (html: string) => html.replaceAll("$24.50", "CAD$24.50")],
    ["hidden line", (html: string) => html.replace('class="order-summary-line-item"', 'style="display:none" class="order-summary-line-item"')],
    ["delivery", (html: string) => html.replace('class="delivery-date"', 'class="unknown-delivery"')],
  ])("requires observed and reconciled %s evidence before creating executable terms", async (_, change) => {
    review = change(review); await page.goto(url);
    expect(await purchaseQuote(page, "cart")).toMatchObject({ status: "unsupported", error: { code: "purchase_terms_incomplete" } });
    expect(clicks).toBe(0);
  });
  it("never silently turns one-time checkout into a subscription", async () => {
    review = sns(review); await page.goto(url);
    expect(await purchaseQuote(page, "cart")).toMatchObject({ status: "unsupported" });
    review = review.replace('data-creates-immediate-order="true"', ""); await page.goto(url);
    expect(await purchaseQuote(page, "subscribe_and_save")).toMatchObject({ status: "unsupported" });
  });
  it("verifies a confirmed purchase by new order identity and independent order details", async () => {
    const terms = await quote();
    expect(await provider.mutate("checkout_submit", terms, ctx)).toMatchObject({ status: "ok", data: { orderIds: ["222-3333333-4444444"], verified: true } });
    expect(clicks).toBe(1);
  });
  it("extracts checkout identity and totals from visible links and labels without test attributes", async () => {
    review = await read("purchase-review-native.html");
    const terms = await quote();
    expect(terms).toMatchObject({ lines: [{ asin: "B0FIXTURE1", sellerId: "A1FIXTURE", condition: "New", purchaseMode: "one_time", quantity: 1 }], total: { minorUnits: 2675 }, address: { summary: expect.stringContaining("123 Example St") }, payment: { summary: "Visa ending in 4242" } });
    expect(terms.address.ref).toMatch(/^[a-f0-9]{64}$/);
    expect(clicks).toBe(0);
  });
  it("rejects hidden or incomplete recurring terms before enrollment", async () => {
    review = sns(review).replace('class="future-price-policy"', 'style="display:none" class="future-price-policy"');
    await page.goto(url);
    expect(await purchaseQuote(page, "subscribe_and_save")).toMatchObject({ status: "unsupported" });
    expect(clicks).toBe(0);
  });
  it("verifies both subscription enrollment and its initial order", async () => {
    review = sns(review); detail = detail.replace('data-purchase-mode="one_time"', 'data-purchase-mode="subscribe_and_save"');
    const terms = await quote();
    expect(await provider.mutate("subscriptions_submit", terms, ctx)).toMatchObject({ status: "ok", data: { subscriptionRef: "new-subscription", orderIds: ["222-3333333-4444444"] } });
    expect(clicks).toBe(1);
  });
  it("supports enrollment without an immediate order when explicitly observed", async () => {
    review = sns(review, false); noInitialOrder = true;
    expect(await provider.mutate("subscriptions_submit", await quote(), ctx)).toMatchObject({ status: "ok", data: { orderIds: [], subscriptionRef: "new-subscription" } });
  });
  it.each([
    ["address", (html: string) => html.replace("123 Example St", "456 Changed St")],
    ["payment", (html: string) => html.replace("4242", "1234")],
    ["price", (html: string) => html.replaceAll("$24.50", "$25.50").replace("$26.75", "$27.75")],
    ["delivery", (html: string) => html.replace("October 15", "October 16")],
  ])("rechecks %s just before purchase and stops changed terms without dispatch", async (_, change) => {
    const terms = await quote(); review = change(review);
    expect(await provider.mutate("checkout_submit", terms, ctx)).toMatchObject({ status: "conflict", error: { code: "TERMS_CHANGED_OR_UNVERIFIED" } });
    expect(clicks).toBe(0);
  });
  it("checks expiry and action binding without dispatch", async () => {
    const terms = await quote();
    expect(await provider.mutate("checkout_submit", terms, { ...ctx, intentExpiresAt: new Date(0).toISOString() })).toMatchObject({ status: "conflict", error: { code: "STALE_INTENT" } });
    expect(await provider.mutate("subscriptions_submit", terms, ctx)).toMatchObject({ status: "unsupported" });
    expect(clicks).toBe(0);
  });
  it("treats a lost response and wrong postcondition as non-retryable uncertainty", async () => {
    const terms = await quote(); detail = detail.replace('data-quantity="1"', 'data-quantity="2"');
    expect(await provider.mutate("checkout_submit", terms, ctx)).toMatchObject({ status: "outcome_unknown", error: { retryable: false } });
    expect(clicks).toBe(1);
    brokenResponse = true;
    expect(await provider.mutate("checkout_submit", terms, ctx)).toMatchObject({ status: "outcome_unknown" });
    expect(clicks).toBe(2);
  }, 20_000);
  it("does not mistake an old order confirmation for a new purchase", async () => {
    history = `${greeting}<main id="ordersContainer"><div class="order-card" data-order-id="111-2222222-3333333"><a href="/dp/B0FIXTURE1">Fixture Mug</a></div></main>`;
    oldConfirmation = true;
    expect(await provider.mutate("checkout_submit", await quote(), ctx)).toMatchObject({ status: "outcome_unknown" });
    expect(clicks).toBe(1);
  });
  it("refuses to submit when an empty history has no explicit empty-state evidence", async () => {
    const terms = await quote(); history = `${greeting}<main id="ordersContainer"></main>`;
    expect(await provider.mutate("checkout_submit", terms, ctx)).toMatchObject({ status: "unsupported", error: { code: "order_reconciliation_baseline_missing" } });
    expect(clicks).toBe(0);
  });
  it("stops for sign-in before preparing or submitting", async () => {
    review = review.replace(greeting, "");
    expect(await provider.read("purchase_checkout_prepare", { url, expectedRevision: "unused" }, ctx)).toMatchObject({ status: "requires_user_action", error: { code: "challenge_signin" } });
    expect(clicks).toBe(0);
  });
  it("hands payment authentication to the owner before creating a purchase intent", async () => {
    review = review.replace('</main>', '<input autocomplete="cc-csc" name="cvv"></main>');
    expect(await provider.read("purchase_checkout_prepare", { url, expectedRevision: "unused" }, ctx)).toMatchObject({ status: "requires_user_action", error: { code: "challenge_payment" } });
    expect(clicks).toBe(0);
  });
  it("does not accept a non-USD post-purchase total as proof of the approved charge", async () => {
    const terms = await quote(); detail = detail.replace("$26.75", "CAD$26.75");
    expect(await provider.mutate("checkout_submit", terms, ctx)).toMatchObject({ status: "outcome_unknown" });
    expect(clicks).toBe(1);
  });
});

describe("Purchase configuration and allowed review destinations", () => {
  it("requires both explicit purchasing enablement and write access", () => {
    const env = { DATABASE_URL: "fixture", DATA_ENCRYPTION_KEY: "fixture", MCP_TOKEN: "m".repeat(32), OWNER_TOKEN: "o".repeat(32) };
    expect(loadConfig(env).purchasingEnabled).toBe(false);
    expect(loadConfig({ ...env, AMAZON_PURCHASING_ENABLED: "true" }).purchasingEnabled).toBe(false);
    expect(loadConfig({ ...env, AMAZON_PURCHASING_ENABLED: "true", AMAZON_READ_ONLY: "false" }).purchasingEnabled).toBe(true);
  });
  it.each(["https://evil.example/checkout/p/review", "https://user:secret@www.amazon.com/checkout/p/review", "https://www.amazon.com/checkout/p/review?action=submit", "https://www.amazon.com/checkout/p/spc/submit", "https://www.amazon.com/checkout/p/review#place-order"])("rejects unsafe destination %s", (value) => { expect(isReviewUrl(value)).toBe(false); });
});
