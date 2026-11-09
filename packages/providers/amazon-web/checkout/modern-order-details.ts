import type { Page } from "playwright";

type Money = { currency: "USD"; minorUnits: number };
export type ModernOrderDetails = {
  profile: "modern_single_item_receipt";
  orderId: string;
  line: {
    asin: string;
    title: string;
    merchant:
      | { kind: "marketplace"; sellerId: string }
      | { kind: "amazon_retail"; label: "Amazon.com" };
    unitPrice: Money;
    condition?: string;
    quantity?: number;
    deliveryFrequency?: string;
  };
  monetaryRows: { label: string; value: string; amount?: Money }[];
};
function usd(value: string): Money | undefined {
  const match = value
    .trim()
    .match(/^(-?)\$\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/);
  if (!match) return undefined;
  const minorUnits =
    Number(match[2]!.replaceAll(",", "").replace(".", "")) *
    (match[1] ? -1 : 1);
  return Number.isSafeInteger(minorUnits) && Math.abs(minorUnits) <= 100_000_000
    ? { currency: "USD", minorUnits }
    : undefined;
}

/** Observes one complete purchased line. Authentication and confirmation/baseline binding remain caller obligations. */
export async function readModernOrderDetails(
  page: Page,
  expectedOrderID: string,
): Promise<ModernOrderDetails | undefined> {
  if (!/^\d{3}-\d{7}-\d{7}$/.test(expectedOrderID)) return undefined;
  const raw = await page.evaluate((expected) => {
    const current = new URL(location.href);
    const ids = [
      ...current.searchParams.getAll("orderID"),
      ...current.searchParams.getAll("orderId"),
    ];
    if (
      current.origin !== "https://www.amazon.com" ||
      current.username ||
      current.password ||
      current.hash ||
      ![
        "/gp/your-account/order-details",
        "/your-orders/order-details",
      ].includes(current.pathname) ||
      ids.length !== 1 ||
      ids[0] !== expected ||
      [...current.searchParams.keys()].some(
        (key) =>
          !["orderID", "orderId", "ref", "ref_"].includes(key) ||
          current.searchParams.getAll(key).length !== 1,
      )
    )
      return undefined;
    const visible = (el: Element) => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        if (node.matches('template,[hidden],[aria-hidden="true"]'))
          return false;
        const style = getComputedStyle(node);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse"
        )
          return false;
      }
      return (el as HTMLElement).getClientRects().length > 0;
    };
    const rendered = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (
        !(node instanceof HTMLElement) ||
        !visible(node) ||
        node.matches("script,style,input,select,textarea,button")
      )
        return "";
      return Array.from(node.childNodes).map(rendered).join(" ");
    };
    const text = (node: Element) => rendered(node).replace(/\s+/g, " ").trim();
    const roots = Array.from(document.querySelectorAll("#orderDetails")).filter(
      visible,
    );
    if (roots.length !== 1) return undefined;
    const root = roots[0]!;
    const displayed = Array.from(root.querySelectorAll("span"))
      .filter((el) => visible(el) && text(el).toLowerCase() === "order #")
      .map((el) => el.parentElement?.nextElementSibling)
      .filter((el): el is Element => Boolean(el && visible(el)))
      .map(text);
    if (displayed.length !== 1 || displayed[0] !== expected) return undefined;
    const disallowed = Array.from(root.querySelectorAll("[data-component]"))
      .filter(visible)
      .some(
        (el) =>
          /^(?:substitutionDetails|associatedOrdersForService|cancelled|canceled|replacement|replacementDetails)$/i.test(
            el.getAttribute("data-component") ?? "",
          ) && Boolean(text(el)),
      );
    if (
      disallowed ||
      Array.from(root.querySelectorAll('[data-component="shipmentStatus"]'))
        .filter(visible)
        .some((el) =>
          /\b(?:cancelled|canceled|replacement|substitution)\b/i.test(text(el)),
        )
    )
      return undefined;
    const purchased = Array.from(
      root.querySelectorAll('[data-component="purchasedItems"]'),
    ).filter(visible);
    if (
      !purchased.length ||
      purchased.some((el) =>
        el.parentElement?.closest('[data-component="purchasedItems"]'),
      )
    )
      return undefined;
    const titles = purchased.flatMap((el) =>
      Array.from(el.querySelectorAll('[data-component="itemTitle"]')).filter(
        visible,
      ),
    );
    if (titles.length !== 1 || purchased.some((el) => !el.contains(titles[0]!)))
      return undefined;
    const titleRoot = titles[0]!,
      item = titleRoot.closest(".a-fixed-left-grid");
    if (!item || !purchased.some((el) => el.contains(item))) return undefined;
    if (
      purchased.some((el) =>
        Array.from(
          el.querySelectorAll('[data-component="purchasedItemsRightGrid"]'),
        )
          .filter(visible)
          .some((grid) => !item.contains(grid)),
      )
    )
      return undefined;
    const links = Array.from(
      titleRoot.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ).filter(visible);
    if (links.length !== 1) return undefined;
    const product = new URL(links[0]!.href);
    const asin = product.pathname
      .match(/^\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]
      ?.toUpperCase();
    const title = text(links[0]!);
    if (
      product.origin !== current.origin ||
      product.username ||
      product.password ||
      !asin ||
      !title ||
      title.length > 1000
    )
      return undefined;
    const component = (name: string) =>
      Array.from(item.querySelectorAll(`[data-component="${name}"]`)).filter(
        visible,
      );
    const sellers = component("orderedMerchant");
    if (sellers.length !== 1) return undefined;
    const sellerLinks = Array.from(
      sellers[0]!.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ).filter(visible);
    let merchant:
      | { kind: "marketplace"; sellerId: string }
      | { kind: "amazon_retail"; label: "Amazon.com" };
    if (
      !sellerLinks.length &&
      /^Sold by:\s*Amazon\.com$/i.test(text(sellers[0]!))
    )
      merchant = { kind: "amazon_retail", label: "Amazon.com" };
    else {
      if (
        sellerLinks.length !== 1 ||
        text(sellers[0]!) !== `Sold by: ${text(sellerLinks[0]!)}`
      )
        return undefined;
      const seller = new URL(sellerLinks[0]!.href),
        values = seller.searchParams.getAll("seller");
      if (
        seller.origin !== current.origin ||
        seller.username ||
        seller.password ||
        !["/sp", "/gp/aag/main"].includes(seller.pathname) ||
        values.length !== 1 ||
        !/^[A-Z0-9]{6,32}$/.test(values[0]!)
      )
        return undefined;
      merchant = { kind: "marketplace", sellerId: values[0]! };
    }
    const prices = component("unitPrice");
    if (prices.length !== 1) return undefined;
    const amounts = Array.from(
      prices[0]!.querySelectorAll(".a-price .a-offscreen"),
    ).filter(visible);
    if (amounts.length !== 1) return undefined;
    const optional: Record<string, string> = {};
    for (const name of ["itemCondition", "quantity", "deliveryFrequency"]) {
      const nodes = component(name);
      if (nodes.length > 1) return undefined;
      const value = nodes.length ? text(nodes[0]!) : "";
      if (value.length > 200) return undefined;
      if (value) optional[name] = value;
    }
    const summaries = Array.from(root.querySelectorAll("#od-subtotals")).filter(
      visible,
    );
    if (summaries.length !== 1) return undefined;
    const rows = Array.from(
      summaries[0]!.querySelectorAll(".od-line-item-row"),
    ).filter(visible);
    if (!rows.length || rows.length > 30) return undefined;
    const monetaryRows = [];
    for (const row of rows) {
      const labels = Array.from(
        row.querySelectorAll(".od-line-item-row-label"),
      ).filter(visible);
      const values = Array.from(
        row.querySelectorAll(".od-line-item-row-content"),
      ).filter(visible);
      if (labels.length !== 1 || values.length !== 1) return undefined;
      const label = text(labels[0]!),
        value = text(values[0]!);
      if (!label || !value || label.length > 200 || value.length > 100)
        return undefined;
      monetaryRows.push({ label, value });
    }
    return {
      asin,
      title,
      merchant,
      price: text(amounts[0]!),
      optional,
      monetaryRows,
    };
  }, expectedOrderID);
  if (!raw) return undefined;
  const unitPrice = usd(raw.price);
  if (!unitPrice || unitPrice.minorUnits <= 0) return undefined;
  const quantityText = raw.optional.quantity;
  const match = quantityText?.match(
    /^(?:(?:Quantity|Qty)\s*:?\s*)?([1-9]\d?)$/i,
  );
  if (quantityText && (!match || Number(match[1]) > 10)) return undefined;
  return {
    profile: "modern_single_item_receipt",
    orderId: expectedOrderID,
    line: {
      asin: raw.asin,
      title: raw.title,
      merchant: raw.merchant,
      unitPrice,
      ...(raw.optional.itemCondition
        ? { condition: raw.optional.itemCondition }
        : {}),
      ...(match ? { quantity: Number(match[1]) } : {}),
      ...(raw.optional.deliveryFrequency
        ? { deliveryFrequency: raw.optional.deliveryFrequency }
        : {}),
    },
    monetaryRows: raw.monetaryRows.map((row) => ({
      ...row,
      ...(usd(row.value) ? { amount: usd(row.value)! } : {}),
    })),
  };
}

