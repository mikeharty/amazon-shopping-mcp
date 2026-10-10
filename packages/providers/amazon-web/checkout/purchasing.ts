import type { Locator, Page } from "playwright";
import type { ProviderContext, Result } from "../../../contracts/index.js";
import { BrowserRuntimeError, classifyPage, isVerifiedAuthenticatedAmazonPage } from "../../../browser-runtime/index.js";
import { commitKindFor, isReviewUrl, purchaseTermsSchema, type PurchaseTerms } from "../../../core/purchasing.js";
import { digest } from "../../../store/crypto.js";
import { extractCart } from "../cart/index.js";
import { extractOrder, extractOrders } from "../orders/index.js";
import { extractSubscriptions } from "../subscriptions/index.js";
import { money } from "../types.js";
import { extractCheckout } from "./index.js";

const unsupported = (code: string, missing?: string[]): Result => ({ status: "unsupported", error: { code, retryable: false }, ...(missing ? { coverage: { complete: false, missing } } : {}) });
const conflict = (code: string): Result => ({ status: "conflict", error: { code, retryable: false } });
const unknown = (): Result => ({ status: "outcome_unknown", error: { code: "PURCHASE_OUTCOME_UNKNOWN", retryable: false }, data: { instructions: "Reconcile Amazon orders and subscriptions before any new purchase. Do not retry this operation." } });
function purchaseMoney(value?: string | null, discount = false) {
  if (!value) return undefined;
  const normalized = value.replace(/,/g, "").trim();
  const unsigned = discount ? normalized.replace(/^-/, "").replace(/^(US\$|\$)\s*-/, "$1") : normalized;
  if (!/^(?:(?:US\$|\$)\s*\d+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*USD)$/i.test(unsigned)) return undefined;
  return money(unsigned);
}

async function checkPage(page: Page) {
  const state = await classifyPage(page);
  if (state.kind === "challenge") throw new BrowserRuntimeError(`challenge_${state.challenge}`, state.message);
  if (!await isVerifiedAuthenticatedAmazonPage(page)) throw new BrowserRuntimeError("challenge_signin", "Sign in in the dedicated Amazon browser");
  const paymentChallenges = page.locator('input[autocomplete="cc-csc"], input[name="cvv"], input[name="verificationCode"]');
  for (let index = 0; index < await paymentChallenges.count(); index++)
    if (await paymentChallenges.nth(index).isVisible()) throw new BrowserRuntimeError("challenge_payment", "Complete payment authentication in the dedicated Amazon browser");
}
async function navigate(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await checkPage(page);
}

export async function buyingOptions(page: Page, asin: unknown): Promise<Result> {
  if (typeof asin !== "string" || !/^[A-Z0-9]{10}$/.test(asin)) return unsupported("invalid_asin");
  await navigate(page, `https://www.amazon.com/dp/${asin}`);
  const data = await inspectProduct(page);
  if (data.asin !== asin) return conflict("wrong_product_identity");
  return { status: "ok", data, observation: { source: "amazon-web", observedAt: new Date().toISOString(), contextRef: "product", authentication: "verified" } };
}

async function inspectProduct(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const text = (selector: string) => Array.from(document.querySelectorAll(selector)).find(visible)?.textContent?.replace(/\s+/g, " ").trim();
    const seller = document.querySelector<HTMLAnchorElement>('#sellerProfileTriggerId[href*="seller="]');
    const modes = Array.from(document.querySelectorAll<HTMLElement>('[data-purchase-mode], #onetimePurchase, #subscribeAndSave'))
      .filter(visible).map((el) => ({ mode: el.dataset.purchaseMode ?? (el.id === "onetimePurchase" ? "one_time" : "subscribe_and_save"), selected: el.getAttribute("aria-checked") === "true" || Boolean(el.querySelector<HTMLInputElement>('input:checked')) }));
    const frequency = Array.from(document.querySelectorAll<HTMLSelectElement>('#sns-frequency, #rcx-subscribeFrequency, select[name="snsFrequency"]')).find(visible);
    return {
      asin: document.querySelector<HTMLInputElement>("#ASIN")?.value,
      title: text("#productTitle"),
      sellerId: seller && visible(seller) ? new URL(seller.href).searchParams.get("seller")?.toUpperCase() : undefined,
      condition: text("#condition, #newAccordionRow .a-color-base, #usedAccordionRow .a-color-base"),
      modes,
      frequencies: frequency ? Array.from(frequency.options).filter((option) => !option.disabled && option.value).map((option) => ({ value: option.value, label: option.textContent?.trim() })) : [],
    };
  });
}

