import type { Locator, Page, Request } from "playwright";
import { isModernReviewUrl } from "../../../core/purchasing.js";
import { classifyPage } from "../../../browser-runtime/index.js";

export type ModernProductOffer = Readonly<{
  asin: string;
  sellerId: string;
  quantity: 1;
  unitPrice: Readonly<{ currency: "USD"; minorUnits: number }>;
  condition: "New";
  purchaseMode: "one_time";
  offerTokenHash: string;
  evidenceSource: "native_buyNow_regular_offerActions_new";
}>;
export type NativeModernEntry = Readonly<{
  checkoutURL: string;
  offer: ModernProductOffer;
}>;
const observedOffers = new WeakSet<object>();
const observedEntries = new WeakSet<object>();
export const isObservedNativeModernEntry = (entry: NativeModernEntry) =>
  observedEntries.has(entry);
export const consumeObservedNativeModernEntry = (entry: NativeModernEntry) =>
  observedEntries.delete(entry);

export function modernCheckoutIdentity(value: string): string | undefined {
  try {
    const url = new URL(value);
    const normalized = new URL(value);
    if (
      !/^\/checkout\/p\/p-\d{3}-\d{7}-\d{7}\/(?:address|spc)$/.test(
        url.pathname,
      )
    )
      return undefined;
    normalized.pathname = normalized.pathname.replace(
      /\/(?:address|spc)$/,
      "/spc",
    );
    if (
      !isModernReviewUrl(normalized.toString()) ||
      url.searchParams.get("pipelineType") !== "Chewbacca" ||
      url.searchParams.get("isBuyNow") !== "1"
    )
      return undefined;
    return JSON.stringify({
      path: normalized.pathname,
      routing: [
        "pipelineType",
        "isBuyNow",
        "purchaseId",
        "checkoutSessionId",
      ].map((key) => [key, url.searchParams.getAll(key)]),
    });
  } catch {
    return undefined;
  }
}

/** Read the selected native regular/New form; APEX and unrelated state are excluded. */
export async function getModernProductOffer(
  page: Page,
): Promise<{ offer: ModernProductOffer; control: Locator } | undefined> {
  const controls = page.locator('input#buy-now-button[name="submit.buy-now"]');
  const active: Locator[] = [];
  for (let index = 0; index < (await controls.count()); index++)
    if (
      (await controls.nth(index).isVisible()) &&
      (await controls.nth(index).isEnabled())
    )
      active.push(controls.nth(index));
  if (active.length !== 1) return undefined;
  const raw = await active[0]!.evaluate(async (element) => {
    const visible = (el: Element) =>
      (el as HTMLElement).getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== "hidden";
    if (
      !(element instanceof HTMLInputElement) ||
      element.type !== "submit" ||
      !element.form ||
      element.form.id !== "addToCart" ||
      element.closest("form") !== element.form
    )
      return undefined;
    const form = element.form;
    const row = element.closest(".accordion-atc-group-row");
    if (!row || !form.contains(row) || !visible(row)) return undefined;
    // Metadata wrappers may have no layout box (for example display:contents).
    // The native control and its offer row separately require positive visibility.
    const activeAncestors = (el: Element) => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (
          node.matches(
            'template,[hidden],[aria-hidden="true"],[aria-selected="false"],[aria-expanded="false"],[data-selected="false"],[data-active="false"]',
          ) ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse"
        )
          return false;
        if (node === form) return true;
      }
      return false;
    };
    const features = Array.from(
      form.querySelectorAll<HTMLElement>("[data-feature-name]"),
    ).filter(
      (node) =>
        /^buyNow_/i.test(node.getAttribute("data-feature-name") ?? "") &&
        /offerActions|subscribe|sns/i.test(
          node.getAttribute("data-feature-name") ?? "",
        ) &&
        activeAncestors(node),
    );
    if (
      features.length !== 1 ||
      features[0]!.id !== "buyNow_regular_offerActions_new_feature_div" ||
      features[0]!.getAttribute("data-feature-name") !==
        "buyNow_regular_offerActions_new" ||
      !row.contains(features[0]!)
    )
      return undefined;
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.getAttributeNames().some((name) => /^on/i.test(name)))
        return undefined;
      if (node === form) break;
    }
    const field = (name: string) => {
      const found = Array.from(form.elements).filter(
        (el) => el instanceof HTMLInputElement && el.name === name,
      ) as HTMLInputElement[];
      return found.length === 1 &&
        found[0]!.type === "hidden" &&
        !found[0]!.disabled
        ? found[0]!.value
        : undefined;
    };
    const asin = field("items[0.base][asin]"),
      sellerId = field("merchantID"),
      amount = field("items[0.base][customerVisiblePrice][amount]"),
      currency = field("items[0.base][customerVisiblePrice][currencyCode]"),
      quantity = field("items[0.base][quantity]"),
      token = field("items[0.base][offerListingId]");
    if (
      !asin ||
      !/^[A-Z0-9]{10}$/.test(asin) ||
      !sellerId ||
      !/^[A-Z0-9]{6,32}$/.test(sellerId) ||
      currency !== "USD" ||
      quantity !== "1" ||
      field("isBuyNow") !== "1" ||
      !amount ||
      !/^\d+(?:\.\d{1,2})?$/.test(amount) ||
      !token?.trim() ||
      token.length > 8192
    )
      return undefined;
    const current = new URL(location.href);
    if (
      current.origin !== "https://www.amazon.com" ||
      current.username ||
      current.password ||
      !new RegExp(
        `^/(?:dp|gp/product)/${asin}(?:/ref=[A-Za-z0-9_.-]+)?/?$`,
      ).test(current.pathname)
    )
      return undefined;
    const method =
      element.getAttribute("formmethod") ?? form.getAttribute("method");
    const action = element.hasAttribute("formaction")
      ? element.formAction
      : form.action;
    let destination: URL;
    try {
      destination = new URL(action);
    } catch {
      return undefined;
    }
    if (
      method?.toLowerCase() !== "post" ||
      destination.origin !== "https://www.amazon.com" ||
      destination.username ||
      destination.password ||
      destination.hash ||
      destination.pathname !== "/checkout/entry/buynow" ||
      [...destination.searchParams.keys()].some(
        (key) =>
          key !== "asin" || destination.searchParams.getAll(key).length !== 1,
      ) ||
      destination.searchParams.get("asin") !== asin
    )
      return undefined;
    if (
      (element.getAttribute("formtarget") ??
        form.getAttribute("target") ??
        "_self") !== "_self" ||
      /place\s*(?:your\s*)?order|subscribe|1[ .-]?click/i.test(
        [element.value, element.getAttribute("aria-label"), element.title].join(
          " ",
        ),
      )
    )
      return undefined;
    const decimal = amount.split(".");
    const minorUnits =
      Number(decimal[0]) * 100 + Number((decimal[1] ?? "").padEnd(2, "0"));
    if (
      !Number.isSafeInteger(minorUnits) ||
      minorUnits <= 0 ||
      minorUnits > 100_000_000
    )
      return undefined;
    const hashed = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(token),
    );
    return {
      asin,
      sellerId,
      minorUnits,
      offerTokenHash: Array.from(new Uint8Array(hashed))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };
  });
  if (!raw) return undefined;
  const offer: ModernProductOffer = Object.freeze({
    asin: raw.asin,
    sellerId: raw.sellerId,
    quantity: 1,
    unitPrice: Object.freeze({ currency: "USD", minorUnits: raw.minorUnits }),
    condition: "New",
    purchaseMode: "one_time",
    offerTokenHash: raw.offerTokenHash,
    evidenceSource: "native_buyNow_regular_offerActions_new",
  });
  observedOffers.add(offer);
  return { offer, control: active[0]! };
}

