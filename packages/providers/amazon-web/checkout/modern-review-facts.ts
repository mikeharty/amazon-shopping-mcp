import type { Page } from "playwright";
import {
  isModernReviewUrl,
  type PurchaseTerms,
} from "../../../core/purchasing.js";
import { digest } from "../../../store/crypto.js";
import {
  readAppliedShippingAddress,
  type ShippingIdentity,
} from "./address-identity.js";
import {
  parseGiftCardReviewTotals,
  type GiftCardReviewTotals,
} from "./review-money.js";

type Money = PurchaseTerms["total"];
export type ModernReviewFacts = {
  executableTerms: false;
  reviewUrl: string;
  line: {
    asin: string;
    title: string;
    sellerId: string;
    sellerName: string;
    quantity: number;
    unitPrice: Money;
    lineIdentityHash: string;
  };
  delivery: { promise: string; arrivalHeading?: string; price: Money };
  totals: GiftCardReviewTotals;
  address: {
    physicalIdentity: ShippingIdentity;
    summary: string;
    fingerprint: string;
    savedAddressIdFingerprint?: string;
  };
};
function sameContext(actual: string, expected: string): boolean {
  if (!isModernReviewUrl(actual) || !isModernReviewUrl(expected)) return false;
  const a = new URL(actual);
  const b = new URL(expected);
  return (
    b.searchParams.get("pipelineType") === "Chewbacca" &&
    b.searchParams.get("isBuyNow") === "1" &&
    a.pathname === b.pathname &&
    ["pipelineType", "isBuyNow", "purchaseId", "checkoutSessionId"].every(
      (key) =>
        JSON.stringify(a.searchParams.getAll(key)) ===
        JSON.stringify(b.searchParams.getAll(key)),
    )
  );
}
function usd(text: string): Money | undefined {
  const match = text.trim().match(/^\$\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/);
  if (!match) return undefined;
  const minorUnits = Number(match[1]!.replaceAll(",", "").replace(".", ""));
  return Number.isSafeInteger(minorUnits) && minorUnits <= 100_000_000
    ? { currency: "USD", minorUnits }
    : undefined;
}

