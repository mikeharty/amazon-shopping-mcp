import type { Page } from 'playwright';
import type { ProviderContext, Result } from '../../../contracts/index.js';
import { classifyPage, isVerifiedAuthenticatedAmazonPage } from '../../../browser-runtime/index.js';
import { digest } from '../../../store/crypto.js';

const routingKeys = ['pipelineType', 'isBuyNow', 'hasWorkingJavascript', 'purchaseId', 'checkoutSessionId', 'ref', 'ref_', 'referrer'];
export function isModernReviewCandidate(value: unknown): boolean {
  try { return typeof value === 'string' && new URL(value).pathname.startsWith('/checkout/p/p-'); } catch { return false; }
}
function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.amazon.com' && !url.username && !url.password && !url.hash &&
      /^\/checkout\/p\/p-\d{3}-\d{7}-\d{7}\/spc$/.test(url.pathname) &&
      [...url.searchParams.keys()].every((key) => routingKeys.includes(key) && url.searchParams.getAll(key).length === 1);
  } catch { return false; }
}
function routingIdentity(value: string) {
  const url = new URL(value);
  return JSON.stringify({ origin: url.origin, path: url.pathname, routing: ['pipelineType', 'isBuyNow', 'purchaseId', 'checkoutSessionId'].map((key) => [key, url.searchParams.getAll(key)]) });
}
async function hasAuthForm(page: Page): Promise<boolean> {
  return page.evaluate(() => Array.from(document.querySelectorAll('form[name="signIn"], form#ap_signin_form, input[name="email"], input[type="password"], input[name="otpCode"], input[name="code"], input[name="verificationCode"], input[autocomplete="cc-csc"], input[name="cvv"]')).some((el) => (el as HTMLElement).getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'));
}
const unsupported = (code: string): Result => ({ status: 'unsupported', error: { code, retryable: false } });
const authRequired = (): Result => ({ status: 'requires_user_action', error: { code: 'checkout_authentication_unverified', retryable: false } });

/** Read evidence only. Never produces purchase terms, an intent, or a dispatch. */
export async function readModernReviewDiagnostics(page: Page, value: unknown, context: ProviderContext): Promise<Result> {
  if (typeof value !== 'string' || !validUrl(value)) return unsupported('invalid_modern_review_url');
  // Authentication proof is fresh and local to this serialized provider operation.
  await page.goto('https://www.amazon.com/gp/your-account/order-history', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (new URL(page.url()).origin !== 'https://www.amazon.com' || (await classifyPage(page)).kind !== 'ready' || !await isVerifiedAuthenticatedAmazonPage(page) || await hasAuthForm(page)) return authRequired();
  await page.goto(value, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (!validUrl(page.url()) || routingIdentity(page.url()) !== routingIdentity(value)) return unsupported('modern_review_context_changed');
  if ((await classifyPage(page)).kind !== 'ready' || await hasAuthForm(page)) return authRequired();
  const raw = await page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const roots = Array.from(document.querySelectorAll<HTMLElement>('#checkout-experience-container')).filter(visible);
    if (roots.length !== 1) return undefined;
    const root = roots[0]!;
    const nodes = (selector: string) => Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(visible);
    const one = (selector: string) => { const found = nodes(selector); return found.length === 1 ? found[0] : undefined; };
    const review = one('#checkout-ric-review');
    const itemPanel = one('#checkout-item-block-panel');
    const totalPanel = one('#checkout-subtotals-section');
    if (!review || !itemPanel || !totalPanel) return undefined;
    const safeId = (value: string | null | undefined) => value && /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(value) ? value : undefined;
    const rendered = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (!(node instanceof HTMLElement) || !visible(node) || node.matches('input, select, textarea, script, style')) return '';
      if (node.tagName === 'BR') return '\n';
      const contents = Array.from(node.childNodes).map(rendered).join('');
      return /^(?:block|flow-root|flex|grid|list-item|table|table-row|table-cell)$/.test(getComputedStyle(node).display) ? `\n${contents}\n` : contents;
    };
    const clean = (value: string) => value.replace(/https?:\/\/[^\s]+/gi, (raw) => { try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '[URL]'; } })
      .replace(/\b(?:\d[ -]?){12,19}\b/g, '[redacted number]').replace(/\s+/g, ' ').trim().slice(0, 500);
    const lines = (el: HTMLElement) => rendered(el).split(/\n+/).map(clean).filter(Boolean).slice(0, 60);
    const structure = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('[id], [data-testid], input[name], select[name]')).filter(visible).slice(0, 60).map((node) => ({
      id: safeId(node.id), testId: safeId(node.getAttribute('data-testid')), tag: node.tagName.toLowerCase(), name: safeId(node.getAttribute('name')),
    }));
    const selections = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLInputElement>('input[type="radio"]')).flatMap((radio) => {
      const label = radio.closest('label') ?? (radio.id ? Array.from(el.querySelectorAll<HTMLLabelElement>('label[for]')).find((candidate) => candidate.htmlFor === radio.id) : undefined);
      return label && visible(label) ? [{ checked: radio.checked, label: clean(rendered(label)) }] : [];
    }).slice(0, 20);
    const itemRoots = Array.from(itemPanel.querySelectorAll<HTMLElement>('[id^="checkout-item-block-"]')).filter(visible)
      .filter((el) => /^checkout-item-block-\d+$/.test(el.id));
    const items = itemRoots.slice(0, 20).map((el) => {
      const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(visible).flatMap((link) => {
        try {
          const url = new URL(link.href);
          if (url.origin !== 'https://www.amazon.com' || url.username || url.password) return [];
          const asin = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
          const seller = url.searchParams.getAll('seller');
          const sellerId = seller.length === 1 && /^[A-Z0-9]{6,32}$/i.test(seller[0]!) ? seller[0]!.toUpperCase() : undefined;
          return asin || sellerId ? [{ ...(asin ? { asin } : {}), ...(sellerId ? { sellerId } : {}) }] : [];
        } catch { return []; }
      });
      return { id: el.id, observedLines: lines(el), links, structure: structure(el), selections: selections(el) };
    });
    const deliveryPanel = one('#checkout-ship-option-panel');
    const delivery = deliveryPanel ? { observedLines: lines(deliveryPanel), structure: structure(deliveryPanel), selections: selections(deliveryPanel) } : undefined;
    // No raw payment text, arbitrary payment IDs, field names, or values leave this callback.
    const paymentPanel = one('#checkout-payment-option-panel #checkout-paymentOptionPanel');
    const paymentText = paymentPanel ? rendered(paymentPanel) : '';
    const paymentMatches = [...paymentText.matchAll(/\b(Visa|Mastercard|Amex|American Express|Discover)\b\s*(?:card\s*)?(?:ending in|last four|\*{2,})\s*(\d{4})(?!\d)/gi)];
    const payment = paymentMatches.length === 1 ? { brand: paymentMatches[0]![1], lastFour: paymentMatches[0]![2], complete: true } : { complete: false };
    const finalPanel = one('#checkout-pyo-button-block');
    const finalControls = finalPanel ? Array.from(finalPanel.querySelectorAll<HTMLElement>('button, input[type="submit"]')).filter(visible).slice(0, 10).map((el) => {
      const input = el as HTMLInputElement;
      const destination = el.getAttribute('formaction') ?? input.form?.getAttribute('action');
      let path: string | undefined;
      try { if (destination) { const url = new URL(destination, location.href); if (url.origin === 'https://www.amazon.com' && !url.username && !url.password) path = url.pathname; } } catch { /* No invented target. */ }
      const associated = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).flatMap((id) => {
        const labels = Array.from(finalPanel.querySelectorAll<HTMLElement>('[id]')).filter((node) => node.id === id && visible(node));
        return labels.length === 1 ? [rendered(labels[0]!)] : [];
      }).join(' ');
      const widget = el.closest('.a-button');
      const announce = widget && finalPanel.contains(widget) ? Array.from(widget.querySelectorAll<HTMLElement>('.a-button-text')).filter(visible) : [];
      const label = el.getAttribute('aria-label') || (el instanceof HTMLInputElement ? el.value : rendered(el)) || associated || (announce.length === 1 ? rendered(announce[0]!) : '');
      return { id: safeId(el.id), name: safeId(el.getAttribute('name')), label: clean(label), path };
    }) : [];
    return { items, totals: { observedLines: lines(totalPanel), structure: structure(totalPanel) }, delivery, payment, finalControls };
  });
  if (!raw) return unsupported('modern_review_layout_unrecognized');
  return {
    status: 'partial', data: { diagnosticOnly: true, executableTerms: false, contextFingerprint: digest({ routing: routingIdentity(page.url()), accountRef: context.accountRef, sessionGeneration: context.sessionGeneration }),
      authenticationEvidence: 'same_run_account_page_and_modern_review', sections: raw, missing: ['executable_purchase_terms_not_extracted'] },
    observation: { source: 'amazon-web', observedAt: new Date().toISOString(), contextRef: context.accountRef, authentication: 'verified' },
    coverage: { complete: false, missing: ['executable_purchase_terms_not_extracted'] },
  };
}