// Inspect only rendered controls. A preparation may enter a review page but
// cannot use an instant-order endpoint or a final purchase button.
async function reviewControl(control: Locator): Promise<boolean> {
  if (await control.count() !== 1 || !await control.isVisible() || !await control.isEnabled()) return false;
  return control.evaluate((element) => {
    const el = element as HTMLInputElement;
    const form = el.form ?? el.closest("form");
    const destination = el.getAttribute("formaction") ?? form?.getAttribute("action") ?? (element as HTMLAnchorElement).getAttribute("href");
    if (!destination) return false;
    const url = new URL(destination, location.href);
    const label = (el.value || element.textContent || el.getAttribute("aria-label") || "").trim();
    return url.origin === "https://www.amazon.com" && !url.username && !url.password && !url.hash &&
      ["/checkout/entry/buynow", "/checkout/entry/cart", "/checkout/entry/sns", "/checkout/p/review", "/gp/buy/spc/handlers/display.html"].includes(url.pathname) &&
      [...url.searchParams.keys()].every((key) => ["ref", "ref_", "pipelineType", "hasWorkingJavascript", "asin", "quantity", "offeringID", "frequency"].includes(key)) &&
      !el.hasAttribute("onclick") && !form?.hasAttribute("onsubmit") &&
      !/place (?:your )?order|confirm (?:your )?(?:order|subscription)|subscribe now|1.click/i.test(label);
  });
}