async function capture(page: Page) {
  return page.evaluate(async () => {
    const initialURL = location.href;
    const visible = (el: Element) =>
      (el as HTMLElement).getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== "hidden";
    const nodes = (root: ParentNode, selector: string) =>
      Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(visible);
    const one = (root: ParentNode, selector: string) => {
      const found = nodes(root, selector);
      return found.length === 1 ? found[0] : undefined;
    };
    const rendered = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (
        !(node instanceof HTMLElement) ||
        !visible(node) ||
        node.matches("input, select, textarea, script, style")
      )
        return "";
      if (node.tagName === "BR") return "\n";
      return Array.from(node.childNodes).map(rendered).join(" ");
    };
    const text = (el: HTMLElement) => rendered(el).replace(/\s+/g, " ").trim();
    const root = one(document, "#checkout-experience-container");
    if (!root || !one(root, "#checkout-ric-review")) return undefined;
    const panel = one(root, "#checkout-item-block-panel");
    const rows = panel
      ? nodes(panel, '[id^="checkout-item-block-"]').filter((el) =>
          /^checkout-item-block-\d+$/.test(el.id),
        )
      : [];
    if (rows.length !== 1 || rows[0]!.id !== "checkout-item-block-0")
      return undefined;
    const row = rows[0]!;
    // These are contradiction checks, never sources for inferred New/regular terms.
    const selectedEvidence = (el: HTMLElement) => {
      if (!visible(el)) return false;
      if (
        el instanceof HTMLInputElement &&
        /^(radio|checkbox)$/.test(el.type) &&
        !el.checked
      )
        return false;
      for (
        let ancestor: HTMLElement | null = el;
        ancestor && ancestor !== row;
        ancestor = ancestor.parentElement
      )
        if (
          ancestor.getAttribute("aria-selected") === "false" ||
          ancestor.getAttribute("aria-checked") === "false" ||
          ancestor.getAttribute("data-selected") === "false"
        )
          return false;
      return true;
    };
    const condition = (value: string) =>
      /^(?:condition\s*:\s*)?new$/i.test(value.trim());
    const mode = (value: string) =>
      /^(?:purchase\s*mode\s*:\s*)?(?:one_time|one[ -]time(?: purchase)?)$/i.test(
        value.trim(),
      );
    const attributes = (
      names: string[],
      accepts: (value: string) => boolean,
    ) => {
      for (const el of [
        row,
        ...Array.from(
          row.querySelectorAll<HTMLElement>(
            names.map((name) => `[${name}]`).join(","),
          ),
        ).filter(selectedEvidence),
      ]) {
        for (const name of names)
          if (el.hasAttribute(name) && !accepts(el.getAttribute(name) ?? ""))
            return false;
      }
      return true;
    };
    if (
      !attributes(
        ["data-condition", "data-condition-type", "condition-type"],
        condition,
      ) ||
      !attributes(["data-purchase-mode"], mode)
    )
      return undefined;
    const components: [string, (value: string) => boolean][] = [
      [
        '.lineitem-condition-section,[data-component="itemCondition"],[data-testid="item-condition"]',
        condition,
      ],
      [
        '.lineitem-purchase-mode-section,[data-component="purchaseMode"],[data-testid="purchase-mode"]',
        mode,
      ],
    ];
    for (const [selector, accepts] of components)
      for (const el of nodes(row, selector).filter(selectedEvidence))
        if (!accepts(text(el))) return undefined;
    for (const el of nodes(
      row,
      'input[name="condition"],select[name="condition"],input[name="purchaseMode"],select[name="purchaseMode"],input[name="purchase-mode"],select[name="purchase-mode"]',
    ).filter(selectedEvidence)) {
      if (
        !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement) ||
        !(el.name === "condition" ? condition : mode)(el.value)
      )
        return undefined;
    }
    const asins = Array.from(
      row.querySelectorAll<HTMLElement>('span[data-testid^="Item_asin_"]'),
    );
    if (
      asins.length !== 1 ||
      !/^Item_asin_\d+_\d+_\d+$/.test(
        asins[0]!.getAttribute("data-testid") ?? "",
      )
    )
      return undefined;
    for (
      let ancestor = asins[0]!.parentElement;
      ancestor && ancestor !== row;
      ancestor = ancestor.parentElement
    )
      if (!visible(ancestor)) return undefined;
    const asin = asins[0]!.textContent?.trim();
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return undefined;
    const rowAsin = row.getAttribute("data-asin");
    if (rowAsin !== null && rowAsin.toUpperCase() !== asin) return undefined;
    const titleNode = one(row, "span.lineitem-title-text");
    const sellerNode = one(row, "p.lineitem-seller-section");
    const sellerLinks = sellerNode ? nodes(sellerNode, "a[href]") : [];
    if (!titleNode || sellerLinks.length !== 1) return undefined;
    const title = text(titleNode);
    const sellerName = text(sellerLinks[0]!);
    if (
      !title ||
      title.length > 1000 ||
      !sellerName ||
      sellerName.length > 1000
    )
      return undefined;
    let sellerId: string | undefined;
    try {
      const url = new URL((sellerLinks[0] as HTMLAnchorElement).href);
      const ids = url.searchParams.getAll("seller");
      if (
        url.origin === "https://www.amazon.com" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        ids.length === 1 &&
        /^[A-Z0-9]{6,32}$/.test(ids[0]!)
      )
        sellerId = ids[0];
    } catch {
      /* No seller inference. */
    }
    if (!sellerId) return undefined;
    const priceNode = one(row, ".a-price.apex-price-to-pay-value");
    const prices = priceNode?.querySelectorAll<HTMLElement>(".a-offscreen");
    if (!prices || prices.length !== 1) return undefined;
    const price = prices[0]!.textContent?.trim();
    if (!price) return undefined;
    const stepper = one(row, '[name="checkout-quantity-stepper"]');
    if (!stepper || stepper.getAttribute("data-a-component") !== "stepper")
      return undefined;
    const quantityText = stepper.getAttribute("data-steppervalue");
    const live = one(stepper, ".a-stepper-value-live");
    if (
      !quantityText ||
      !/^(?:[1-9]|10)$/.test(quantityText) ||
      !live ||
      text(live) !== quantityText
    )
      return undefined;
    const checked = Array.from(
      row.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ).filter((input) => input.checked);
    const selected =
      checked.length === 1
        ? checked[0]!.closest<HTMLElement>(".a-radio")
        : undefined;
    if (!selected || !row.contains(selected) || !visible(selected))
      return undefined;
    const message = one(selected, ".col-delivery-message");
    const deliveryPrice = one(selected, ".col-delivery-price");
    if (!message || !deliveryPrice) return undefined;
    const promise = text(message);
    const shippingPrice = text(deliveryPrice);
    if (!promise || promise.length > 1000 || !shippingPrice) return undefined;
    const headings = nodes(message, "span.a-text-bold");
    const arrivalHeading =
      headings.length === 1 ? text(headings[0]!) : undefined;
    const identities = Array.from(
      row.querySelectorAll<HTMLElement>("[data-lineitemid]"),
    ).map((node) => node.getAttribute("data-lineitemid"));
    if (row.hasAttribute("data-lineitemid"))
      identities.push(row.getAttribute("data-lineitemid"));
    if (
      !identities.length ||
      identities.some((value) => !value?.trim() || value.length > 4096) ||
      new Set(identities).size !== 1
    )
      return undefined;
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(identities[0]!),
    );
    const lineIdentityHash = Array.from(new Uint8Array(hash))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const table = one(root, "#subtotals-marketplace-table");
    if (!table || !one(root, "#checkout-delivery-address-panel"))
      return undefined;
    const grids = nodes(table, ".order-summary-grid");
    if (!grids.length || grids.length > 20) return undefined;
    const totals: { label: string; value: string }[] = [];
    for (const grid of grids) {
      const term = one(grid, ".order-summary-line-term");
      const definition = one(grid, ".order-summary-line-definition");
      if (!term || !definition) return undefined;
      totals.push({ label: text(term), value: text(definition) });
    }
    if (location.href !== initialURL) return undefined;
    return {
      asin,
      title,
      sellerId,
      sellerName,
      quantity: Number(quantityText),
      price,
      lineIdentityHash,
      promise,
      arrivalHeading,
      shippingPrice,
      totals,
    };
  });
}