/** Does not compare an intent or establish omitted condition, mode, funding, or new-order identity. */
export function deriveModernReceiptQuantity(receipt: ModernOrderDetails):
  | {
      quantity: number;
      evidence: {
        kind: "item_subtotal_divided_by_unit_price";
        subtotal: Money;
        unitPrice: Money;
        explicitQuantity?: number;
      };
    }
  | undefined {
  const normalized = receipt.monetaryRows.map((row) => ({
    ...row,
    key: row.label.trim().replace(/:$/, "").toLowerCase(),
  }));
  const rows = normalized.filter((row) => /^item\(s\) subtotal$/.test(row.key));
  if (
    rows.length !== 1 ||
    normalized.some(
      (row) =>
        !/^(?:item\(s\) subtotal|shipping & handling|total before tax|estimated tax to be collected|grand total|gift card|gift card amount|gift card balance|order total)$/.test(
          row.key,
        ),
    )
  )
    return undefined;
  const subtotal = usd(rows[0]!.value),
    unitPrice = receipt.line.unitPrice;
  if (
    !subtotal ||
    subtotal.minorUnits <= 0 ||
    unitPrice.currency !== "USD" ||
    !Number.isSafeInteger(unitPrice.minorUnits) ||
    unitPrice.minorUnits <= 0 ||
    subtotal.minorUnits % unitPrice.minorUnits !== 0
  )
    return undefined;
  const quantity = subtotal.minorUnits / unitPrice.minorUnits;
  if (
    quantity < 1 ||
    quantity > 10 ||
    (receipt.line.quantity !== undefined && receipt.line.quantity !== quantity)
  )
    return undefined;
  return {
    quantity,
    evidence: {
      kind: "item_subtotal_divided_by_unit_price",
      subtotal,
      unitPrice,
      ...(receipt.line.quantity === undefined
        ? {}
        : { explicitQuantity: receipt.line.quantity }),
    },
  };
}
