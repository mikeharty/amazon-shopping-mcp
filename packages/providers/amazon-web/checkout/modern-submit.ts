import type { Page } from "playwright";
import type { ProviderContext, Result } from "../../../contracts/index.js";
import type { PurchaseTerms } from "../../../core/purchasing.js";
import {
  classifyPage,
  isVerifiedAuthenticatedAmazonPage,
} from "../../../browser-runtime/index.js";
import { digest } from "../../../store/crypto.js";
import { extractOrders } from "../orders/index.js";
import { ModernCheckoutOrigins } from "./modern-origins.js";
import { loadModernPurchaseQuote } from "./modern-purchase.js";
import { getModernOrderControl } from "./modern-order-control.js";
import {
  readModernConfirmation,
  type ModernConfirmation,
} from "./modern-confirmation.js";
import { readModernOrderDetails } from "./modern-order-details.js";
import { verifyModernReceipt } from "./modern-receipt-verification.js";

const unsupported = (code: string): Result => ({
  status: "unsupported",
  error: { code, retryable: false },
});
/** Called only by the immutable, approved-intent executor. Never creates approval or retries a click. */
export async function submitModernPurchase(
  page: Page,
  terms: PurchaseTerms,
  context: ProviderContext,
  origins: ModernCheckoutOrigins,
  timing = { confirmationTimeoutMs: 15_000, pollIntervalMs: 250 },
): Promise<Result> {
  if (
    !Number.isFinite(timing.confirmationTimeoutMs) ||
    timing.confirmationTimeoutMs < 1 ||
    timing.confirmationTimeoutMs > 15_000 ||
    !Number.isFinite(timing.pollIntervalMs) ||
    timing.pollIntervalMs < 1 ||
    timing.pollIntervalMs > 250
  )
    return unsupported("invalid_confirmation_timing");
  if (!origins.authorizesTerms(context, terms))
    return unsupported("modern_checkout_origin_required");
  await page.goto("https://www.amazon.com/gp/your-account/order-history", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  const baseline = new URL(page.url());
  const historyURL =
    baseline.origin === "https://www.amazon.com" &&
    !baseline.username &&
    !baseline.password &&
    !baseline.hash &&
    /^(?:\/gp\/your-account\/order-history(?:\/ref=[A-Za-z0-9_-]+)?|\/your-orders\/orders)$/.test(
      baseline.pathname,
    );
  const authForm = await page
    .locator(
      'form[name="signIn"],form#checkpointForm,input[type="password"],input[name="email"],input[name="otpCode"],input[name="verificationCode"],input[name="cvv"],input[autocomplete="cc-csc"]',
    )
    .evaluateAll((nodes) =>
      nodes.some(
        (node) =>
          (node as HTMLElement).getClientRects().length > 0 &&
          getComputedStyle(node).visibility !== "hidden",
      ),
    );
  if (
    !historyURL ||
    (await classifyPage(page)).kind !== "ready" ||
    authForm ||
    !(await isVerifiedAuthenticatedAmazonPage(page))
  ) {
    origins.invalidate(context);
    return {
      status: "requires_user_action",
      error: { code: "checkout_authentication_unverified", retryable: false },
    };
  }
  const history = await extractOrders(page);
  if (!history.recognized || history.unparsedCount)
    return unsupported("order_reconciliation_baseline_missing");
  if (
    !history.orders.length &&
    !(await page
      .locator("#ordersContainer")
      .evaluateAll((nodes) =>
        nodes.some(
          (node) =>
            (node as HTMLElement).getClientRects().length > 0 &&
            /(?:you (?:haven't|have not) placed any orders|no orders)/i.test(
              (node as HTMLElement).innerText,
            ),
        ),
      ))
  )
    return unsupported("order_reconciliation_baseline_missing");
  const priorOrders = new Set(history.orders.map((order) => order.orderId));
  const fresh = await loadModernPurchaseQuote(
    page,
    terms.reviewUrl,
    context,
    origins,
  );
  if (fresh.status !== "ok") return fresh;
  if (digest(fresh.data) !== digest(terms))
    return {
      status: "conflict",
      error: { code: "TERMS_CHANGED_OR_UNVERIFIED", retryable: false },
    };
  const control = await getModernOrderControl(page, terms.reviewUrl);
  if (!control) return unsupported("final_purchase_control_unavailable");
  const expiry = Date.parse(context.intentExpiresAt ?? "");
  if (
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    !origins.authorizesTerms(context, terms)
  )
    return {
      status: "conflict",
      error: { code: "STALE_INTENT", retryable: false },
    };
  let confirmation: ModernConfirmation | undefined;
  const uncertain = (): Result => ({
    status: "outcome_unknown",
    error: { code: "PURCHASE_OUTCOME_UNKNOWN", retryable: false },
    data: {
      instructions:
        "Reconcile this operation through Amazon order records. Do not retry the purchase.",
      ...(confirmation
        ? { observedConfirmationOrderId: confirmation.orderId }
        : {}),
    },
  });
  try {
    // Effect boundary: every later error is uncertain, including click timeout.
    await control.click({ timeout: 5_000, noWaitAfter: true });
    const deadline = Date.now() + timing.confirmationTimeoutMs;
    while (Date.now() < deadline) {
      try {
        if ((await classifyPage(page)).kind !== "ready") return uncertain();
        confirmation = await readModernConfirmation(
          page,
          terms.reviewUrl,
          priorOrders,
        );
        if (confirmation) break;
      } catch {
        /* Navigation can destroy an execution context; only reads repeat. */
      }
      await page.waitForTimeout(timing.pollIntervalMs);
    }
    if (!confirmation) return uncertain();
    await page.goto(
      `https://www.amazon.com/gp/your-account/order-details?orderID=${confirmation.orderId}`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    if (
      (await classifyPage(page)).kind !== "ready" ||
      !(await isVerifiedAuthenticatedAmazonPage(page))
    )
      return uncertain();
    const receipt = await readModernOrderDetails(page, confirmation.orderId);
    if (!receipt) return uncertain();
    const verification = verifyModernReceipt(
      receipt,
      terms,
      confirmation.orderId,
      priorOrders,
    );
    if (!verification) return uncertain();
    return {
      status: "ok",
      data: {
        orderIds: [confirmation.orderId],
        verification,
        confirmation: {
          heading: confirmation.heading,
          identitySources: confirmation.identitySources,
        },
      },
      observation: {
        source: "amazon-web",
        observedAt: new Date().toISOString(),
        contextRef: context.accountRef,
        authentication: "verified",
      },
    };
  } catch {
    return uncertain();
  } finally {
    origins.invalidate(context);
  }
}