export async function preparePurchase(page: Page, kind: string, input: Record<string, unknown>, context: ProviderContext): Promise<Result> {
  let flow: PurchaseTerms["flow"] = "cart";
  if (kind === "checkout_prepare") {
    if (input.url !== undefined) {
      if (typeof input.url !== "string" || !isReviewUrl(input.url)) return unsupported("invalid_review_url");
      await navigate(page, input.url);
      if ((await extractCheckout(page)).revision !== input.expectedRevision) return conflict("stale_checkout");
    } else {
      await navigate(page, "https://www.amazon.com/gp/cart/view.html");
      const cart = await extractCart(page);
      if (!cart.recognized || cart.lines.some((line) => line.location === "active" && line.purchaseMode !== "one_time")) return unsupported("cart_checkout_evidence_missing");
      if (cart.revision !== input.expectedRevision) return conflict("stale_cart");
      const control = page.locator('input[name="proceedToRetailCheckout"], button[name="proceedToRetailCheckout"], #sc-buy-box-ptc-button input');
      if (!await reviewControl(control)) return unsupported("checkout_review_control_unavailable");
      await control.click({ timeout: 5_000 });
      await page.waitForURL((url) => isReviewUrl(url.toString()), { waitUntil: "domcontentloaded", timeout: 10_000 });
      await checkPage(page);
    }
  } else {
    flow = kind === "subscriptions_prepare" ? "subscribe_and_save" : "buy_now";
    const options = await buyingOptions(page, input.asin);
    if (options.status !== "ok") return options;
    const requestedMode = flow === "buy_now" ? "one_time" : "subscribe_and_save";
    const mode = page.locator(`[data-purchase-mode="${requestedMode}"] input[type="radio"], ${flow === "buy_now" ? "#onetimePurchase" : "#subscribeAndSave"} input[type="radio"]`);
    if (await mode.count() === 1) await mode.check({ timeout: 5_000 });
    const observed = await inspectProduct(page);
    if (observed.sellerId !== input.expectedSellerId || observed.condition !== input.expectedCondition) return conflict("offer_changed");
    if (observed.modes.filter((item) => item.selected).length !== 1 || !observed.modes.some((item) => item.selected && item.mode === requestedMode)) return unsupported("purchase_mode_not_observed");
    const quantity = page.locator("#quantity");
    if (await quantity.count() !== 1) return unsupported("quantity_control_unavailable");
    await quantity.selectOption(String(input.quantity), { timeout: 5_000 });
    if (await quantity.inputValue() !== String(input.quantity)) return conflict("quantity_not_selected");
    if (flow === "subscribe_and_save") {
      if (!observed.frequencies.some((option) => option.value === input.frequency)) return unsupported("frequency_unavailable");
      const select = page.locator('#sns-frequency, #rcx-subscribeFrequency, select[name="snsFrequency"]');
      if (await select.count() !== 1) return unsupported("frequency_control_unavailable");
      await select.selectOption(String(input.frequency), { timeout: 5_000 });
      if (await select.inputValue() !== input.frequency) return conflict("frequency_not_selected");
    }
    const control = page.locator(flow === "buy_now" ? "#buy-now-button" : '#sns-review-button, input[name="snsReview"]');
    if (!await reviewControl(control)) return unsupported("safe_review_control_unavailable");
    await control.click({ timeout: 5_000 });
    await page.waitForURL((url) => isReviewUrl(url.toString()), { waitUntil: "domcontentloaded", timeout: 10_000 });
    await checkPage(page);
  }
  if (!isReviewUrl(page.url())) return unsupported("review_page_unavailable");
  const quote = await purchaseQuote(page, flow);
  if (quote.status !== "ok") return quote;
  const terms = quote.data as PurchaseTerms;
  if (flow !== "cart" && (terms.lines.length !== 1 || terms.lines[0]!.asin !== input.asin || terms.lines[0]!.sellerId !== input.expectedSellerId || terms.lines[0]!.condition !== input.expectedCondition || terms.lines[0]!.quantity !== input.quantity)) return conflict("review_item_changed");
  if (flow === "subscribe_and_save" && terms.recurring?.frequencyRef !== input.frequency) return conflict("review_frequency_changed");
  if (!await finalControl(page, terms)) return unsupported("final_purchase_control_unavailable");
  return { status: "ok", data: { purchaseTerms: terms, commitKind: commitKindFor(terms) }, observation: { source: "amazon-web", observedAt: new Date().toISOString(), contextRef: context.accountRef, authentication: "verified" } };
}

