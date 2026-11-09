import type { Page } from "playwright";
import type { ProviderContext, Result } from "../../../contracts/index.js";
import {
  classifyPage,
  isVerifiedAuthenticatedAmazonPage,
} from "../../../browser-runtime/index.js";
import {
  isModernReviewUrl,
  purchaseTermsSchema,
} from "../../../core/purchasing.js";
import { digest } from "../../../store/crypto.js";
import { ModernCheckoutOrigins } from "./modern-origins.js";
import { modernCheckoutIdentity } from "./modern-product-offer.js";
import { extractModernReviewFacts } from "./modern-review-facts.js";
import { getModernOrderControl } from "./modern-order-control.js";

const unsupported = (code: string): Result => ({
  status: "unsupported",
  error: { code, retryable: false },
});
async function authForm(page: Page) {
  return page
    .locator(
      'input[type="password"],input[name="email"],input[name="otpCode"],input[name="code"],input[name="cvv"],input[autocomplete="cc-csc"]',
    )
    .evaluateAll((els) =>
      els.some(
        (el) =>
          (el as HTMLElement).getClientRects().length > 0 &&
          getComputedStyle(el).visibility !== "hidden",
      ),
    );
}
/** Same-run auth plus volatile native-entry provenance; never reconstructs evidence. */
export async function loadModernPurchaseQuote(
  page: Page,
  url: string,
  context: ProviderContext,
  origins: ModernCheckoutOrigins,
): Promise<Result> {
  const origin = origins.get(context, url);
  if (!isModernReviewUrl(url) || !origin || origin.stage !== "review")
    return unsupported("modern_checkout_origin_required");
  const authFailure = () => {
    origins.invalidate(context);
    return {
      status: "requires_user_action" as const,
      error: { code: "checkout_authentication_unverified", retryable: false },
    };
  };
  await page.goto("https://www.amazon.com/gp/your-account/order-history", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  if (
    new URL(page.url()).origin !== "https://www.amazon.com" ||
    (await classifyPage(page)).kind !== "ready" ||
    !(await isVerifiedAuthenticatedAmazonPage(page)) ||
    (await authForm(page))
  )
    return authFailure();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  if (
    !isModernReviewUrl(page.url()) ||
    modernCheckoutIdentity(page.url()) !== modernCheckoutIdentity(url)
  ) {
    origins.invalidate(context);
    return unsupported("modern_checkout_context_changed");
  }
  if ((await classifyPage(page)).kind !== "ready" || (await authForm(page)))
    return authFailure();
  const facts = await extractModernReviewFacts(page, url);
  if (!facts) {
    origins.invalidate(context);
    return unsupported("modern_review_facts_incomplete");
  }
  const bound = origins.bindFacts(context, url, facts);
  if (!bound) return unsupported("modern_checkout_provenance_changed");
  const notices = await page
    .locator("#checkout-experience-container")
    .evaluate((root) => {
      const visible = (el: Element) =>
        (el as HTMLElement).getClientRects().length > 0 &&
        getComputedStyle(el).visibility !== "hidden";
      const list = (selector: string) =>
        Array.from(root.querySelectorAll<HTMLElement>(selector))
          .filter(visible)
          .map((el) => el.innerText.replace(/\s+/g, " ").trim())
          .filter(Boolean);
      return {
        promotions: list(".promotion-description"),
        warnings: list(".a-alert-content"),
      };
    });
  const payment = {
    ref: digest({
      account: context.accountRef,
      kind: "amazon_gift_card_balance",
    }),
    fingerprint: digest({
      account: context.accountRef,
      kind: "amazon_gift_card_balance",
      funding: facts.totals.funding,
    }),
    summary: "Amazon gift card balance",
  };
  const parsed = purchaseTermsSchema.safeParse({
    schemaVersion: 1,
    flow: "buy_now",
    reviewUrl: facts.reviewUrl,
    lines: [
      {
        asin: facts.line.asin,
        title: facts.line.title,
        sellerId: facts.line.sellerId,
        sellerName: facts.line.sellerName,
        quantity: facts.line.quantity,
        unitPrice: facts.line.unitPrice,
        condition: bound.offer.condition,
        purchaseMode: bound.offer.purchaseMode,
      },
    ],
    ...facts.totals,
    address: {
      ref: facts.address.fingerprint,
      fingerprint: facts.address.fingerprint,
      summary: facts.address.summary,
    },
    payment,
    shippingGroups: [
      {
        ref: digest({
          line: facts.line.lineIdentityHash,
          promise: facts.delivery.promise,
        }),
        delivery: facts.delivery.arrivalHeading ?? facts.delivery.promise,
        speed: facts.delivery.promise,
        asins: [facts.line.asin],
      },
    ],
    ...notices,
  });
  if (
    !parsed.success ||
    !origins.authorizesTerms(context, parsed.data) ||
    !(await getModernOrderControl(page, facts.reviewUrl))
  ) {
    origins.invalidate(context);
    return unsupported("modern_purchase_terms_unverified");
  }
  if ((await classifyPage(page)).kind !== "ready" || (await authForm(page)))
    return authFailure();
  if (
    modernCheckoutIdentity(page.url()) !== modernCheckoutIdentity(url) ||
    !origins.authorizesTerms(context, parsed.data)
  ) {
    origins.invalidate(context);
    return unsupported("modern_checkout_provenance_changed");
  }
  return {
    status: "ok",
    data: JSON.parse(JSON.stringify(parsed.data)),
    observation: {
      source: "amazon-web",
      observedAt: new Date().toISOString(),
      contextRef: context.accountRef,
      authentication: "verified",
    },
  };
}
export async function modernCheckoutSnapshot(
  page: Page,
  url: string,
  context: ProviderContext,
  origins: ModernCheckoutOrigins,
): Promise<Result> {
  const result = await loadModernPurchaseQuote(page, url, context, origins);
  return result.status === "ok"
    ? {
        ...result,
        data: {
          recognized: true,
          executableTerms: true,
          terms: result.data,
          revision: digest(result.data),
        },
        coverage: { complete: true, missing: [] },
      }
    : result;
}
