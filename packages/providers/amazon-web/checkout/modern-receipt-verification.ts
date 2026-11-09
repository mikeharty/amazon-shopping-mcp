import type { PurchaseTerms } from "../../../core/purchasing.js";
import {
  deriveModernReceiptQuantity,
  type ModernOrderDetails,
} from "./modern-order-details.js";

type Money = PurchaseTerms["total"];
function amount(value: string): Money | undefined {
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
export function modernReceiptAmounts(rows: ModernOrderDetails["monetaryRows"]) {
  const values = new Map<string, Money>();
  for (const row of rows) {
    const label = row.label
      .replace(/\s+/g, " ")
      .trim()
      .replace(/:$/, "")
      .toLowerCase();
    const key =
      label === "item(s) subtotal"
        ? "subtotal"
        : label === "shipping & handling"
          ? "shipping"
          : label === "total before tax"
            ? "beforeTax"
            : label === "estimated tax to be collected"
              ? "tax"
              : label === "grand total"
                ? "grand"
                : /^gift card(?: amount| balance)?$/.test(label)
                  ? "gift"
                  : label === "order total"
                    ? "due"
                    : undefined;
    const parsed = amount(row.value);
    if (
      !key ||
      values.has(key) ||
      !parsed ||
      (key === "gift"
        ? !row.value.trim().startsWith("-")
        : parsed.minorUnits < 0)
    )
      return undefined;
    values.set(key, parsed);
  }
  const subtotal = values.get("subtotal"),
    shipping = values.get("shipping"),
    beforeTax = values.get("beforeTax");
  const tax = values.get("tax"),
    grand = values.get("grand");
  if (
    !subtotal ||
    !shipping ||
    !beforeTax ||
    !tax ||
    !grand ||
    beforeTax.minorUnits !== subtotal.minorUnits + shipping.minorUnits
  )
    return undefined;
  const total = {
    currency: "USD" as const,
    minorUnits: beforeTax.minorUnits + tax.minorUnits,
  };
  if (!Number.isSafeInteger(total.minorUnits) || total.minorUnits > 100_000_000)
    return undefined;
  const gift = values.get("gift"),
    due = values.get("due");
  if (!gift) {
    if (due || grand.minorUnits !== total.minorUnits) return undefined;
    return { subtotal, shipping, tax, total, funding: undefined };
  }
  const applied = -gift.minorUnits,
    residual = total.minorUnits - applied;
  if (
    applied > total.minorUnits ||
    residual < 0 ||
    (due && due.minorUnits !== residual)
  )
    return undefined;
  if (grand.minorUnits !== total.minorUnits && grand.minorUnits !== residual)
    return undefined;
  return {
    subtotal,
    shipping,
    tax,
    total,
    funding: {
      giftCardApplied: { currency: "USD" as const, minorUnits: applied },
      additionalAmountDue: { currency: "USD" as const, minorUnits: residual },
    },
    additionalPaymentEvidence: due
      ? ("displayed_order_total" as const)
      : grand.minorUnits === residual
        ? ("displayed_grand_total_net" as const)
        : ("gross_less_displayed_gift_credit" as const),
  };
}

/** Caller must independently authenticate and prove the positive preparation origin before dispatch. */
export function verifyModernReceipt(
  receipt: ModernOrderDetails,
  terms: PurchaseTerms,
  confirmedOrderId: string,
  priorOrders: ReadonlySet<string>,
) {
  if (
    !/^\d{3}-\d{7}-\d{7}$/.test(confirmedOrderId) ||
    priorOrders.has(confirmedOrderId) ||
    receipt.orderId !== confirmedOrderId ||
    terms.lines.length !== 1 ||
    terms.flow === "subscribe_and_save" ||
    terms.recurring ||
    !terms.funding
  )
    return undefined;
  const expected = terms.lines[0]!,
    line = receipt.line;
  const quantity = deriveModernReceiptQuantity(receipt),
    amounts = modernReceiptAmounts(receipt.monetaryRows);
  if (
    !quantity ||
    !amounts?.funding ||
    expected.purchaseMode !== "one_time" ||
    line.asin !== expected.asin ||
    line.merchant.kind !== "marketplace" ||
    line.merchant.sellerId !== expected.sellerId ||
    line.unitPrice.minorUnits !== expected.unitPrice.minorUnits ||
    quantity.quantity !== expected.quantity ||
    line.deliveryFrequency
  )
    return undefined;
  if (
    line.condition &&
    line.condition
      .replace(/^Condition:\s*/i, "")
      .trim()
      .toLowerCase() !== expected.condition.toLowerCase()
  )
    return undefined;
  for (const key of ["subtotal", "shipping", "tax", "total"] as const)
    if (amounts[key].minorUnits !== terms[key].minorUnits) return undefined;
  if (
    terms.discount.minorUnits !== 0 ||
    amounts.funding.giftCardApplied.minorUnits !==
      terms.funding.giftCardApplied.minorUnits ||
    amounts.funding.additionalAmountDue.minorUnits !==
      terms.funding.additionalAmountDue.minorUnits
  )
    return undefined;
  return {
    profile: "modern_single_item_funded_order" as const,
    orderId: confirmedOrderId,
    observedFields: [
      "displayed_order_identity",
      "asin",
      "seller_id",
      "unit_price",
      "subtotal",
      "shipping",
      "tax",
      "gift_card_credit",
    ],
    derivedQuantity: quantity,
    grossTotal: amounts.total,
    funding: amounts.funding,
    additionalPaymentEvidence: amounts.additionalPaymentEvidence,
    preSubmitOnlyFields: line.condition
      ? ["purchaseMode"]
      : ["condition", "purchaseMode"],
  };
}
