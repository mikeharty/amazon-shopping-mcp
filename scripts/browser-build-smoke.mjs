import { searchOrders, researchProducts } from "../dist/packages/core/shopping-workflows.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAmazonWebProvider } from "../dist/packages/providers/amazon-web/index.js";
import { assistAmazonPasswordLogin } from "../dist/packages/browser-runtime/password-login.js";

// Exercise the JavaScript actually used by worker/login commands. Transpiler
// helpers captured in page.evaluate callbacks can pass Vitest yet fail in Chrome.
const root = await mkdtemp(join(tmpdir(), "amazon-built-browser-"));
const { runtime, provider } = createAmazonWebProvider({
  profileDir: join(root, "profile"), headless: true,
});
try {
  await runtime.start();
  let html = "";
  await runtime.run(async (page) => {
    // Every request is fulfilled locally; this check never accesses Amazon.
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  });
  for (const [kind, fixture, collection] of [
    ["cart_get", "cart.html", "lines"],
    ["orders_list", "orders.html", "orders"],
    ["subscriptions_list", "subscriptions.html", "subscriptions"],
    ["cart_get", "cart-saved.html", "lines"],
    ["subscriptions_list", "subscriptions-modern.html", "subscriptions"],
    ["orders_list", "orders-modern.html", "orders"],
  ]) {
    html = await readFile(new URL(`../tests/fixtures/${fixture}`, import.meta.url), "utf8");
    const result = await provider.read(kind, {}, {
      ownerId: "fixture-owner", accountRef: "fixture-account",
      marketplace: "amazon.com", sessionGeneration: runtime.sessionGeneration,
    });
    assert.ok(["ok", "partial"].includes(result.status), `${kind} failed in the compiled runtime`);
    assert.equal(result.observation?.authentication, "verified");
    assert.equal(result.data.recognized, true);
    assert.ok(result.data[collection].length > 0, `${kind} missed its synthetic fixture`);
  }
  const details = await readFile(new URL("../tests/fixtures/order-details-modern.html", import.meta.url), "utf8");
  const tracker = await readFile(new URL("../tests/fixtures/tracking-modern.html", import.meta.url), "utf8");
  await runtime.run(async (page) => {
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body:
      new URL(route.request().url()).pathname === "/progress-tracker/package" ? tracker : details }));
  });
  for (const kind of ["orders_get", "shipments_get"]) {
    const result = await provider.read(kind, { orderId: "111-2222222-3333333" }, {
      ownerId: "fixture-owner", accountRef: "fixture-account", marketplace: "amazon.com", sessionGeneration: runtime.sessionGeneration,
    });
    assert.ok(["ok", "partial"].includes(result.status));
    assert.equal(result.observation?.authentication, "verified");
    assert.equal(result.data.orderId, "111-2222222-3333333");
    assert.equal(result.data.shipments.length, 2);
    if (kind === "shipments_get") assert.equal(result.data.shipments[0].tracking.status, "Shipped");
  }
  const productHtml = await readFile(new URL("../tests/fixtures/product.html", import.meta.url), "utf8");
  const historyHtml = await readFile(new URL("../tests/fixtures/orders-modern.html", import.meta.url), "utf8");
  await runtime.run(async (page) => {
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      const body = url.pathname.includes("order-history") ? historyHtml :
        url.pathname.includes("B0FIXTURE2") ? productHtml.replaceAll("B0FIXTURE1", "B0FIXTURE2").replace("$24.50", "$34.50") : productHtml;
      return route.fulfill({ contentType: "text/html", body });
    });
  });
  const context = { ownerId: "fixture-owner", accountRef: "fixture-account", marketplace: "amazon.com", sessionGeneration: runtime.sessionGeneration };
  const researched = await researchProducts(provider, { asins: ["B0FIXTURE1", "B0FIXTURE2"], desiredFeatures: ["BPA free"] }, context);
  assert.equal(researched.data.items.length, 2);
  assert.equal(researched.data.recommendedAsin, "B0FIXTURE1");
  assert.ok(researched.data.items[0].media.length > 0);
  const searched = await searchOrders(provider, { query: "mug", maxPages: 1 }, context);
  assert.equal(searched.data.orders.length, 1);
  assert.equal(searched.data.nextPage, 2);
  const purchaseReview = await readFile(new URL("../tests/fixtures/purchase-review.html", import.meta.url), "utf8");
  const purchaseProduct = await readFile(new URL("../tests/fixtures/purchase-product.html", import.meta.url), "utf8");
  const purchaseOrder = await readFile(new URL("../tests/fixtures/purchase-order.html", import.meta.url), "utf8");
  let transactionReview = purchaseReview;
  let purchaseDispatches = 0;
  await runtime.run(async (page) => {
    await page.route("**/*", (route) => {
      const path = new URL(route.request().url()).pathname;
      let body = transactionReview;
      if (path.startsWith("/dp/")) body = purchaseProduct;
      else if (path.startsWith("/checkout/entry/")) body = '<meta http-equiv="refresh" content="0;url=https://www.amazon.com/checkout/p/review">';
      else if (path.includes("order-history")) body = '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span><main id="ordersContainer">No orders</main>';
      else if (path.includes("order-details")) body = purchaseOrder;
      else if (path === "/checkout/spc/place-order") { purchaseDispatches++; body = '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span><main id="order-confirmation">Order 222-3333333-4444444 confirmed</main>'; }
      return route.fulfill({ contentType: "text/html", body });
    });
  });
  const purchaseContext = { ...context, intentExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  const selected = { asin: "B0FIXTURE1", quantity: 1, expectedSellerId: "A1FIXTURE", expectedCondition: "New" };
  const buyNow = await provider.read("purchase_buy_now_prepare", selected, purchaseContext);
  assert.equal(buyNow.status, "ok"); assert.equal(purchaseDispatches, 0);
  const placed = await provider.mutate("checkout_submit", buyNow.data.purchaseTerms, purchaseContext);
  assert.equal(placed.status, "ok"); assert.equal(placed.data.verified, true); assert.equal(purchaseDispatches, 1);
  transactionReview = purchaseReview.replace('data-purchase-mode="one_time"', 'data-purchase-mode="subscribe_and_save"').replace('value="Place your order"', 'value="Place your order and subscribe"').replace('</main>', '<section id="sns-terms" data-frequency-ref="2" data-creates-immediate-order="true"><p class="frequency">Every 2 months</p><p class="next-delivery">October 15, 2026</p><p class="sns-discount">Save 5%</p><p class="future-price-policy">Prices may change before future deliveries.</p></section></main>');
  const subscribe = await provider.read("purchase_subscriptions_prepare", { ...selected, frequency: "2" }, purchaseContext);
  assert.equal(subscribe.status, "ok"); assert.equal(subscribe.data.purchaseTerms.recurring.createsImmediateOrder, true); assert.equal(purchaseDispatches, 1);
  await runtime.run(async (page) => {
    let submissions = 0;
    await page.route("**/*", (route) => {
      const request = route.request();
      const isPassword = request.postData()?.includes("password=");
      if (isPassword) submissions++;
      const claim = new URL(request.url()).pathname === "/ax/claim";
      return route.fulfill({ contentType: "text/html", body: isPassword
        ? '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span>'
        : `<form method="post" action="${claim ? "/ap/signin" : "/ax/claim"}">${claim
          ? '<input id="ap_password" name="password" type="password"><span id="signInSubmit"><input type="submit"></span>'
          : '<input id="ap_email_login" name="email"><span id="continue"><input type="submit"></span>'}</form>` });
    });
    await page.goto("https://www.amazon.com/ap/signin");
    const credentials = { username: "fixture@example.com", password: "synthetic-password-only" };
    assert.equal(await assistAmazonPasswordLogin(page, async () => credentials), "submitted");
    assert.equal(submissions, 1);
    assert.deepEqual(credentials, { username: "", password: "" });
  });
  console.log("Compiled Chromium fixtures: 8 account reads, 1 password flow, 2 shopping workflows and 3 purchase flows passed.");
} finally {
  await runtime.close();
  await rm(root, { recursive: true, force: true });
}
