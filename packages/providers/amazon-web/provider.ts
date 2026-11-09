import type { Page } from "playwright";
import type {
  ProviderContext,
  Result,
  ShoppingProvider,
} from "../../contracts/index.js";
import {
  BrowserRuntimeError,
  PersistentBrowserRuntime,
  classifyPage,
  isVerifiedAuthenticatedAmazonPage,
} from "../../browser-runtime/index.js";
import { extractCart } from "./cart/index.js";
import { extractCheckout, prepareCheckout } from "./checkout/index.js";
import { buyingOptions, preparePurchase, readCheckoutAddresses, readPurchasePreconditions, submitPurchase } from "./checkout/purchasing.js";
import { reconcileCurrentAddress, selectCheckoutAddress } from "./checkout/addresses.js";
import { isModernReviewCandidate, readModernReviewDiagnostics } from "./checkout/review-diagnostics.js";
import { purchaseCommitKinds } from "../../core/purchasing.js";
import {
  extractCategory,
  extractMedia,
  extractProduct,
  extractRelated,
  extractSearch,
} from "./discovery/index.js";
import { extractDeals } from "./deals/index.js";
import {
  extractOffers,
  extractSeller,
  extractSellerFeedback,
} from "./offers/index.js";
import {
  extractOrder,
  extractOrders,
  extractShipments,
} from "./orders/index.js";
import { extractReviews } from "./reviews/index.js";
import { extractSubscriptions } from "./subscriptions/index.js";
import { asinFrom } from "./types.js";

export const AMAZON_WEB_READ_KINDS = [
  "products_search",
  "products_get",
  "offers_list",
  "product_reviews_list",
  "product_media_list",
  "cart_get",
  "orders_list",
  "orders_get",
  "shipments_get",
  "subscriptions_list",
  "checkout_get",
  "checkout_prepare",
  "categories_browse",
  "products_variants",
  "products_related",
  "sellers_get",
  "seller_feedback_list",
  "deals_search",
] as const;
export const AMAZON_WEB_MUTATION_KINDS = [
  "checkout_address_select",
  "cart_add",
  "cart_set_quantity",
  "cart_remove",
  "cart_move",
] as const;

const accountReads = new Set([
  "cart_get",
  "orders_list",
  "orders_get",
  "shipments_get",
  "subscriptions_list",
  "checkout_get",
  "checkout_prepare",
]);

