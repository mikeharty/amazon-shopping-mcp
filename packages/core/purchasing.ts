import { z } from "zod";

export const purchasePreparationKinds = ["checkout_prepare", "buy_now_prepare", "subscriptions_prepare"] as const;
export const purchaseCommitKinds = ["checkout_submit", "subscriptions_submit"] as const;

export function isReviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://www.amazon.com" && !url.username && !url.password && !url.hash &&
      (/^\/checkout\/p\/(?:p-[A-Za-z0-9-]+\/)?(?:review|spc)$/.test(url.pathname) || url.pathname === "/gp/buy/spc/handlers/display.html") &&
      [...url.searchParams.keys()].every((key) => ["ref", "ref_", "pipelineType", "hasWorkingJavascript", "purchaseId", "checkoutSessionId"].includes(key));
  } catch { return false; }
}

const money = z.object({ currency: z.literal("USD"), minorUnits: z.number().int().nonnegative().max(100_000_000) }).strict();
const text = z.string().trim().min(1).max(1000);
const identity = z.object({ ref: text, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), summary: text }).strict();
export const purchaseTermsSchema = z.object({
  schemaVersion: z.literal(1),
  flow: z.enum(["cart", "buy_now", "subscribe_and_save"]),
  reviewUrl: z.string().max(2048).refine(isReviewUrl, "Unsupported Amazon review URL"),
  lines: z.array(z.object({
    asin: z.string().regex(/^[A-Z0-9]{10}$/), title: text,
    sellerId: z.string().regex(/^[A-Z0-9]{6,32}$/), condition: text,
    sellerName: text.optional(),
    quantity: z.number().int().min(1).max(10), unitPrice: money,
    purchaseMode: z.enum(["one_time", "subscribe_and_save"]),
  }).strict()).min(1).max(50),
  subtotal: money, shipping: money, tax: money, discount: money, total: money,
  funding: z.object({ giftCardApplied: money, additionalAmountDue: money }).strict().optional(),
  address: identity, payment: identity,
  shippingGroups: z.array(z.object({ ref: text, delivery: text, speed: text, asins: z.array(z.string().regex(/^[A-Z0-9]{10}$/)).min(1).max(50) }).strict()).min(1).max(50),
  promotions: z.array(text).max(30), warnings: z.array(text).max(30),
  recurring: z.object({
    frequencyRef: text, frequency: text, nextDelivery: text, discount: text,
    futurePricePolicy: text, createsImmediateOrder: z.boolean(),
  }).strict().optional(),
}).strict().superRefine((terms, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (terms.total.minorUnits !== terms.subtotal.minorUnits + terms.shipping.minorUnits + terms.tax.minorUnits - terms.discount.minorUnits)
    issue("The displayed checkout totals do not reconcile");
  if (terms.subtotal.minorUnits !== terms.lines.reduce((sum, line) => sum + line.unitPrice.minorUnits * line.quantity, 0))
    issue("The displayed line prices do not reconcile with the subtotal");
  if (terms.funding) {
    if (terms.flow === 'subscribe_and_save' || terms.recurring)
      issue('Gift-card funding is supported only for one-time purchases');
    if (terms.funding.giftCardApplied.minorUnits > terms.total.minorUnits || terms.funding.giftCardApplied.minorUnits + terms.funding.additionalAmountDue.minorUnits !== terms.total.minorUnits)
      issue('The displayed gift-card funding and additional payment do not reconcile with the purchase total');
  }
  if (terms.lines.some((line) => !terms.shippingGroups.some((group) => group.asins.includes(line.asin))))
    issue("Every item needs an observed delivery group");
  if (terms.shippingGroups.some((group) => group.asins.some((asin) => !terms.lines.some((line) => line.asin === asin))))
    issue("Delivery groups contain an unexpected item");
  if (new Set(terms.lines.map((line) => line.asin)).size !== terms.lines.length)
    issue("Repeated item identities need an explicit supported layout");
  if (terms.flow === "subscribe_and_save") {
    if (!terms.recurring || terms.lines.length !== 1 || terms.lines.some((line) => line.purchaseMode !== "subscribe_and_save"))
      issue("Subscribe & Save needs one exact item and complete recurring terms");
  } else if (terms.recurring || terms.lines.some((line) => line.purchaseMode !== "one_time")) {
    issue("One-time checkout cannot silently include a subscription");
  }
});
export type PurchaseTerms = z.infer<typeof purchaseTermsSchema>;
export const commitKindFor = (terms: PurchaseTerms) => terms.flow === "subscribe_and_save" ? "subscriptions_submit" : "checkout_submit";
