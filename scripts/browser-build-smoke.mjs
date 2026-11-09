import { searchOrders, researchProducts } from "../dist/packages/core/shopping-workflows.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAmazonWebProvider } from "../dist/packages/providers/amazon-web/index.js";
import { assistAmazonPasswordLogin } from "../dist/packages/browser-runtime/password-login.js";
import { extractModernReviewFacts } from '../dist/packages/providers/amazon-web/checkout/modern-review-facts.js';
import { getModernOrderControl } from '../dist/packages/providers/amazon-web/checkout/modern-order-control.js';
import { readModernOrderDetails, deriveModernReceiptQuantity } from '../dist/packages/providers/amazon-web/checkout/modern-order-details.js';
import { modernReceiptAmounts } from '../dist/packages/providers/amazon-web/checkout/modern-receipt-verification.js';
import { readModernConfirmation } from '../dist/packages/providers/amazon-web/checkout/modern-confirmation.js';

// Exercise the JavaScript actually used by worker/login commands. Transpiler
// helpers captured in page.evaluate callbacks can pass Vitest yet fail in Chrome.
const root = await mkdtemp(join(tmpdir(), "amazon-built-browser-"));
const { runtime, provider } = createAmazonWebProvider({
  profileDir: join(root, "profile"), headless: true,
});
try {
  await runtime.start();
  let html = "";
  let addressSelectionSmoke = false;
  const modernAddress = await readFile(new URL('../tests/fixtures/checkout-addresses-modern.html', import.meta.url), 'utf8');
  const appliedShipping = await readFile(new URL('../tests/fixtures/checkout-shipping-applied.html', import.meta.url), 'utf8');
  await runtime.run(async (page) => {
    // Every request is fulfilled locally; this check never accesses Amazon.
    await page.route("**/*", (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = addressSelectionSmoke ? path.includes('order-history') ? '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span>' : path.endsWith('/review') ? appliedShipping : modernAddress : html;
      return route.fulfill({ contentType: "text/html", body });
    });
  });
  html = await readFile(new URL('../tests/fixtures/checkout-addresses.html', import.meta.url), 'utf8');
  const addressRead = await provider.read('checkout_addresses_get', { url: 'https://www.amazon.com/checkout/p/p-123-1111111-2222222/address' }, {
    ownerId: 'fixture-owner', accountRef: 'fixture-account', marketplace: 'amazon.com', sessionGeneration: runtime.sessionGeneration,
  });
  assert.equal(addressRead.status, 'ok', 'Address read must run in compiled Chromium');
  assert.equal(addressRead.data.addresses.length, 1);
  assert.equal(addressRead.data.addresses[0].selected, true);
  assert.doesNotMatch(JSON.stringify(addressRead), /fixture-private|fixture-secret/);
  addressSelectionSmoke = true;
  const addressContext = { ownerId: 'fixture-owner', accountRef: 'fixture-account', marketplace: 'amazon.com', sessionGeneration: runtime.sessionGeneration };
  const addressUrl = 'https://www.amazon.com/checkout/p/p-123-1111111-2222222/address?isBuyNow=1&pipelineType=Chewbacca';
  const modernSnapshot = await provider.read('checkout_addresses_get', { url: addressUrl }, addressContext);
  assert.equal(modernSnapshot.status, 'ok');
  const targetAddress = modernSnapshot.data.addresses[0];
  const selectedAddress = await provider.mutate('checkout_address_select', { url: addressUrl, expectedRevision: modernSnapshot.data.revision, expectedContextFingerprint: modernSnapshot.data.contextFingerprint, expectedSessionGeneration: runtime.sessionGeneration, addressRef: targetAddress.addressRef, expectedFingerprint: targetAddress.fingerprint }, addressContext);
  assert.equal(selectedAddress.status, 'ok', 'Compiled address selection must independently verify applied shipping');
  assert.equal(selectedAddress.data.verification, 'saved_address_id_and_physical_destination');
  assert.equal(selectedAddress.data.orderSubmitted, false);
  const reconciledAddress = await provider.read('checkout_addresses_get', { url: addressUrl, reconcileCurrent: true }, addressContext);
  assert.equal(reconciledAddress.status, 'ok');
  addressSelectionSmoke = false;
  html = '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span>' + await readFile(new URL('../tests/fixtures/checkout-review-modern-diagnostics.html', import.meta.url), 'utf8');
  html = html.replace('id="checkout-item-block-0"', 'id="checkout-item-block-0" data-asin="B0FIXTURE1" data-condition="New" data-purchase-mode="one_time" data-line-item-id="SECRET_LINE"')
    .replace('</article>', '<select name="quantity"><option selected value="2">2</option></select><script type="application/json">{"condition":"SECRET_STATE","quantity":2,"csrfToken":"SECRET_TOKEN"}</script></article>')
    .replace('</article>', '<div data-pipeline-link-args=\'{"asin":"B0FIXTURE1","condition":"New","purchaseMode":"one_time","selectedOfferId":"SECRET_SELECTED_OFFER"}\'>Product control</div><div data-a-component="stepper" data-steppervalue="2" aria-label="Quantity">2</div></article>')
    .replace('<div>Order total: $26.40</div>', '<div>Total: $26.40</div><div>Gift Card: -$26.40</div><div>Order total: $0.00</div>');
  const modernReviewDiagnostic = await provider.read('checkout_get', { url: 'https://www.amazon.com/checkout/p/p-123-1111111-2222222/spc?isBuyNow=1&pipelineType=Chewbacca&hasWorkingJavascript=1' }, addressContext);
  assert.equal(modernReviewDiagnostic.status, 'partial', 'Modern review read never emits executable terms');
  assert.equal(modernReviewDiagnostic.data.diagnosticOnly, true);
  assert.equal(modernReviewDiagnostic.data.executableTerms, false);
  assert.equal(modernReviewDiagnostic.data.sections.items[0].links[0].asin, 'B0FIXTURE1');
  assert.equal(modernReviewDiagnostic.data.sections.payment.lastFour, '4242');
  assert.equal(modernReviewDiagnostic.data.sections.items[0].publicIdentity[0].asin, 'B0FIXTURE1');
  assert.equal(modernReviewDiagnostic.data.sections.items[0].quantityObservations[0].quantity, 2);
  assert.match(modernReviewDiagnostic.data.sections.items[0].offerTokenHashes[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(modernReviewDiagnostic.data.sections.items[0].lineIdentityHashes[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(modernReviewDiagnostic.data.sections.items[0].selectedOfferHashes[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(modernReviewDiagnostic.data.sections.items[0].auiState[0].fields[0].path, 'asin');
  assert.equal(modernReviewDiagnostic.data.sections.structuredState[0].fields[0].path, 'condition');
  assert.equal(modernReviewDiagnostic.data.sections.totals.giftCardCredits[0].value, '-$26.40');
  assert.doesNotMatch(JSON.stringify(modernReviewDiagnostic), /SECRET_|FULL_CARD_PRIVATE|OUTSIDE_PRIVATE_TEXT|4111/);
  const nativeReviewURL = 'https://www.amazon.com/checkout/p/p-123-1111111-2222222/spc?pipelineType=Chewbacca&isBuyNow=1';
  html = await readFile(new URL('../tests/fixtures/modern-review-facts.html', import.meta.url), 'utf8');
  const nativeForm = '<section id="checkout-pyo-button-block"><form method="post" action="/checkout/p/p-123-1111111-2222222/spc/place-order?pipelineType=Chewbacca&amp;isBuyNow=1&amp;referrer=spc&amp;ref_=fixture"><input type="hidden" name="anti-csrftoken-a2z" value="PRIVATE_CSRF"><input type="hidden" name="consistencyToken" value="PRIVATE_CONSISTENCY"><input type="hidden" name="hasWorkingJavascript" value="1"><input id="placeOrder" name="placeYourOrder1" type="submit" value="Place your order"><input disabled id="placeOrder" name="placeYourOrder1" type="submit" value="Place your order"><input hidden disabled id="placeOrder" name="placeYourOrder1" type="submit" value="Place your order"></form></section>';
  html = html.replace('</main>', nativeForm + '</main>');
  await runtime.run(async page => {
    await page.goto(nativeReviewURL);
    const facts = await extractModernReviewFacts(page, nativeReviewURL);
    assert.ok(facts); assert.equal(facts.line.asin, 'B0FIXTURE1');
    assert.equal(facts.line.quantity, 1); assert.equal(facts.totals.total.minorUnits, 823);
    assert.equal(facts.totals.funding.giftCardApplied.minorUnits, 823);
    assert.match(facts.line.lineIdentityHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(facts), /PRIVATE_/);
    assert.ok(await getModernOrderControl(page, nativeReviewURL));
  });
  html = await readFile(new URL('../tests/fixtures/modern-order-details.html', import.meta.url), 'utf8');
  html = html.replace('<div id="od-subtotals">', '<div id="od-subtotals"><div class="od-line-item-row"><div class="od-line-item-row-label">Gift Card:</div><div class="od-line-item-row-content">-$8.23</div></div>');
  await runtime.run(async page => {
    await page.goto('https://www.amazon.com/gp/your-account/order-details?orderID=123-1111111-2222222');
    const receipt = await readModernOrderDetails(page, '123-1111111-2222222');
    assert.ok(receipt); assert.equal(receipt.line.asin, 'B0FIXTURE1');
    assert.equal(deriveModernReceiptQuantity(receipt).quantity, 1);
    assert.equal(modernReceiptAmounts(receipt.monetaryRows).funding.giftCardApplied.minorUnits, 823);
    assert.equal(receipt.line.condition, undefined);
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_/);
  });
  html = '<main id="order-confirmation"><h1>Order placed, thanks!</h1><a href="/gp/your-account/order-details?orderID=123-1111111-2222222">Order details</a></main>';
  await runtime.run(async page => {
    await page.goto('https://www.amazon.com/checkout/p/p-123-1111111-2222222/thankyou');
    const confirmation = await readModernConfirmation(page, nativeReviewURL, new Set());
    assert.equal(confirmation.orderId, '123-1111111-2222222');
    assert.equal(await readModernConfirmation(page, nativeReviewURL, new Set(['123-1111111-2222222'])), undefined);
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