/** Positive selected-line facts only. Authentication loading belongs to the caller. */
export async function extractModernReviewFacts(
  page: Page,
  expectedURL: string,
): Promise<ModernReviewFacts | undefined> {
  if (!sameContext(page.url(), expectedURL)) return undefined;
  const raw = await capture(page);
  if (!raw || !sameContext(page.url(), expectedURL)) return undefined;
  const address = await readAppliedShippingAddress(page);
  if (!address) return undefined;
  const again = await capture(page);
  const addressAgain = await readAppliedShippingAddress(page);
  if (
    !again ||
    !addressAgain ||
    !sameContext(page.url(), expectedURL) ||
    digest(raw) !== digest(again) ||
    digest(address) !== digest(addressAgain)
  )
    return undefined;
  const unitPrice = usd(raw.price);
  const shippingPrice =
    raw.shippingPrice === "FREE"
      ? { currency: "USD" as const, minorUnits: 0 }
      : usd(raw.shippingPrice);
  const totals = parseGiftCardReviewTotals(raw.totals);
  if (
    !unitPrice ||
    !shippingPrice ||
    !totals ||
    totals.funding.additionalAmountDue.minorUnits !== 0 ||
    totals.funding.giftCardApplied.minorUnits !== totals.total.minorUnits ||
    totals.funding.giftCardApplied.minorUnits <= 0 ||
    unitPrice.minorUnits * raw.quantity !== totals.subtotal.minorUnits ||
    shippingPrice.minorUnits !== totals.shipping.minorUnits
  )
    return undefined;
  const physical = address.physicalIdentity;
  const summary = [
    physical.recipient,
    ...physical.addressLines,
    `${physical.city}, ${physical.region} ${physical.postalCode}`,
    physical.country,
  ].join(", ");
  const review = new URL(page.url());
  review.searchParams.sort();
  return {
    executableTerms: false,
    reviewUrl: review.toString(),
    line: {
      asin: raw.asin,
      title: raw.title,
      sellerId: raw.sellerId,
      sellerName: raw.sellerName,
      quantity: raw.quantity,
      unitPrice,
      lineIdentityHash: raw.lineIdentityHash,
    },
    delivery: {
      promise: raw.promise,
      ...(raw.arrivalHeading ? { arrivalHeading: raw.arrivalHeading } : {}),
      price: shippingPrice,
    },
    totals,
    address: {
      ...address,
      summary,
      fingerprint: digest({ ...address, summary }),
    },
  };
}