type Runner = {
  readonly sessionGeneration?: number;
  run<T>(fn: (page: Page) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export class AmazonWebProvider implements ShoppingProvider {
  constructor(private readonly runner: Runner) {}

  async read(
    kind: string,
    input: Record<string, unknown>,
    context: ProviderContext,
  ): Promise<Result> {
    if (["checkout_addresses_get", "buying_options_get", "purchase_checkout_prepare", "purchase_buy_now_prepare", "purchase_subscriptions_prepare", "checkout_submit_preconditions", "subscriptions_submit_preconditions"].includes(kind)) {
      if (this.runner.sessionGeneration !== undefined && this.runner.sessionGeneration !== context.sessionGeneration)
        return staleSession(this.runner.sessionGeneration);
      try {
        return await this.runner.run(async (page) => {
          if (kind === "buying_options_get") return buyingOptions(page, input.asin);
          if (kind === "checkout_addresses_get") {
            if (input.inspectCurrent === true && input.reconcileCurrent === true) return { status: 'unsupported', error: { code: 'incompatible_address_read_modes', retryable: false } };
            return input.reconcileCurrent === true ? reconcileCurrentAddress(page, input, context) : readCheckoutAddresses(page, input, context);
          }
          if (kind.endsWith("_preconditions")) return readPurchasePreconditions(page, input);
          return preparePurchase(page, kind.slice("purchase_".length), input, context);
        });
      } catch (error) { return mapError(error); }
    }
    if (
      !AMAZON_WEB_READ_KINDS.includes(
        kind as (typeof AMAZON_WEB_READ_KINDS)[number],
      )
    )
      return unsupported(kind);
    if (
      this.runner.sessionGeneration !== undefined &&
      this.runner.sessionGeneration !== context.sessionGeneration
    )
      return staleSession(this.runner.sessionGeneration);
    try {
      return await this.runner.run(async (page) => {
        if (kind === 'checkout_get' && isModernReviewCandidate(input.url)) return readModernReviewDiagnostics(page, input.url, context);
        const target = readTarget(kind, input);
        if (target) {
          await page.goto(target, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
          const state = await classifyPage(page);
          if (state.kind === "challenge")
            return challengeResult(state.challenge, state.url);
        }
        const authenticated = accountReads.has(kind);
        if (authenticated && !(await isVerifiedAuthenticatedAmazonPage(page)))
          return challengeResult("signin", page.url());
        const observedAt = new Date().toISOString();
        const contextRef = context.accountRef || "public";
        let data: unknown;
        switch (kind) {
          case "products_search":
            data = {
              items: await extractSearch(page),
              page: boundedPage(input.page ?? decodeCursor(input.cursor)),
            };
            break;
          case "products_get":
            requiredAsin(input);
            data = await extractProduct(page);
            break;
          case "offers_list":
            requiredAsin(input);
            data = await extractOffers(page);
            break;
          case "product_reviews_list":
            requiredAsin(input);
            data = await extractReviews(page);
            break;
          case "product_media_list":
            requiredAsin(input);
            data = await extractMedia(page);
            break;
          case "categories_browse":
            data = await extractCategory(page);
            break;
          case "products_variants": {
            requiredAsin(input);
            const product = await extractProduct(page);
            data = { asin: product.asin, variants: product.variants };
            break;
          }
          case "products_related":
            requiredAsin(input);
            data = await extractRelated(page);
            break;
          case "sellers_get":
            data = await extractSeller(page);
            break;
          case "seller_feedback_list":
            data = {
              ...(await extractSeller(page)),
              ...(await extractSellerFeedback(page)),
            };
            break;
          case "deals_search":
            data = await extractDeals(page);
            break;
          case "cart_get":
            data = await extractCart(page);
            break;
          case "orders_list":
            data = { ...(await extractOrders(page)), requestedPage: boundedPage(input.page ?? decodeCursor(input.cursor)) };
            break;
          case "orders_get":
            data = await extractOrder(page, requiredOrderId(input));
            break;
          case "shipments_get":
            data = await extractShipments(page, requiredOrderId(input), async (url) => {
              await gotoAndCheck(page, url);
              if (!await isVerifiedAuthenticatedAmazonPage(page))
                throw new BrowserRuntimeError("challenge_signin", "Sign in again in the dedicated browser");
            });
            break;
          case "subscriptions_list":
            data = await extractSubscriptions(page);
            break;
          case "checkout_get":
            data = await extractCheckout(page);
            break;
          case "checkout_prepare": {
            const expectedRevision = requiredString(
              input,
              "expectedRevision",
              64,
            );
            const prepared = await prepareCheckout(page, expectedRevision);
            if (prepared.conflict)
              return {
                status: "conflict",
                data: prepared.checkout,
                error: { code: "stale_checkout", retryable: true },
                observation: { observedAt, source: "amazon-web", contextRef },
              };
            data = prepared;
            break;
          }
        }
        if (
          [
            "products_get",
            "products_variants",
            "products_related",
            "product_media_list",
            "offers_list",
            "product_reviews_list",
          ].includes(kind)
        ) {
          const requested = requiredAsin(input);
          const observed = (data as { asin?: string }).asin;
          if (observed && observed !== requested)
            return {
              status: "conflict",
              data: { requestedAsin: requested, observedAsin: observed },
              error: { code: "wrong_product_identity", retryable: false },
            };
        }
        const missing = missingCoverage(kind, data);
        if (
          kind === "checkout_prepare" &&
          missing.some((item) => item.startsWith("required:"))
        )
          data = { ...(data as object), termsHash: undefined, ready: false };
        return {
          status: missing.length ? "partial" : "ok",
          data,
          observation: {
            observedAt,
            source: "amazon-web",
            contextRef,
            ...(authenticated ? { authentication: "verified" as const } : {}),
          },
          coverage: {
            complete: missing.length === 0,
            missing,
            reason: missing.length
              ? "Visible Amazon page did not expose all expected fields"
              : undefined,
          },
        };
      });
    } catch (error) {
      return mapError(error);
    }
  }

  async mutate(
    kind: string,
    terms: Record<string, unknown>,
    context: ProviderContext,
  ): Promise<Result> {
    if (
      !(purchaseCommitKinds as readonly string[]).includes(kind) && !AMAZON_WEB_MUTATION_KINDS.includes(
        kind as (typeof AMAZON_WEB_MUTATION_KINDS)[number],
      )
    )
      return unsupported(kind);
    if (
      this.runner.sessionGeneration !== undefined &&
      this.runner.sessionGeneration !== context.sessionGeneration
    )
      return staleSession(this.runner.sessionGeneration);
    try {
      return await this.runner.run(async (page) => {
        if ((purchaseCommitKinds as readonly string[]).includes(kind)) return submitPurchase(page, kind, terms, context);
        if (kind === 'checkout_address_select') return selectCheckoutAddress(page, terms, context);
        if (kind === "cart_add") return this.addToCart(page, terms, context);
        await gotoAndCheck(page, "https://www.amazon.com/gp/cart/view.html");
        const before = await extractCart(page);
        if (!before.recognized) return unrecognizedCart();
        const expectedRevision = requiredString(terms, "expectedRevision", 64);
        if (before.revision !== expectedRevision)
          return {
            status: "conflict",
            data: before,
            error: { code: "stale_cart", retryable: true },
          };
        const lineRef = safeLineRef(terms.lineRef);
        const prior = before.lines.find((line) => line.lineRef === lineRef);
        if (!prior)
          return {
            status: "conflict",
            data: before,
            error: { code: "cart_line_not_found", retryable: false },
          };
        if (!completeCartIdentity(prior)) return incompleteCartLine(prior);
        const row = page
          .locator(
            `[data-itemid=${JSON.stringify(lineRef)}], [data-item-id=${JSON.stringify(lineRef)}]`,
          )
          .first();
        if ((await row.count()) === 0)
          return {
            status: "conflict",
            data: before,
            error: { code: "cart_line_not_found", retryable: false },
          };
        let dispatched = false;
        try {
          if (kind === "cart_set_quantity") {
            const quantity = boundedQuantity(terms.quantity);
            const select = row.locator('select[name*="quantity"]').first();
            if (await select.count()) {
              dispatched = true;
              await select.selectOption(String(quantity));
            } else {
              await row.locator(".a-dropdown-prompt").first().click();
              dispatched = true;
              await page
                .getByRole("option", { name: String(quantity), exact: true })
                .click();
            }
          } else {
            if (
              kind === "cart_move" &&
              terms.destination !== "restore" &&
              terms.destination !== "save_for_later"
            )
              throw new BrowserRuntimeError(
                "invalid_input",
                "Cart move destination must be restore or save_for_later",
              );
            const label =
              kind === "cart_remove"
                ? /delete|remove/i
                : terms.destination === "restore"
                  ? /move to cart/i
                  : /save for later/i;
            dispatched = true;
            await row
              .getByRole("button", { name: label })
              .or(row.getByRole("link", { name: label }))
              .first()
              .click();
          }
          await page.waitForTimeout(100);
          const after = await extractCart(page);
          if (!cartPostcondition(kind, before, after, lineRef, terms))
            return unknown(kind, after);
          return observed(after, context);
        } catch (error) {
          if (dispatched) return unknown(kind);
          throw error;
        }
      });
    } catch (error) {
      return mapError(error);
    }
  }

  async close(): Promise<void> {
    await this.runner.close();
  }

  private async addToCart(
    page: Page,
    terms: Record<string, unknown>,
    context: ProviderContext,
  ): Promise<Result> {
    const asin = requiredAsin(terms);
    const quantity = boundedQuantity(terms.quantity);
    const expectedRevision = requiredString(terms, "expectedRevision", 64);
    const expectedSellerId = requiredSellerId({
      sellerId: terms.expectedSellerId,
    });
    const expectedCondition = requiredString(terms, "expectedCondition", 80);
    const purchaseMode = requiredString(terms, "purchaseMode", 32);
    if (purchaseMode !== "one_time")
      return {
        status: "unsupported",
        error: {
          code: "purchase_mode_not_supported",
          retryable: false,
          message:
            "Only an explicitly observed one-time purchase mode is supported",
        },
      };
    await gotoAndCheck(page, "https://www.amazon.com/gp/cart/view.html");
    const before = await extractCart(page);
    if (!before.recognized) return unrecognizedCart();
    if (before.revision !== expectedRevision)
      return {
        status: "conflict",
        data: before,
        error: { code: "stale_cart", retryable: true },
      };
    const incompleteSameAsin = before.lines.find(
      (line) =>
        line.location === "active" &&
        line.asin === asin &&
        !completeCartIdentity(line),
    );
    if (incompleteSameAsin) return incompleteCartLine(incompleteSameAsin);
    await gotoAndCheck(page, `https://www.amazon.com/dp/${asin}`);
    const product = await extractProduct(page);
    if (product.asin !== asin)
      return {
        status: "conflict",
        error: { code: "wrong_variant", retryable: false },
      };
    const sellerHref = await page
      .locator('#sellerProfileTriggerId[href*="seller="]')
      .first()
      .getAttribute("href")
      .catch(() => null);
    const sellerId = sellerHref
      ? new URL(sellerHref, "https://www.amazon.com").searchParams
          .get("seller")
          ?.toUpperCase()
      : undefined;
    const condition = normalizeText(
      await page
        .locator(
          "#condition, #newAccordionRow .a-color-base, #usedAccordionRow .a-color-base",
        )
        .first()
        .textContent()
        .catch(() => ""),
    );
    if (!sellerId || sellerId !== expectedSellerId)
      return {
        status: "conflict",
        error: { code: "wrong_seller", retryable: false },
        data: { observedSellerId: sellerId },
      };
    if (!condition || condition !== normalizeText(expectedCondition))
      return {
        status: "conflict",
        error: { code: "wrong_condition", retryable: false },
        data: { observedCondition: condition || undefined },
      };
    const observedMode = await page
      .locator('[data-purchase-mode][aria-checked="true"]')
      .first()
      .getAttribute("data-purchase-mode")
      .catch(() => null);
    if (observedMode !== purchaseMode)
      return {
        status: "conflict",
        error: { code: "wrong_purchase_mode", retryable: false },
        data: { observedMode },
      };
    const quantitySelect = page.locator("#quantity").first();
    if ((await quantitySelect.count()) === 0)
      return {
        status: "unsupported",
        error: { code: "quantity_control_unavailable", retryable: false },
      };
    await quantitySelect.selectOption(String(quantity));
    if ((await quantitySelect.inputValue()) !== String(quantity))
      return {
        status: "conflict",
        error: { code: "quantity_not_selected", retryable: false },
      };
    let dispatched = false;
    try {
      dispatched = true;
      await page.locator("#add-to-cart-button").click();
      await gotoAndCheck(page, "https://www.amazon.com/gp/cart/view.html");
      const cart = await extractCart(page);
      const matches = (line: (typeof cart.lines)[number]) =>
        line.asin === asin &&
        line.sellerId?.toUpperCase() === expectedSellerId &&
        normalizeText(line.condition) === normalizeText(expectedCondition) &&
        line.purchaseMode === purchaseMode;
      if (!cart.recognized) return unknown("cart_add", cart);
      const beforeMatches = before.lines.filter(
        (line) => line.location === "active" && matches(line),
      );
      const afterMatches = cart.lines.filter(
        (line) => line.location === "active" && matches(line),
      );
      if (
        beforeMatches.some((line) => !completeCartIdentity(line)) ||
        afterMatches.some((line) => !completeCartIdentity(line))
      )
        return unknown("cart_add", cart);
      const beforeQuantity = beforeMatches.reduce(
        (sum, line) => sum + line.quantity!,
        0,
      );
      const afterQuantity = afterMatches.reduce(
        (sum, line) => sum + line.quantity!,
        0,
      );
      if (afterQuantity - beforeQuantity !== quantity)
        return unknown("cart_add", cart);
      return observed(cart, context);
    } catch (error) {
      if (dispatched) return unknown("cart_add");
      throw error;
    }
  }
}

export function createAmazonWebProvider(
  options: ConstructorParameters<typeof PersistentBrowserRuntime>[0],
): { provider: AmazonWebProvider; runtime: PersistentBrowserRuntime } {
  const runtime = new PersistentBrowserRuntime(options);
  return { provider: new AmazonWebProvider(runtime), runtime };
}

async function gotoAndCheck(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const state = await classifyPage(page);
  if (state.kind === "challenge")
    throw new BrowserRuntimeError(
      `challenge_${state.challenge}`,
      state.message,
    );
}

function readTarget(
  kind: string,
  input: Record<string, unknown>,
): string | undefined {
  switch (kind) {
    case "products_search":
      return `https://www.amazon.com/s?k=${encodeURIComponent(requiredString(input, "query", 200))}&page=${boundedPage(input.page ?? decodeCursor(input.cursor))}`;
    case "products_get":
      return `https://www.amazon.com/dp/${requiredAsin(input)}`;
    case "offers_list":
      return `https://www.amazon.com/gp/offer-listing/${requiredAsin(input)}`;
    case "product_reviews_list":
      return `https://www.amazon.com/product-reviews/${requiredAsin(input)}?pageNumber=${boundedPage(input.page ?? decodeCursor(input.cursor))}`;
    case "product_media_list":
      return `https://www.amazon.com/dp/${requiredAsin(input)}`;
    case "categories_browse":
      return categoryUrl(input);
    case "products_variants":
    case "products_related":
      return `https://www.amazon.com/dp/${requiredAsin(input)}`;
    case "sellers_get":
    case "seller_feedback_list":
      return `https://www.amazon.com/sp?seller=${requiredSellerId(input)}&page=${boundedPage(input.page ?? decodeCursor(input.cursor))}`;
    case "deals_search":
      return "https://www.amazon.com/deals";
    case "cart_get":
      return "https://www.amazon.com/gp/cart/view.html";
    case "orders_list":
      return `https://www.amazon.com/gp/your-account/order-history?startIndex=${(boundedPage(input.page ?? decodeCursor(input.cursor)) - 1) * 10}`;
    case "orders_get":
    case "shipments_get":
      return `https://www.amazon.com/gp/your-account/order-details?orderID=${requiredOrderId(input)}`;
    case "subscriptions_list":
      return "https://www.amazon.com/gp/subscribe-and-save/manager/viewsubscriptions";
    case "checkout_get":
    case "checkout_prepare":
      return restrictedCheckoutUrl(input.url);
    default:
      return undefined;
  }
}

function requiredAsin(input: Record<string, unknown>): string {
  const asin = asinFrom(
    typeof input.asin === "string"
      ? input.asin
      : typeof input.url === "string"
        ? input.url
        : undefined,
  );
  if (!asin)
    throw new BrowserRuntimeError(
      "invalid_input",
      "A valid Amazon ASIN or product URL is required",
    );
  return asin;
}
function requiredOrderId(input: Record<string, unknown>): string {
  const id = requiredString(input, "orderId", 32);
  if (!/^\d{3}-\d{7}-\d{7}$/.test(id))
    throw new BrowserRuntimeError(
      "invalid_input",
      "Amazon order ID is invalid",
    );
  return id;
}
function requiredString(
  input: Record<string, unknown>,
  key: string,
  max: number,
): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new BrowserRuntimeError(
      "invalid_input",
      `${key} is required and must be at most ${max} characters`,
    );
  return value.trim();
}
function boundedPage(value: unknown): number {
  const page = typeof value === "number" ? value : Number(value ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > 20)
    throw new BrowserRuntimeError(
      "invalid_input",
      "Page must be an integer from 1 to 20",
    );
  return page;
}
function decodeCursor(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
    throw new BrowserRuntimeError("invalid_input", "Cursor is invalid");
  try {
    return Number(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new BrowserRuntimeError("invalid_input", "Cursor is invalid");
  }
}
function boundedQuantity(value: unknown): number {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10)
    throw new BrowserRuntimeError(
      "invalid_input",
      "Quantity must be an integer from 1 to 10",
    );
  return quantity;
}
function safeLineRef(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
    throw new BrowserRuntimeError(
      "invalid_input",
      "Cart line reference is invalid",
    );
  return value;
}
function restrictedCheckoutUrl(value: unknown): string {
  if (typeof value !== "string")
    throw new BrowserRuntimeError(
      "invalid_input",
      "A current Amazon checkout review URL is required",
    );
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.amazon.com" ||
    url.username ||
    url.password ||
    url.pathname !== "/checkout/p/review" ||
    url.search ||
    url.hash
  )
    throw new BrowserRuntimeError(
      "invalid_input",
      "Checkout URL must be the exact Amazon.com read-only checkout review page without credentials, query, or fragment",
    );
  return url.toString();
}
function requiredSellerId(input: Record<string, unknown>): string {
  const id = requiredString(input, "sellerId", 32).toUpperCase();
  if (!/^[A-Z0-9]{6,32}$/.test(id))
    throw new BrowserRuntimeError("invalid_input", "Seller ID is invalid");
  return id;
}
function categoryUrl(input: Record<string, unknown>): string {
  if (input.node === undefined) return "https://www.amazon.com/gp/bestsellers";
  const node = requiredString(input, "node", 24);
  if (!/^\d{1,20}$/.test(node))
    throw new BrowserRuntimeError(
      "invalid_input",
      "Category node must be a numeric Amazon browse node",
    );
  return `https://www.amazon.com/s?rh=n:${node}`;
}
function cartPostcondition(
  kind: string,
  before: Awaited<ReturnType<typeof extractCart>>,
  after: Awaited<ReturnType<typeof extractCart>>,
  lineRef: string,
  terms: Record<string, unknown>,
): boolean {
  if (!before.recognized || !after.recognized) return false;
  const prior = before.lines.find((line) => line.lineRef === lineRef);
  const current = after.lines.find((line) => line.lineRef === lineRef);
  if (!prior || !completeCartIdentity(prior)) return false;
  if (kind === "cart_remove")
    return (
      !current && !after.lines.some((line) => sameCartIdentity(line, prior))
    );
  if (kind === "cart_move") {
    const destination = terms.destination === "restore" ? "active" : "saved";
    return Boolean(
      current &&
      sameCartIdentity(current, prior) &&
      current.quantity === prior.quantity &&
      current.location === destination &&
      prior.location !== current.location,
    );
  }
  return Boolean(
    current &&
    sameCartIdentity(current, prior) &&
    current.location === prior.location &&
    current.quantity === boundedQuantity(terms.quantity),
  );
}
function completeCartIdentity(
  line: Awaited<ReturnType<typeof extractCart>>["lines"][number],
): boolean {
  return Boolean(
    line.lineRef &&
    line.asin &&
    line.sellerId &&
    line.condition &&
    line.purchaseMode &&
    line.location &&
    Number.isInteger(line.quantity) &&
    line.quantity! > 0,
  );
}
function completeCartReadIdentity(
  line: Awaited<ReturnType<typeof extractCart>>["lines"][number],
): boolean {
  return Boolean(line.lineRef && line.asin && line.title && line.location &&
    Number.isInteger(line.quantity) && line.quantity! > 0);
}
function sameCartIdentity(
  a: Awaited<ReturnType<typeof extractCart>>["lines"][number],
  b: Awaited<ReturnType<typeof extractCart>>["lines"][number],
): boolean {
  return (
    a.asin === b.asin &&
    a.sellerId === b.sellerId &&
    normalizeText(a.condition) === normalizeText(b.condition) &&
    a.purchaseMode === b.purchaseMode
  );
}
function observed(data: unknown, context: ProviderContext): Result {
  return {
    status: "ok",
    data,
    observation: {
      observedAt: new Date().toISOString(),
      source: "amazon-web",
      contextRef: context.accountRef,
    },
    coverage: { complete: true, missing: [] },
  };
}
function unknown(kind: string, data?: unknown): Result {
  return {
    status: "outcome_unknown",
    data,
    error: {
      code: `${kind}_postcondition_unverified`,
      retryable: false,
      message:
        "The browser action may have occurred, but its postcondition could not be verified. Reconcile before retrying.",
    },
  };
}
function unrecognizedCart(): Result {
  return {
    status: "failed",
    coverage: {
      complete: false,
      missing: ["required:cart_marker"],
      reason: "The visible page was not recognized as an Amazon cart",
    },
    error: { code: "cart_layout_unrecognized", retryable: false },
  };
}
function incompleteCartLine(
  line: Awaited<ReturnType<typeof extractCart>>["lines"][number],
): Result {
  const missing = [
    !line.lineRef && "lineRef",
    !line.asin && "asin",
    !line.sellerId && "sellerId",
    !line.condition && "condition",
    !Number.isInteger(line.quantity) && "quantity",
    !line.purchaseMode && "purchaseMode",
    !line.location && "location",
  ].filter(Boolean);
  return {
    status: "unsupported",
    coverage: {
      complete: false,
      missing: missing.map((field) => `required:cart_line_${field}`),
      reason: "The selected cart line lacks complete visible identity evidence",
    },
    error: { code: "cart_line_evidence_incomplete", retryable: false },
  };
}
function staleSession(actualGeneration: number): Result {
  return {
    status: "conflict",
    error: {
      code: "stale_session_generation",
      retryable: true,
      message: `Browser session is generation ${actualGeneration}; refresh account state before continuing`,
    },
  };
}
function normalizeText(value?: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}
function unsupported(kind: string): Result {
  return {
    status: "unsupported",
    error: {
      code: "unsupported_kind",
      retryable: false,
      message: `Amazon web provider does not implement ${kind}`,
    },
  };
}
function challengeResult(challenge: string, url: string): Result {
  return {
    status: "requires_user_action",
    action: { kind: challenge, url: safeUrl(url) },
    error: { code: `challenge_${challenge}`, retryable: false },
  };
}
function mapError(error: unknown): Result {
  if (error instanceof BrowserRuntimeError) {
    if (error.code.startsWith("challenge_"))
      return {
        status: "requires_user_action",
        action: { kind: error.code.slice(10) },
        error: { code: error.code, retryable: false, message: error.message },
      };
    return {
      status: "failed",
      error: {
        code: error.code,
        retryable: false,
        message: safeMessage(error.message),
      },
    };
  }
  return {
    status: "failed",
    error: {
      code: "layout_or_navigation_failed",
      retryable: false,
      message: safeMessage(
        error instanceof Error
          ? error.message
          : "Amazon page could not be read",
      ),
    },
  };
}
function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}
function safeMessage(value: string): string {
  return value
    .replace(/https:\/\/[^\s)]+/g, (raw) => safeUrl(raw) ?? "[redacted-url]")
    .slice(0, 300);
}
function missingCoverage(kind: string, data: any): string[] {
  const missing: string[] = [];
  const nonExhaustive = new Set([
    "products_search",
    "categories_browse",
    "products_related",
    "offers_list",
    "seller_feedback_list",
    "product_reviews_list",
    "product_media_list",
    "deals_search",
    "orders_list",
    "subscriptions_list",
    "shipments_get",
  ]);
  if (nonExhaustive.has(kind)) missing.push("source_completeness");
  if (kind === "products_search" && data.items.length === 0)
    missing.push("required:results");
  if (kind === "products_get") {
    for (const key of ["asin", "title", "price"])
      if (!data[key])
        missing.push(
          key === "asin" ? "required:product_identity" : `required:${key}`,
        );
    for (const key of ["rating", "reviewCount", "availability"])
      if (data[key] === undefined) missing.push(key);
  }
  if (kind === "products_variants" && !data.asin)
    missing.push("required:product_identity");
  if (
    [
      "products_related",
      "product_media_list",
      "offers_list",
      "product_reviews_list",
    ].includes(kind) &&
    !data.asin
  )
    missing.push("required:product_identity");
  if (kind === "offers_list" && data.offers.length === 0)
    missing.push("required:offers");
  if (kind === "product_reviews_list" && data.reviews.length === 0)
    missing.push("required:reviews");
  if (kind === "product_media_list" && data.media.length === 0)
    missing.push("required:media");
  if (kind === "sellers_get" && (!data.sellerId || !data.name))
    missing.push("required:seller_identity");
  if (kind === "cart_get" && !data.recognized)
    missing.push("required:cart_marker");
  if (
    kind === "cart_get" &&
    data.lines?.some(
      (line: Awaited<ReturnType<typeof extractCart>>["lines"][number]) =>
        !completeCartReadIdentity(line),
    )
  )
    missing.push("required:cart_line_identity");
  if (kind === "cart_get" && data.lines?.some(
    (line: Awaited<ReturnType<typeof extractCart>>["lines"][number]) => !completeCartIdentity(line),
  )) missing.push("cart_mutation_evidence");
  if (kind === "cart_get" && data.lines?.every(
    (line: Awaited<ReturnType<typeof extractCart>>["lines"][number]) => line.location !== "active",
  ) && !data.activeCartEmpty) missing.push("required:active_cart_state");
  if (kind === "orders_list" && !data.recognized)
    missing.push("required:orders_marker");
  if (kind === "orders_list" && data.unparsedCount > 0)
    missing.push("required:order_identity");
  if (kind === "orders_list" &&
    ((data.pagination?.currentPage !== undefined && data.pagination.currentPage !== data.requestedPage) ||
      (data.requestedPage > 1 && data.pagination?.currentPage === undefined)))
    missing.push("required:orders_page");
  if (kind === "orders_list" && data.orders?.some((order: any) => !order.date || !order.total || !order.lines?.length))
    missing.push("order_fields");
  if (kind === "orders_get" && !data.found)
    missing.push("required:order_identity");
  if (kind === "orders_get" && data.found && (!data.date || !data.total || !data.lines?.length))
    missing.push("order_fields");
  if (kind === "shipments_get" && !data.orderIdentityObserved)
    missing.push("required:order_identity");
  if (kind === "shipments_get" && data.orderIdentityObserved && !data.shipments?.length)
    missing.push("required:shipments");
  if (kind === "shipments_get" && data.shipments?.some((shipment: any) => shipment.trackingAvailable &&
    (!shipment.tracking?.recognized || !shipment.tracking?.orderIdentityObserved || !shipment.tracking?.status)))
    missing.push("tracking_details");
  if (kind === "subscriptions_list" && !data.recognized)
    missing.push("required:subscriptions_marker");
  if (kind === "subscriptions_list" && data.unparsedCount > 0)
    missing.push("required:subscription_identity");
  if (kind === "checkout_get" || kind === "checkout_prepare") {
    const quote = kind === "checkout_prepare" ? data.checkout : data;
    if (!quote?.recognized) missing.push("required:checkout_marker");
    for (const key of [
      "lines",
      "subtotal",
      "tax",
      "total",
      "addressRef",
      "paymentRef",
    ]) {
      if (
        !quote?.[key] ||
        (Array.isArray(quote[key]) && quote[key].length === 0)
      )
        missing.push(`required:${key}`);
    }
    if (
      quote?.lines?.some(
        (line: any) =>
          !line.asin ||
          !line.sellerId ||
          !line.condition ||
          !line.purchaseMode ||
          !line.price,
      )
    )
      missing.push("required:exact_line_terms");
  }
  return missing;
}