export async function purchaseQuote(page: Page, flow: PurchaseTerms["flow"]): Promise<Result> {
  await checkPage(page);
  const raw = await page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const root = Array.from(document.querySelectorAll<HTMLElement>('#checkout-review, [data-testid="checkout-review"], #spc')).find(visible);
    if (!root) return undefined;
    const elements = (selector: string) => Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(visible);
    const text = (selector: string) => elements(selector)[0]?.textContent?.replace(/\s+/g, " ").trim();
    const rows = elements('.order-summary-line-item, [data-testid="checkout-line"], .spc-item, .item-row, .a-fixed-left-grid')
      .filter((el) => !el.parentElement?.closest('.order-summary-line-item, [data-testid="checkout-line"], .spc-item, .item-row, .a-fixed-left-grid'));
    const lines = rows.map((el) => {
      const value = (selector: string) => Array.from(el.querySelectorAll<HTMLElement>(selector)).find(visible)?.textContent?.replace(/\s+/g, " ").trim();
      const link = el.querySelector<HTMLAnchorElement>('a[href*="/dp/"]');
      const seller = el.querySelector<HTMLAnchorElement>('a[href*="seller="]');
      const quantity = el.dataset.quantity ?? value('.quantity, [data-testid="quantity"]')?.match(/(?:Qty:\s*)?(\d+)/i)?.[1] ?? el.textContent?.match(/Qty:\s*(\d+)/i)?.[1];
      return {
        asin: el.dataset.asin ?? link?.href.match(/\/dp\/([A-Z0-9]{10})/i)?.[1],
        title: value('.item-title, .a-truncate-cut, h4'),
        sellerId: el.dataset.sellerId ?? (seller && visible(seller) ? new URL(seller.href).searchParams.get("seller") : undefined),
        sellerName: value('.seller-name') ?? (seller && visible(seller) ? seller.textContent?.trim() : undefined),
        condition: el.dataset.condition ?? value('.condition') ?? el.innerText.match(/Condition:\s*(New|Used[^\n]*|Renewed)/i)?.[1],
        quantity: quantity ? Number(quantity) : undefined,
        purchaseMode: el.dataset.purchaseMode ?? (/(?:one.time purchase)/i.test(el.innerText) ? "one_time" : /subscribe (?:&|and) save/i.test(el.innerText) ? "subscribe_and_save" : undefined),
        price: value('.unit-price .a-offscreen, .a-price .a-offscreen, .a-color-price'),
      };
    });
    const address = elements('[data-address-ref], #shipping-address-summary, .displayAddressDiv')[0];
    const payment = elements('[data-payment-ref], #payment-information')[0];
    const groups = elements('.shipment, [data-shipment-index], .spc-order, .shipping-group').map((el, index) => ({
      ref: el.dataset.shipmentIndex ?? `group-${index + 1}`,
      delivery: Array.from(el.querySelectorAll('.delivery-date, .a-color-success')).find(visible)?.textContent?.trim(),
      speed: Array.from(el.querySelectorAll('.shipping-speed, input[type="radio"]:checked')).find(visible)?.getAttribute("value") ?? el.querySelector('.shipping-speed')?.textContent?.trim(),
      asins: rows.filter((row) => el.contains(row)).map((row) => row.dataset.asin ?? row.querySelector<HTMLAnchorElement>('a[href*="/dp/"]')?.href.match(/\/dp\/([A-Z0-9]{10})/i)?.[1]),
    }));
    const recurring = elements('#sns-terms, #sns-review, .sns-summary, [data-testid="subscription-terms"]')[0];
    const sns = (selector: string) => recurring ? Array.from(recurring.querySelectorAll(selector)).find(visible)?.textContent?.replace(/\s+/g, " ").trim() : undefined;
    const frequencySelect = recurring ? Array.from(recurring.querySelectorAll<HTMLSelectElement>('#sns-frequency, #rcx-subscribeFrequency, select[name="snsFrequency"]')).find(visible) : undefined;
    const selectedFrequency = frequencySelect?.selectedOptions[0];
    const initialOrderPolicy = sns('.initial-order-policy');
    const labeledTotal = (label: RegExp) => {
      const matches = elements('#subtotals-marketplace-table tr').filter((row) => label.test(row.querySelector('td, th')?.textContent?.trim() ?? ""));
      return matches.length === 1 ? matches[0]!.lastElementChild?.textContent?.trim() : undefined;
    };
    return {
      lines, subtotal: text('#subtotal, [data-testid="subtotal"], .order-summary-line-definition') ?? labeledTotal(/^Items(?: \(\d+\))?:$/i),
      shipping: text('#shipping-total, [data-testid="shipping-total"]') ?? labeledTotal(/^Shipping (?:&|and) handling:$/i),
      tax: text('#tax-total, [data-testid="tax-total"]') ?? labeledTotal(/^(?:Estimated )?tax(?: to be collected)?:$/i), discount: text('#discount-total, [data-testid="discount-total"]') ?? labeledTotal(/^(?:Discounts|Promotion(?:s)? applied):$/i),
      total: text('#orderTotalPrimaryText, [data-testid="order-total"]') ?? labeledTotal(/^Order total:$/i),
      address: { ref: address?.dataset.addressRef, summary: address?.textContent?.replace(/\s+/g, " ").trim() },
      payment: { ref: payment?.dataset.paymentRef, summary: payment?.textContent?.replace(/\s+/g, " ").trim() },
      shippingGroups: groups,
      promotions: elements('.promotion-description').map((el) => el.textContent?.trim()),
      warnings: elements('.a-alert-content').map((el) => el.textContent?.trim()),
      recurring: recurring ? {
        frequencyRef: recurring.dataset.frequencyRef ?? selectedFrequency?.value, frequency: sns('.frequency') ?? selectedFrequency?.textContent?.trim(), nextDelivery: sns('.next-delivery, .sns-next-delivery'), discount: sns('.sns-discount, .sns-discount-text'),
        futurePricePolicy: sns('.future-price-policy, .sns-price-disclaimer'),
        createsImmediateOrder: recurring.dataset.createsImmediateOrder === "true" ? true : recurring.dataset.createsImmediateOrder === "false" ? false : /^an initial order will be placed today\.?$/i.test(initialOrderPolicy ?? "") ? true : /^no initial order will be placed\.?$/i.test(initialOrderPolicy ?? "") ? false : undefined,
      } : undefined,
    };
  });
  if (!raw) return unsupported("checkout_layout_unrecognized");
  const parsed = purchaseTermsSchema.safeParse({
    ...raw, schemaVersion: 1, flow, reviewUrl: page.url(),
    lines: raw.lines.map(({ price, ...line }) => ({ ...line, unitPrice: purchaseMoney(price) })),
    subtotal: purchaseMoney(raw.subtotal), shipping: purchaseMoney(raw.shipping), tax: purchaseMoney(raw.tax), discount: purchaseMoney(raw.discount, true), total: purchaseMoney(raw.total),
    address: { ...raw.address, ref: raw.address.ref ?? digest({ summary: raw.address.summary }), fingerprint: digest(raw.address) },
    payment: { ...raw.payment, ref: raw.payment.ref ?? digest({ summary: raw.payment.summary }), summary: maskPayment(raw.payment.summary), fingerprint: digest(raw.payment) },
  });
  if (!parsed.success) return unsupported("purchase_terms_incomplete", parsed.error.issues.map((issue) => `${issue.path.join(".") || "terms"}: ${issue.message}`));
  // Material terms use exactly the JSON representation persisted by the journal.
  // Optional undefined properties must not change their digest after encryption.
  return { status: "ok", data: JSON.parse(JSON.stringify(parsed.data)) as PurchaseTerms };
}
function maskPayment(value?: string) {
  const brand = value?.match(/\b(Visa|Mastercard|Amex|American Express|Discover)\b/i)?.[0];
  const last = value?.match(/(?:ending in|last four|\*{2,})\s*(\d{4})/i)?.[1];
  return brand && last ? `${brand} ending in ${last}` : undefined;
}