/** The only issuer of origin capabilities: fresh native inspection plus observed POST/navigation. */
export async function enterModernProductCheckout(
  page: Page,
  expected: ModernProductOffer,
): Promise<NativeModernEntry | undefined> {
  if (!observedOffers.has(expected)) return undefined;
  const fresh = await getModernProductOffer(page);
  if (!fresh || JSON.stringify(fresh.offer) !== JSON.stringify(expected))
    return undefined;
  let submitted = false;
  const onRequest = (request: Request) => {
    try {
      const url = new URL(request.url());
      if (
        request.frame() === page.mainFrame() &&
        request.isNavigationRequest() &&
        request.method() === "POST" &&
        url.origin === "https://www.amazon.com" &&
        !url.username &&
        !url.password &&
        url.pathname === "/checkout/entry/buynow" &&
        url.searchParams.getAll("asin").length === 1 &&
        url.searchParams.get("asin") === fresh.offer.asin
      )
        submitted = true;
    } catch {
      /* Outside this native navigation. */
    }
  };
  page.on("request", onRequest);
  try {
    await fresh.control.click({ timeout: 5000 });
    await page.waitForURL(
      (url) =>
        Boolean(modernCheckoutIdentity(url.toString())) ||
        /\/ap\//.test(url.pathname),
      { waitUntil: "domcontentloaded", timeout: 10000 },
    );
    if (
      !submitted ||
      !modernCheckoutIdentity(page.url()) ||
      (await classifyPage(page)).kind !== "ready"
    )
      return undefined;
    const auth = await page
      .locator(
        'input[type="password"], input[name="email"], input[name="otpCode"], input[name="cvv"]',
      )
      .evaluateAll((els) =>
        els.some(
          (el) =>
            (el as HTMLElement).getClientRects().length > 0 &&
            getComputedStyle(el).visibility !== "hidden",
        ),
      );
    if (auth) return undefined;
    const entry = Object.freeze({
      checkoutURL: page.url(),
      offer: fresh.offer,
    });
    observedEntries.add(entry);
    return entry;
  } finally {
    page.off("request", onRequest);
  }
}
