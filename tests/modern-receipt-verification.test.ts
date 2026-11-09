import { describe, expect, it } from "vitest";
import type { PurchaseTerms } from "../packages/core/purchasing.js";
import type { ModernOrderDetails } from "../packages/providers/amazon-web/checkout/modern-order-details.js";
import {
  modernReceiptAmounts,
  verifyModernReceipt,
} from "../packages/providers/amazon-web/checkout/modern-receipt-verification.js";
const money = (minorUnits: number) => ({
  currency: "USD" as const,
  minorUnits,
});
function receipt(): ModernOrderDetails {
  return {
    profile: "modern_single_item_receipt",
    orderId: "123-1111111-2222222",
    line: {
      asin: "B0FIXTURE1",
      title: "Fixture cable",
      merchant: { kind: "marketplace", sellerId: "A1FIXTURE" },
      unitPrice: money(740),
    },
    monetaryRows: [
      { label: "Item(s) Subtotal:", value: "$7.40" },
      { label: "Shipping & Handling:", value: "$0.00" },
      { label: "Total before tax:", value: "$7.40" },
      { label: "Estimated tax to be collected:", value: "$0.83" },
      { label: "Gift Card:", value: "-$8.23" },
      { label: "Grand Total:", value: "$0.00" },
    ],
  };
}
function terms(): PurchaseTerms {
  return {
    schemaVersion: 1,
    flow: "buy_now",
    reviewUrl: "https://www.amazon.com/checkout/p/review",
    lines: [
      {
        asin: "B0FIXTURE1",
        title: "Fixture cable",
        sellerId: "A1FIXTURE",
        condition: "New",
        quantity: 1,
        purchaseMode: "one_time",
        unitPrice: money(740),
      },
    ],
    subtotal: money(740),
    shipping: money(0),
    tax: money(83),
    discount: money(0),
    total: money(823),
    funding: { giftCardApplied: money(823), additionalAmountDue: money(0) },
    address: {
      ref: "a",
      summary: "Fixture address",
      fingerprint: "a".repeat(64),
    },
    payment: {
      ref: "p",
      summary: "Gift card balance",
      fingerprint: "b".repeat(64),
    },
    shippingGroups: [
      { ref: "g", delivery: "Tuesday", speed: "Free", asins: ["B0FIXTURE1"] },
    ],
    promotions: [],
    warnings: [],
  };
}
const verify = (r = receipt(), t = terms(), prior = new Set<string>()) =>
  verifyModernReceipt(r, t, "123-1111111-2222222", prior);
describe("Independent modern receipt verification", () => {
  it("records observed funding, derived quantity and presale-only fields without fabricating receipt values", () => {
    const r = receipt();
    const result = verify(r);
    expect(result).toMatchObject({
      profile: "modern_single_item_funded_order",
      derivedQuantity: { quantity: 1 },
      grossTotal: money(823),
      funding: { giftCardApplied: money(823), additionalAmountDue: money(0) },
      preSubmitOnlyFields: ["condition", "purchaseMode"],
    });
    expect(r.line.condition).toBeUndefined();
    expect(r.line).not.toHaveProperty("purchaseMode");
    expect(result).not.toHaveProperty("verified");
  });
  it("rejects funding omitted from the receipt even if approved terms were fully funded", () => {
    const r = receipt();
    r.monetaryRows = r.monetaryRows.filter((x) => x.label !== "Gift Card:");
    r.monetaryRows.at(-1)!.value = "$8.23";
    expect(modernReceiptAmounts(r.monetaryRows)?.funding).toBeUndefined();
    expect(verify(r)).toBeUndefined();
  });
  it("accepts gross grand total plus independently displayed full gift allocation", () => {
    const r = receipt();
    r.monetaryRows.at(-1)!.value = "$8.23";
    expect(verify(r)).toMatchObject({
      additionalPaymentEvidence: "gross_less_displayed_gift_credit",
    });
  });
  it.each(["unknown credit", "installment", "promotion"])(
    "rejects unconsumed monetary row %s",
    (label) => {
      const r = receipt();
      r.monetaryRows.push({ label, value: "$0.00" });
      expect(verify(r)).toBeUndefined();
    },
  );
  it.each([
    "seller",
    "asin",
    "quantity",
    "condition",
    "frequency",
    "unitPrice",
    "tax",
    "funding",
    "displayedId",
  ])("rejects changed %s", (field) => {
    const r = receipt();
    if (field === "seller")
      r.line.merchant = { kind: "marketplace", sellerId: "A9OTHER01" };
    if (field === "asin") r.line.asin = "B0OTHER001";
    if (field === "quantity") r.line.quantity = 2;
    if (field === "condition") r.line.condition = "Used";
    if (field === "frequency") r.line.deliveryFrequency = "Every month";
    if (field === "unitPrice") r.line.unitPrice = money(741);
    if (field === "tax") r.monetaryRows[3]!.value = "$0.84";
    if (field === "funding") r.monetaryRows[4]!.value = "-$8.22";
    if (field === "displayedId") r.orderId = "999-1111111-2222222";
    expect(verify(r)).toBeUndefined();
  });
  it("rejects an old order and a net-payment amount substituted for purchase value", () => {
    expect(
      verify(receipt(), terms(), new Set(["123-1111111-2222222"])),
    ).toBeUndefined();
    const t = terms();
    t.total = money(0);
    expect(verify(receipt(), t)).toBeUndefined();
  });
  it("rejects contradictory explicit additional payment and duplicate rows", () => {
    const r = receipt();
    r.monetaryRows.push({ label: "Order total", value: "$0.01" });
    expect(verify(r)).toBeUndefined();
    const d = receipt();
    d.monetaryRows.push(d.monetaryRows[0]!);
    expect(verify(d)).toBeUndefined();
  });
});