async function finalControl(page: Page, terms: PurchaseTerms): Promise<Locator | undefined> {
  const controls = page.locator('#placeYourOrder input[type="submit"], input[name="placeYourOrder1"], #place-your-order-button, #sns-confirm-button');
  const visible: Locator[] = [];
  for (let index = 0; index < await controls.count(); index++) if (await controls.nth(index).isVisible()) visible.push(controls.nth(index));
  if (visible.length !== 1 || !await visible[0]!.isEnabled()) return undefined;
  const valid = await visible[0]!.evaluate((element, subscription) => {
    const el = element as HTMLInputElement;
    const form = el.form ?? el.closest("form");
    const action = el.getAttribute("formaction") ?? form?.getAttribute("action");
    if (!action || (el.getAttribute("formmethod") ?? form?.getAttribute("method"))?.toLowerCase() !== "post") return false;
    const url = new URL(action, location.href);
    const label = (el.value || element.textContent || el.getAttribute("aria-label") || "").trim();
    return url.origin === "https://www.amazon.com" && !url.username && !url.password && !url.hash &&
      ["/checkout/spc/place-order", "/checkout/p/spc/submit", "/gp/buy/thankyou/handlers/display.html", ...(subscription ? ["/gp/subscribe-and-save/confirm"] : [])].includes(url.pathname) &&
      [...url.searchParams.keys()].every((key) => ["ref", "ref_", "purchaseId", "checkoutSessionId"].includes(key)) &&
      !el.hasAttribute("onclick") && !form?.hasAttribute("onsubmit") &&
      (subscription ? /^(?:subscribe|subscribe and save|confirm subscription|place your order and subscribe)$/i : /^place (?:your )?order$/i).test(label);
  }, terms.flow === "subscribe_and_save");
  return valid ? visible[0] : undefined;
}

