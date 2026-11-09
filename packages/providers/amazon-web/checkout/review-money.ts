import type { PurchaseTerms } from "../../../core/purchasing.js";

type Money = PurchaseTerms["total"];
export type GiftCardReviewTotals = Pick<
  PurchaseTerms,
  "subtotal" | "shipping" | "tax" | "discount" | "total"
> & { funding: NonNullable<PurchaseTerms["funding"]> };
type Row = { label: string; value: string };
function usd(value: string, credit = false): Money | undefined {
  const text = value.trim();
  const match = text.match(
    credit
      ? /^-\$\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/
      : /^\$\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/,
  );
  if (!match) return undefined;
  const minorUnits = Number(match[1]!.replaceAll(",", "").replace(".", ""));
  return Number.isSafeInteger(minorUnits) && minorUnits <= 100_000_000
    ? { currency: "USD", minorUnits }
    : undefined;
}

/** Pass every monetary summary row, including unknown credits; omission is unsafe. */
export function parseGiftCardReviewTotals(
  rows: Row[],
): GiftCardReviewTotals | undefined {
  if (rows.length < 6 || rows.length > 20) return undefined;
  const values = new Map<string, Money>();
  for (const row of rows) {
    const label = row.label
      .replace(/\s+/g, " ")
      .trim()
      .replace(/:$/, "")
      .toLowerCase();
    const key = /^items(?: \(\d+\))?$/.test(label)
      ? "subtotal"
      : /^shipping (?:&|and) handling$/.test(label)
        ? "shipping"
        : /^(?:estimated )?tax(?: to be collected)?$/.test(label)
          ? "tax"
          : label === "total"
            ? "total"
            : /^gift\s*card$/.test(label)
              ? "gift"
              : label === "order total"
                ? "due"
                : /^(?:discounts?|promotions? applied)$/.test(label)
                  ? "discount"
                  : undefined;
    if (!key || values.has(key)) return undefined;
    const amount = usd(
      row.value,
      key === "gift" ||
        (key === "discount" && row.value.trim().startsWith("-")),
    );
    if (!amount) return undefined;
    values.set(key, amount);
  }
  const subtotal = values.get("subtotal"),
    shipping = values.get("shipping"),
    tax = values.get("tax");
  const total = values.get("total"),
    gift = values.get("gift"),
    due = values.get("due");
  if (!subtotal || !shipping || !tax || !total || !gift || !due)
    return undefined;
  const residual =
    subtotal.minorUnits +
    shipping.minorUnits +
    tax.minorUnits -
    total.minorUnits;
  const discount =
    values.get("discount") ??
    (residual === 0 ? { currency: "USD" as const, minorUnits: 0 } : undefined);
  if (
    !discount ||
    residual !== discount.minorUnits ||
    gift.minorUnits > total.minorUnits ||
    gift.minorUnits + due.minorUnits !== total.minorUnits
  )
    return undefined;
  return {
    subtotal,
    shipping,
    tax,
    discount,
    total,
    funding: { giftCardApplied: gift, additionalAmountDue: due },
  };
}
