import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { AmazonWebProvider } from "../packages/providers/amazon-web/provider.js";
import {
  getModernProductOffer,
  enterModernProductCheckout,
  type NativeModernEntry,
} from "../packages/providers/amazon-web/checkout/modern-product-offer.js";
import { ModernCheckoutOrigins } from "../packages/providers/amazon-web/checkout/modern-origins.js";
import {
  purchaseTermsSchema,
  type PurchaseTerms,
} from "../packages/core/purchasing.js";
import { digest } from "../packages/store/crypto.js";
import type { ProviderContext } from "../packages/contracts/index.js";
import { purchasePreparationSchemas } from "../apps/gateway/registry.js";

const pdp = "https://www.amazon.com/dp/B0FIXTURE1";
const review =
  "https://www.amazon.com/checkout/p/p-123-1111111-2222222/spc?pipelineType=Chewbacca&isBuyNow=1";
const address = review.replace("/spc?", "/address?");
const ctx: ProviderContext = {
  ownerId: "fixture-owner",
  accountRef: "fixture-account",
  marketplace: "amazon.com",
  sessionGeneration: 1,
};
const request = {
  asin: "B0FIXTURE1",
  quantity: 1,
  expectedSellerId: "A1FIXTURE",
  expectedCondition: "New",
};
describe("Volatile native-entry provenance for modern checkout", () => {
  let browser: Browser,
    context: BrowserContext,
    page: Page,
    provider: AmazonWebProvider,
    productFixture: string,
    reviewFixture: string,
    productHTML: string,
    reviewHTML: string,
    addressHTML: string,
    target: string,
    nativePosts: number,
    finalPosts: number,
    now: number,
    generation: number,
    accountHTML: string,
    receiptHTML: string,
    submitEnabled: boolean;
  beforeAll(async () => {
    browser = await chromium.launch();
    productFixture = await readFile(
      new URL("fixtures/modern-product-offer.html", import.meta.url),
      "utf8",
    );
    const facts = await readFile(
      new URL("fixtures/modern-review-facts.html", import.meta.url),
      "utf8",
    );
    reviewFixture = facts
      .replace(
        '<div id="subtotals-marketplace-table">',
        '<section id="checkout-subtotals-section"><div id="subtotals-marketplace-table">',
      )
      .replace(
        '\n<div id="checkout-delivery-address-panel"',
        '</section>\n<div id="checkout-delivery-address-panel"',
      )
      .replace(
        "</section></main>",
        `<section id="checkout-pyo-button-block"><form method="POST" action="/checkout/p/p-123-1111111-2222222/spc/place-order?pipelineType=Chewbacca&amp;isBuyNow=1&amp;referrer=spc"><input type="hidden" name="anti-csrftoken-a2z" value="PRIVATE_CSRF"><input type="hidden" name="consistencyToken" value="PRIVATE_CONSISTENCY"><input type="hidden" name="hasWorkingJavascript" value="1"><input id="placeOrder" name="placeYourOrder1" type="submit" value="Place your order"></form></section></section></main>`,
      );
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({ offline: true });
    page = await context.newPage();
    productHTML = productFixture;
    reviewHTML = reviewFixture;
    target = review;
    nativePosts = 0;
    finalPosts = 0;
    now = 1000;
    generation = 1;
    accountHTML =
      '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span>';
    submitEnabled = false;
    receiptHTML = (
      await readFile(
        new URL("fixtures/modern-order-details.html", import.meta.url),
        "utf8",
      )
    ).replace(
      '<div id="od-subtotals">',
      '<div id="od-subtotals"><div class="od-line-item-row"><div class="od-line-item-row-label">Gift Card:</div><div class="od-line-item-row-content">-$8.23</div></div>',
    );
    addressHTML = `<main id="shipping-address-selection-panel"><span id="select-destination-on-sasp-desktop-panel-id-fixture" data-action="select-destination-on-sasp-desktop-panel" data-select-destination-on-sasp-desktop-panel="fixture"><div class="a-radio" data-a-input-name="destinationSubmissionUrl"><label><input type="radio" name="destinationSubmissionUrl" checked value="/checkout/p/p-123-1111111-2222222/address/shiptodestination?pipelineType=Chewbacca&amp;isBuyNow=1&amp;addressID=PRIVATE_SYNTHETIC_ADDRESS_ID&amp;action=select-shipping"><div class="destination-data-alignment"><span>Fixture Owner</span><span>123 Example St</span><span>Apt 4</span><span>Seattle, WA 98101</span><span>United States</span></div></label></div></span></main><span id="checkout-primary-continue-button-id" class="a-button-primary continue-button primary-action-button"><span class="a-button-inner"><input type="submit" data-testid="bottom-continue-button"><span id="checkout-primary-continue-button-id-announce">Deliver to this address</span></span></span><script>document.querySelector('#checkout-primary-continue-button-id input').addEventListener('click',e=>{e.preventDefault();location.href=${JSON.stringify(review)}})</script>`;
    await page.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/checkout/entry/buynow") {
        if (route.request().method() === "POST") nativePosts++;
        return route.fulfill({
          contentType: "text/html",
          body: `<meta http-equiv="refresh" content="0;url=${target.replaceAll("&", "&amp;")}">`,
        });
      }
      if (u.pathname.endsWith("/place-order")) {
        finalPosts++;
        return submitEnabled
          ? route.fulfill({
              contentType: "text/html",
              body: '<main id="order-confirmation"><h1>Order placed, thanks!</h1><a href="/gp/your-account/order-details?orderID=123-1111111-2222222">Order details</a></main>',
            })
          : route.abort();
      }
      if (u.pathname.includes("order-details"))
        return route.fulfill({
          contentType: "text/html",
          body: accountHTML + receiptHTML,
        });
      return route.fulfill({
        contentType: "text/html",
        body: u.pathname.includes("order-history")
          ? accountHTML
          : u.pathname.startsWith("/dp/")
            ? productHTML
            : u.pathname.endsWith("/address")
              ? addressHTML
              : u.pathname.includes("/cart/")
                ? '<main id="sc-active-cart">Empty</main>'
                : reviewHTML,
      });
    });
    provider = new AmazonWebProvider(
      {
        get sessionGeneration() {
          return generation;
        },
        run: (fn) => fn(page),
        close: async () => {},
      },
      () => now,
    );
  });
  afterEach(async () => {
    await context.close();
  });
  async function prepare() {
    return provider.read("purchase_buy_now_prepare", request, ctx);
  }
  it("accepts an active empty metadata wrapper without boxes while retaining visible row and control proof", async () => {
    productHTML = productHTML.replace(
      'class="accordion-atc-group-item"',
      'class="accordion-atc-group-item" style="display:contents"',
    );
    const marker =
      '<div id="buyNow_regular_offerActions_new_feature_div" data-feature-name="buyNow_regular_offerActions_new"></div>';
    productHTML = productHTML.replace(
      marker,
      `<div class="fixture-metadata-inner" style="display:contents">${marker}</div>`,
    );
    await page.goto(pdp);
    expect(
      await page
        .locator(".accordion-atc-group-item")
        .evaluate((el) => el.getClientRects().length),
    ).toBe(0);
    expect(
      await page
        .locator(".fixture-metadata-inner")
        .evaluate((el) => el.getClientRects().length),
    ).toBe(0);
    expect(await page.locator(".accordion-atc-group-row").isVisible()).toBe(
      true,
    );
    expect(await page.locator("#buy-now-button").isVisible()).toBe(true);
    expect(await getModernProductOffer(page)).toBeDefined();
    expect(await prepare()).toMatchObject({ status: "ok" });
    expect(nativePosts).toBe(1);
    expect(finalPosts).toBe(0);
  });
  it.each([
    "hidden",
    'aria-hidden="true"',
    'style="display:none"',
    'style="visibility:hidden"',
    'aria-selected="false"',
  ])("rejects inactive metadata wrapper %s without entry", async (flags) => {
    productHTML = productHTML.replace(
      'class="accordion-atc-group-item"',
      `class="accordion-atc-group-item" ${flags}`,
    );
    expect((await prepare()).status).not.toBe("ok");
    expect(nativePosts).toBe(0);
    expect(finalPosts).toBe(0);
  });
  it("reports positive native New/selected-one-time options without clicking or creating origin", async () => {
    const options = await provider.read(
      "buying_options_get",
      { asin: request.asin },
      ctx,
    );
    expect(options).toMatchObject({
      status: "ok",
      data: {
        condition: "New",
        sellerId: "A1FIXTURE",
        modes: [{ mode: "one_time", selected: true }],
        nativeOfferEvidence: {
          source: "native_buyNow_regular_offerActions_new",
          offerTokenHash: createHash("sha256")
            .update("PRIVATE_NATIVE_OFFER")
            .digest("hex"),
        },
      },
    });
    expect(JSON.stringify(options)).not.toMatch(
      /PRIVATE_NATIVE_OFFER|PRIVATE_DIFFERENT_APEX/,
    );
    expect(nativePosts).toBe(0);
    expect(
      await provider.read(
        "purchase_checkout_prepare",
        { url: review, expectedRevision: "0".repeat(64) },
        ctx,
      ),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "modern_checkout_origin_required" },
    });
  });
  it("mints provenance only after a real safe native POST and produces complete gift-funded terms", async () => {
    const prepared = await prepare();
    expect(prepared).toMatchObject({
      status: "ok",
      data: {
        commitKind: "checkout_submit",
        purchaseTerms: {
          flow: "buy_now",
          lines: [
            {
              asin: "B0FIXTURE1",
              sellerId: "A1FIXTURE",
              condition: "New",
              purchaseMode: "one_time",
              quantity: 1,
            },
          ],
          total: { minorUnits: 823 },
          funding: {
            giftCardApplied: { minorUnits: 823 },
            additionalAmountDue: { minorUnits: 0 },
          },
        },
      },
    });
    expect(nativePosts).toBe(1);
    expect(finalPosts).toBe(0);
    const snapshot = await provider.read("checkout_get", { url: review }, ctx);
    expect(snapshot).toMatchObject({
      status: "ok",
      data: { recognized: true, executableTerms: true },
    });
    const data = snapshot.data as { revision: string; terms: PurchaseTerms };
    expect(data.revision).toBe(digest(data.terms));
    expect(
      await provider.read(
        "purchase_checkout_prepare",
        { url: review, expectedRevision: data.revision },
        ctx,
      ),
    ).toMatchObject({ status: "ok", data: { purchaseTerms: data.terms } });
    expect(
      await provider.read(
        "checkout_submit_preconditions",
        data.terms as unknown as Record<string, unknown>,
        ctx,
      ),
    ).toMatchObject({ status: "ok", data: data.terms });
    accountHTML += '<div id="ordersContainer">No orders</div>';
    expect(
      await provider.mutate(
        "checkout_submit",
        data.terms as unknown as Record<string, unknown>,
        { ...ctx, intentExpiresAt: new Date(Date.now() - 1).toISOString() },
      ),
    ).toMatchObject({ status: "conflict", error: { code: "STALE_INTENT" } });
    expect(finalPosts).toBe(0);
  });
  it("keeps an arbitrary existing checkout and request-supplied evidence nonexecutable", async () => {
    expect(
      await provider.read(
        "purchase_checkout_prepare",
        {
          url: review,
          expectedRevision: "a".repeat(64),
          origin: {
            condition: "New",
            purchaseMode: "one_time",
            offerTokenHash: "a".repeat(64),
          },
        },
        ctx,
      ),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "modern_checkout_origin_required" },
    });
    expect(
      await provider.read("checkout_get", { url: review }, ctx),
    ).toMatchObject({ status: "partial", data: { executableTerms: false } });
    expect(
      purchasePreparationSchemas.checkout_prepare!.safeParse({
        accountRef: "11111111-1111-4111-8111-111111111111",
        url: review,
        expectedRevision: "a".repeat(64),
        idempotencyKey: "fixture-prepare",
        origin: { condition: "New" },
      }).success,
    ).toBe(false);
    expect(nativePosts).toBe(0);
  });
  it("preserves origin through only verified same-session saved-address API continuation", async () => {
    target = address;
    expect(await prepare()).toMatchObject({
      status: "requires_user_action",
      error: { code: "checkout_address_selection_required" },
    });
    expect(nativePosts).toBe(1);
    const read = await provider.read(
      "checkout_addresses_get",
      { url: address },
      ctx,
    );
    expect(read.status).toBe("ok");
    const state = read.data as {
      revision: string;
      contextFingerprint: string;
      addresses: { addressRef: string; fingerprint: string }[];
    };
    expect(
      await provider.mutate(
        "checkout_address_select",
        {
          url: address,
          expectedRevision: state.revision,
          expectedContextFingerprint: state.contextFingerprint,
          expectedSessionGeneration: 1,
          addressRef: state.addresses[0]!.addressRef,
          expectedFingerprint: state.addresses[0]!.fingerprint,
        },
        ctx,
      ),
    ).toMatchObject({ status: "ok" });
    expect(
      await provider.read("checkout_get", { url: review }, ctx),
    ).toMatchObject({ status: "ok", data: { executableTerms: true } });
    expect(nativePosts).toBe(1);
    expect(finalPosts).toBe(0);
  });
  it("executes the full native address-to-funded-receipt flow with one final POST and no reconstructed proof", async () => {
    target = address;
    accountHTML += '<div id="ordersContainer">No orders</div>';
    submitEnabled = true;
    expect(await prepare()).toMatchObject({
      status: "requires_user_action",
      error: { code: "checkout_address_selection_required" },
    });
    const addresses = await provider.read(
      "checkout_addresses_get",
      { url: address },
      ctx,
    );
    expect(addresses.status).toBe("ok");
    const state = addresses.data as {
      revision: string;
      contextFingerprint: string;
      addresses: { addressRef: string; fingerprint: string }[];
    };
    expect(
      await provider.mutate(
        "checkout_address_select",
        {
          url: address,
          expectedRevision: state.revision,
          expectedContextFingerprint: state.contextFingerprint,
          expectedSessionGeneration: 1,
          addressRef: state.addresses[0]!.addressRef,
          expectedFingerprint: state.addresses[0]!.fingerprint,
        },
        ctx,
      ),
    ).toMatchObject({ status: "ok" });
    const snapshot = await provider.read("checkout_get", { url: review }, ctx);
    expect(snapshot.status).toBe("ok");
    const current = snapshot.data as { revision: string; terms: PurchaseTerms };
    expect(current.revision).toBe(digest(current.terms));
    const prepared = await provider.read(
      "purchase_checkout_prepare",
      { url: review, expectedRevision: current.revision },
      ctx,
    );
    expect(prepared).toMatchObject({
      status: "ok",
      data: { purchaseTerms: current.terms },
    });
    const terms = purchaseTermsSchema.parse(
      (prepared.data as { purchaseTerms: unknown }).purchaseTerms,
    );
    expect(
      await provider.read(
        "checkout_submit_preconditions",
        terms as unknown as Record<string, unknown>,
        ctx,
      ),
    ).toMatchObject({ status: "ok", data: terms });
    const result = await provider.mutate(
      "checkout_submit",
      terms as unknown as Record<string, unknown>,
      { ...ctx, intentExpiresAt: new Date(Date.now() + 60000).toISOString() },
    );
    expect(result).toMatchObject({
      status: "ok",
      data: {
        orderIds: ["123-1111111-2222222"],
        verification: {
          profile: "modern_single_item_funded_order",
          grossTotal: { currency: "USD", minorUnits: 823 },
          funding: {
            giftCardApplied: { currency: "USD", minorUnits: 823 },
            additionalAmountDue: { currency: "USD", minorUnits: 0 },
          },
          additionalPaymentEvidence: "gross_less_displayed_gift_credit",
          preSubmitOnlyFields: ["condition", "purchaseMode"],
        },
      },
    });
    expect(nativePosts).toBe(1);
    expect(finalPosts).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
    expect(
      await provider.read(
        "checkout_submit_preconditions",
        terms as unknown as Record<string, unknown>,
        ctx,
      ),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "modern_checkout_origin_required" },
    });
    expect(finalPosts).toBe(1);
  });
  it.each([
    'data-condition="Used"',
    'condition-type="Renewed"',
    'data-purchase-mode="subscribe_and_save"',
  ])(
    "rejects contradictory selected-row %s at quote, preconditions, and submit without a final POST",
    async (attrs) => {
      accountHTML += '<div id="ordersContainer">No orders</div>';
      for (const stage of ["quote", "preconditions", "submit"]) {
        reviewHTML = reviewFixture;
        const prepared = await prepare();
        expect(prepared.status).toBe("ok");
        const terms = (prepared.data as { purchaseTerms: PurchaseTerms })
          .purchaseTerms;
        reviewHTML = reviewFixture.replace(
          'id="checkout-item-block-0"',
          `id="checkout-item-block-0" ${attrs}`,
        );
        const result =
          stage === "quote"
            ? await provider.read("checkout_get", { url: review }, ctx)
            : stage === "preconditions"
              ? await provider.read(
                  "checkout_submit_preconditions",
                  terms as unknown as Record<string, unknown>,
                  ctx,
                )
              : await provider.mutate(
                  "checkout_submit",
                  terms as unknown as Record<string, unknown>,
                  {
                    ...ctx,
                    intentExpiresAt: new Date(Date.now() + 60000).toISOString(),
                  },
                );
        expect(result.status).toBe("unsupported");
        expect(
          await provider.read(
            "checkout_submit_preconditions",
            terms as unknown as Record<string, unknown>,
            ctx,
          ),
        ).toMatchObject({
          status: "unsupported",
          error: { code: "modern_checkout_origin_required" },
        });
        expect(finalPosts).toBe(0);
      }
    },
  );
  it("invalidates modern provenance after an unrelated legacy/cart preparation", async () => {
    const prepared = await prepare();
    expect(prepared.status).toBe("ok");
    const terms = (prepared.data as { purchaseTerms: PurchaseTerms })
      .purchaseTerms;
    await provider.read(
      "purchase_checkout_prepare",
      {
        url: "https://www.amazon.com/checkout/p/review",
        expectedRevision: "a".repeat(64),
      },
      ctx,
    );
    expect(
      await provider.read(
        "checkout_submit_preconditions",
        terms as unknown as Record<string, unknown>,
        ctx,
      ),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "modern_checkout_origin_required" },
    });
    expect(finalPosts).toBe(0);
  });
  it.each([
    "hidden",
    'aria-hidden="true"',
    'style="display:none"',
    'style="visibility:hidden"',
    'style="visibility:collapse"',
  ])(
    "rejects an inactive native New marker itself (%s) before any entry",
    async (flags) => {
      productHTML = productHTML.replace(
        'id="buyNow_regular_offerActions_new_feature_div"',
        `id="buyNow_regular_offerActions_new_feature_div" ${flags}`,
      );
      expect((await prepare()).status).not.toBe("ok");
      expect(nativePosts).toBe(0);
      expect(finalPosts).toBe(0);
    },
  );
  it("rejects a containing offer row explicitly marked inactive", async () => {
    productHTML = productHTML.replace(
      'class="accordion-atc-group-row"',
      'class="accordion-atc-group-row" aria-selected="false"',
    );
    expect((await prepare()).status).not.toBe("ok");
    expect(nativePosts).toBe(0);
  });
  it("does not accept manual address continuation in place of the saved-address API", async () => {
    target = address;
    await prepare();
    await page.goto(review);
    expect(
      await provider.read(
        "purchase_checkout_prepare",
        { url: review, expectedRevision: "a".repeat(64) },
        ctx,
      ),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "modern_checkout_origin_required" },
    });
  });
  it("invalidates uncertain address outcomes and never restores origin from read-only reconciliation", async () => {
    target = address;
    await prepare();
    const read = await provider.read(
      "checkout_addresses_get",
      { url: address },
      ctx,
    );
    const state = read.data as {
      revision: string;
      contextFingerprint: string;
      addresses: { addressRef: string; fingerprint: string }[];
    };
    reviewHTML = reviewFixture.replace("<span>United States</span>", "");
    expect(
      await provider.mutate(
        "checkout_address_select",
        {
          url: address,
          expectedRevision: state.revision,
          expectedContextFingerprint: state.contextFingerprint,
          expectedSessionGeneration: 1,
          addressRef: state.addresses[0]!.addressRef,
          expectedFingerprint: state.addresses[0]!.fingerprint,
        },
        ctx,
      ),
    ).toMatchObject({ status: "outcome_unknown" });
    reviewHTML = reviewFixture;
    expect(
      (
        await provider.read(
          "checkout_addresses_get",
          { url: address, reconcileCurrent: true },
          ctx,
        )
      ).status,
    ).toBe("ok");
    expect(
      await provider.read(
        "purchase_checkout_prepare",
        { url: review, expectedRevision: "a".repeat(64) },
        ctx,
      ),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "modern_checkout_origin_required" },
    });
    expect(finalPosts).toBe(0);
  });
  it.each(["cart mutation", "legacy preparation"])(
    "orders invalidation inside serialized actions when %s is queued behind native preparation",
    async (queuedAction) => {
      let queue = Promise.resolve();
      provider = new AmazonWebProvider(
        {
          sessionGeneration: 1,
          run<T>(fn: (page: Page) => Promise<T>) {
            const job = queue.then(() => fn(page));
            queue = job.then(
              () => undefined,
              () => undefined,
            );
            return job;
          },
          close: async () => {},
        },
        () => now,
      );
      const preparing = prepare();
      const mutation =
        queuedAction === "cart mutation"
          ? provider.mutate(
              "cart_remove",
              { lineRef: "missing", expectedRevision: "stale" },
              ctx,
            )
          : provider.read(
              "purchase_checkout_prepare",
              {
                url: "https://www.amazon.com/checkout/p/review",
                expectedRevision: "a".repeat(64),
              },
              ctx,
            );
      const [prepared] = await Promise.all([preparing, mutation]);
      expect(prepared.status).toBe("ok");
      const terms = (prepared.data as { purchaseTerms: PurchaseTerms })
        .purchaseTerms;
      expect(
        await provider.read(
          "checkout_submit_preconditions",
          terms as unknown as Record<string, unknown>,
          ctx,
        ),
      ).toMatchObject({
        status: "unsupported",
        error: { code: "modern_checkout_origin_required" },
      });
      expect(finalPosts).toBe(0);
    },
  );
  it("expires absolutely without refreshing the 15-minute deadline on reads", async () => {
    expect((await prepare()).status).toBe("ok");
    now += 14 * 60000;
    expect(
      (await provider.read("checkout_get", { url: review }, ctx)).status,
    ).toBe("ok");
    now += 60001;
    expect(
      await provider.read(
        "purchase_checkout_prepare",
        { url: review, expectedRevision: "a".repeat(64) },
        ctx,
      ),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "modern_checkout_origin_required" },
    });
  });
  it.each([
    "restart",
    "session",
    "auth",
    "mutation",
    "line_rebinding",
    "seller_change",
    "price_change",
    "quantity_change",
  ] as const)(
    "invalidates origin on %s and cannot restore it from prior terms",
    async (failure) => {
      const prepared = await prepare();
      expect(prepared.status).toBe("ok");
      const terms = (prepared.data as { purchaseTerms: PurchaseTerms })
        .purchaseTerms;
      if (failure === "restart")
        provider = new AmazonWebProvider(
          {
            sessionGeneration: 1,
            run: (fn) => fn(page),
            close: async () => {},
          },
          () => now,
        );
      if (failure === "session") {
        generation = 2;
        await provider.read(
          "purchase_checkout_prepare",
          { url: review, expectedRevision: digest(terms) },
          { ...ctx, sessionGeneration: 2 },
        );
      }
      if (failure === "auth") {
        accountHTML = '<input type="password">';
        await provider.read("checkout_get", { url: review }, ctx);
        accountHTML =
          '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span>';
      }
      if (failure === "mutation")
        await provider.mutate(
          "cart_remove",
          { lineRef: "missing", expectedRevision: "stale" },
          ctx,
        );
      if (failure === "line_rebinding") {
        reviewHTML = reviewHTML.replaceAll(
          "PRIVATE_SYNTHETIC_LINE_ID",
          "PRIVATE_CHANGED_LINE",
        );
        expect(
          (await provider.read("checkout_get", { url: review }, ctx)).status,
        ).toBe("unsupported");
        reviewHTML = reviewFixture;
      }
      if (
        failure === "seller_change" ||
        failure === "price_change" ||
        failure === "quantity_change"
      ) {
        reviewHTML =
          failure === "seller_change"
            ? reviewHTML.replace("seller=A1FIXTURE", "seller=A1OTHER1")
            : failure === "price_change"
              ? reviewHTML
                  .replaceAll("$7.40", "$7.41")
                  .replaceAll("$8.23", "$8.24")
              : reviewHTML
                  .replace('data-steppervalue="1"', 'data-steppervalue="2"')
                  .replace(
                    'class="a-stepper-value-live">1',
                    'class="a-stepper-value-live">2',
                  )
                  .replace(
                    'Items:</div><div class="order-summary-line-definition">$7.40',
                    'Items:</div><div class="order-summary-line-definition">$14.80',
                  )
                  .replaceAll("$8.23", "$15.63");
        expect(
          (await provider.read("checkout_get", { url: review }, ctx)).status,
        ).toBe("unsupported");
        reviewHTML = reviewFixture;
      }
      const current =
        failure === "session" ? { ...ctx, sessionGeneration: 2 } : ctx;
      expect(
        await provider.read(
          "checkout_submit_preconditions",
          terms as unknown as Record<string, unknown>,
          current,
        ),
      ).toMatchObject({
        status: "unsupported",
        error: { code: "modern_checkout_origin_required" },
      });
      expect(finalPosts).toBe(0);
    },
  );
  it.each([
    [
      "used marker",
      "buyNow_regular_offerActions_new",
      "buyNow_regular_offerActions_used",
    ],
    [
      "quantity",
      'name="items[0.base][quantity]" value="1"',
      'name="items[0.base][quantity]" value="2"',
    ],
    [
      "inline handler",
      'name="submit.buy-now"',
      'name="submit.buy-now" onclick="return false"',
    ],
    [
      "missing marker",
      'data-feature-name="buyNow_regular_offerActions_new"',
      'data-feature-name="other"',
    ],
  ] as const)("rejects %s before any native entry", async (_, from, to) => {
    productHTML = productHTML.replaceAll(from, to);
    expect((await prepare()).status).not.toBe("ok");
    expect(nativePosts).toBe(0);
  });
  it("rechecks a native observation immediately before clicking and excludes unrelated APEX state", async () => {
    await page.goto(pdp);
    const selected = await getModernProductOffer(page);
    expect(selected).toBeDefined();
    expect(selected!.offer.offerTokenHash).toBe(
      createHash("sha256").update("PRIVATE_NATIVE_OFFER").digest("hex"),
    );
    await page
      .locator('input[name="merchantID"]')
      .evaluate((el) => ((el as HTMLInputElement).value = "A1OTHER1"));
    expect(
      await enterModernProductCheckout(page, selected!.offer),
    ).toBeUndefined();
    expect(nativePosts).toBe(0);
  });
  it("rejects forged entries and evicts the oldest beyond 20 actual native entries without persisting proof", async () => {
    const origins = new ModernCheckoutOrigins(() => now);
    expect(
      origins.recordNativeEntry(ctx, {
        checkoutURL: review,
        offer: { condition: "New" },
      } as NativeModernEntry),
    ).toBe(false);
    const urls: string[] = [];
    for (let index = 0; index < 21; index++) {
      target = review.replace("1111111", String(1111111 + index));
      urls.push(target);
      await page.goto(pdp);
      const selected = await getModernProductOffer(page);
      const entry = await enterModernProductCheckout(page, selected!.offer);
      expect(entry).toBeDefined();
      expect(origins.recordNativeEntry(ctx, entry!)).toBe(true);
      expect(origins.recordNativeEntry(ctx, entry!)).toBe(false);
    }
    expect(origins.get(ctx, urls[0]!)).toBeUndefined();
    expect(origins.get(ctx, urls[20]!)).toBeDefined();
    origins.clear();
    expect(origins.get(ctx, urls[20]!)).toBeUndefined();
  }, 15000);
});