export async function readPurchasePreconditions(page: Page, input: Record<string, unknown>): Promise<Result> {
  const parsed = purchaseTermsSchema.safeParse(input);
  if (!parsed.success) return unsupported("invalid_purchase_terms");
  await navigate(page, parsed.data.reviewUrl);
  return purchaseQuote(page, parsed.data.flow);
}

export async function submitPurchase(page: Page, kind: string, input: Record<string, unknown>, context: ProviderContext): Promise<Result> {
  const parsed = purchaseTermsSchema.safeParse(input);
  if (!parsed.success || commitKindFor(parsed.data) !== kind) return unsupported("invalid_purchase_terms");
  const terms = parsed.data;
  // Capture existing identities before dispatch; an old confirmation is never
  // sufficient proof of a new order or enrollment.
  await navigate(page, "https://www.amazon.com/gp/your-account/order-history");
  const history = await extractOrders(page);
  if (!history.recognized || history.unparsedCount) return unsupported("order_reconciliation_baseline_missing");
  if (!history.orders.length && !await page.locator("#ordersContainer").evaluateAll((nodes) => nodes.some((node) => (node as HTMLElement).getClientRects().length > 0 && /(?:you (?:haven't|have not) placed any orders|no orders)/i.test((node as HTMLElement).innerText))))
    return unsupported("order_reconciliation_baseline_missing");
  const priorOrders = new Set(history.orders.map((order) => order.orderId));
  let priorSubscriptions = new Set<string>();
  if (terms.recurring) {
    await navigate(page, "https://www.amazon.com/gp/subscribe-and-save/manager/viewsubscriptions");
    const before = await extractSubscriptions(page);
    if (!before.recognized || before.unparsedCount) return unsupported("subscription_reconciliation_baseline_missing");
    if (!before.subscriptions.length && !await page.locator("#subscriptions-container, #subscriptionsDesktopGridLayout").evaluateAll((nodes) => nodes.some((node) => (node as HTMLElement).getClientRects().length > 0 && /(?:you (?:don't|do not) have any|no active) subscriptions/i.test((node as HTMLElement).innerText))))
      return unsupported("subscription_reconciliation_baseline_missing");
    priorSubscriptions = new Set(before.subscriptions.map((item) => item.subscriptionRef!));
  }
  await navigate(page, terms.reviewUrl);
  const fresh = await purchaseQuote(page, terms.flow);
  if (fresh.status !== "ok" || digest(fresh.data) !== digest(terms)) return conflict("TERMS_CHANGED_OR_UNVERIFIED");
  const control = await finalControl(page, terms);
  if (!control) return unsupported("final_purchase_control_unavailable");
  if (!context.intentExpiresAt || !Number.isFinite(Date.parse(context.intentExpiresAt)) || Date.parse(context.intentExpiresAt) <= Date.now()) return conflict("STALE_INTENT");
  try {
    // After this boundary every failure is uncertain, including a click timeout
    // or payment challenge. The journal quarantines subsequent writes.
    await control.click({ timeout: 5_000, noWaitAfter: true });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector('#thank-you, #order-confirmation, [data-testid="order-confirmation"], #subscription-confirmation', { timeout: 10_000 });
    await checkPage(page);
    const confirmation = await page.evaluate(() => {
      const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const root = Array.from(document.querySelectorAll<HTMLElement>('#thank-you, #order-confirmation, [data-testid="order-confirmation"], #subscription-confirmation')).find(visible);
      if (!root) return undefined;
      const ids = [...new Set((root.innerText.match(/\b\d{3}-\d{7}-\d{7}\b/g) ?? []))];
      return { orderIds: ids, subscriptionRef: root.dataset.subscriptionId };
    });
    if (!confirmation || confirmation.orderIds.some((id) => priorOrders.has(id)) || confirmation.orderIds.length > 10) return unknown();
    const needsOrder = !terms.recurring || terms.recurring.createsImmediateOrder;
    if (needsOrder !== (confirmation.orderIds.length > 0)) return unknown();
    const observedLines: PurchaseTerms["lines"] = [];
    let total = 0;
    for (const id of confirmation.orderIds) {
      await navigate(page, `https://www.amazon.com/gp/your-account/order-details?orderID=${id}`);
      const order = await extractOrder(page, id);
      if (!order.found || !("total" in order) || !order.total) return unknown();
      const totalText = await page.locator('#orderDetails #od-subtotals .od-line-item-row').evaluateAll((rows) => {
        const matching = rows.filter((row) => (row as HTMLElement).getClientRects().length > 0 && /^grand total:$/i.test(row.querySelector('.od-line-item-row-label')?.textContent?.trim() ?? ""));
        return matching.length === 1 ? matching[0]!.querySelector('.od-line-item-row-content')?.textContent?.trim() : undefined;
      });
      const verifiedTotal = purchaseMoney(totalText);
      if (!verifiedTotal) return unknown();
      total += verifiedTotal.minorUnits;
      const lines = await page.evaluate(() => {
        const root = document.querySelector("#orderDetails");
        const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
        return Array.from(root?.querySelectorAll<HTMLElement>('.order-item, [data-testid="purchased-line"]') ?? []).filter(visible).map((el) => ({
          asin: el.dataset.asin, title: el.querySelector('.item-title, a[href*="/dp/"]')?.textContent?.trim(), sellerId: el.dataset.sellerId,
          condition: el.dataset.condition, quantity: el.dataset.quantity ? Number(el.dataset.quantity) : undefined,
          purchaseMode: el.dataset.purchaseMode, price: el.querySelector('.a-price .a-offscreen')?.textContent?.trim(),
        }));
      });
      for (const { price, ...line } of lines) {
        const lineParsed = purchaseTermsSchema.shape.lines.element.safeParse({ ...line, unitPrice: purchaseMoney(price) });
        if (!lineParsed.success) return unknown();
        observedLines.push(lineParsed.data);
      }
    }
    if (needsOrder && (total !== terms.total.minorUnits || !sameItems(observedLines, terms.lines))) return unknown();
    if (terms.recurring) {
      const ref = confirmation.subscriptionRef;
      if (!ref || priorSubscriptions.has(ref)) return unknown();
      await navigate(page, "https://www.amazon.com/gp/subscribe-and-save/manager/viewsubscriptions");
      const observed = await page.evaluate((ref) => {
        const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-subscription-id]')).filter((el) => el.dataset.subscriptionId === ref && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
        if (nodes.length !== 1) return undefined;
        const el = nodes[0]!;
        return { asin: el.dataset.asin, sellerId: el.dataset.sellerId, quantity: Number(el.dataset.quantity), frequencyRef: el.dataset.frequencyRef, frequency: el.querySelector('.frequency')?.textContent?.trim(), nextDelivery: el.querySelector('.next-delivery')?.textContent?.trim() };
      }, ref);
      if (!observed || observed.asin !== terms.lines[0]!.asin || observed.sellerId !== terms.lines[0]!.sellerId || observed.quantity !== terms.lines[0]!.quantity || observed.frequencyRef !== terms.recurring.frequencyRef || observed.frequency !== terms.recurring.frequency || observed.nextDelivery !== terms.recurring.nextDelivery) return unknown();
    }
    return { status: "ok", data: { orderIds: confirmation.orderIds, ...(terms.recurring ? { subscriptionRef: confirmation.subscriptionRef } : {}), verified: true }, observation: { source: "amazon-web", observedAt: new Date().toISOString(), contextRef: context.accountRef, authentication: "verified" } };
  } catch { return unknown(); }
}
function sameItems(actual: PurchaseTerms["lines"], expected: PurchaseTerms["lines"]) {
  const identity = (line: PurchaseTerms["lines"][number]) => ({ asin: line.asin, sellerId: line.sellerId, condition: line.condition, purchaseMode: line.purchaseMode, unitPrice: line.unitPrice });
  return actual.length > 0 && actual.every((line) => expected.some((item) => digest(identity(item)) === digest(identity(line)))) && expected.every((item) => actual.filter((line) => digest(identity(item)) === digest(identity(line))).reduce((sum, line) => sum + line.quantity, 0) === item.quantity);
}
