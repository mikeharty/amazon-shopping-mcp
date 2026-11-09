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
  const raw = await page.evaluate(async () => {
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
    const itemOwner = (node: Element): HTMLElement | undefined => {
      for (let parent: Element | null = node; parent && parent !== itemPanel; parent = parent.parentElement) if (/^checkout-item-block-\d+$/.test(parent.id)) return parent as HTMLElement;
      return undefined;
    };
    const items = await Promise.all(itemRoots.slice(0, 20).map(async (el) => {
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
      const owned = [el, ...Array.from(el.querySelectorAll<HTMLElement>('*')).filter(visible)].filter((node) => itemOwner(node) === el);
      const publicIdentity: { source: string; asin: string }[] = [];
      const explicitEnumObservations: { source: string; value: string }[] = [];
      const hashValue = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const lineIdentityHashes: { source: string; namespace: 'row_index' | 'line_identity'; sha256: string }[] = [];
      const urlMetadata: { source: string; path?: string; queryKeys: string[] }[] = [];
      const urlEncodingShapes: { jsonString: boolean; percentEncoded: boolean; decoded: boolean }[] = [];
      const parameterNames: string[] = [];
      const auiStructure: { source: string; fields: { path: string; type: string }[] }[] = [];
      const safeName = (value: string) => /^[A-Za-z][A-Za-z0-9_.:-]{0,59}$/.test(value) && !/(?:secret|credential|token|password|cvv|cardnumber)/i.test(value);
      const inputFields = Array.from(el.querySelectorAll<HTMLInputElement>('input')).filter(live => itemOwner(live) === el).slice(0, 40).map(input => ({ type: input.type, ...(safeName(input.name) ? { name: input.name } : {}) }));
      const stepperMetadata: unknown[] = [];
      const selectedOfferCandidates: { source: string; value: string }[] = [];
      const jsonLineCandidates: { source: string; value: string }[] = [];
      const auiState: { source: string; fields: { path: string; type: string }[] }[] = [];
      const auiKeys = new Set(['data','item','lineitem','items','lineitems','product','offer','offers','asin','sku','condition','conditiontype','purchasemode','purchaseoption','sellerid','merchantid','quantity','price','unitprice','subtotal','shipping','tax','discount','total','giftcardcredit','amount','currency','lineitemid','selectedofferid','selectedofferingid','offeringid','offerlistingid']);
      const keyForm = (key: string) => key.replace(/[_-]/g, '').toLowerCase();
      const liveItemField = (node: HTMLElement) => {
        if (itemOwner(node) !== el) return false;
        for (let parent = node.parentElement; parent && parent !== el; parent = parent.parentElement) {
          const style = getComputedStyle(parent); if (style.display === 'none' || style.visibility === 'hidden' || parent.matches('template')) return false;
        }
        return true;
      };
      for (const node of owned) {
        const productUrl = node.getAttribute('data-url');
        if (productUrl) try {
          let decodedUrl = productUrl;
          const jsonString = /^\s*"/.test(productUrl), percentEncoded = /%[0-9a-f]{2}/i.test(productUrl);
          if (productUrl.length > 8192) continue;
          for (let pass = 0; pass < 2; pass++) {
            if (/^\s*"/.test(decodedUrl)) { const value: unknown = JSON.parse(decodedUrl); if (typeof value !== 'string') break; decodedUrl = value; }
            else if (/%[0-9a-f]{2}/i.test(decodedUrl)) decodedUrl = decodeURIComponent(decodedUrl);
            else break;
          }
          if (urlEncodingShapes.length < 40) urlEncodingShapes.push({ jsonString, percentEncoded, decoded: decodedUrl !== productUrl });
          const parsed = new URL(decodedUrl, location.href);
          const asin = parsed.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1];
          if (parsed.origin === 'https://www.amazon.com' && !parsed.username && !parsed.password) {
            if (asin) publicIdentity.push({ source: 'data-url_product_route', asin: asin.toUpperCase() });
            for (const key of ['asin', 'ASIN', 'productASIN']) {
              const values = parsed.searchParams.getAll(key);
              if (values.length === 1 && /^[A-Z0-9]{10}$/i.test(values[0]!)) publicIdentity.push({ source: `data-url_query:${key}`, asin: values[0]!.toUpperCase() });
            }
            const segments = parsed.pathname.split('/').map((segment) => /^ref=/.test(segment) ? 'ref=[omitted]' : segment);
            const safePath = segments.every((segment) => segment.length <= 80 && !/^[A-Za-z0-9_=-]{24,}$/.test(segment) && !/%[0-9a-f]{2}/i.test(segment)) && parsed.pathname.length <= 512;
            if (urlMetadata.length < 40) urlMetadata.push({ source: 'data-url', ...(safePath ? { path: segments.join('/') } : {}), queryKeys: [...new Set(parsed.searchParams.keys())].filter((key) => /^[A-Za-z][A-Za-z0-9_.:-]{0,59}$/.test(key)).slice(0, 40) });
          }
        } catch { /* No identity is inferred from arbitrary URL text. */ }
        for (const name of ['data-line-item-id', 'data-lineitemid']) {
          const value = node.getAttribute(name);
          if (value && value.length <= 4096 && lineIdentityHashes.length < 40) lineIdentityHashes.push({ source: name, namespace: /^\d{1,6}$/.test(value) ? 'row_index' : 'line_identity', sha256: await hashValue(value) });
        }
        for (const name of ['data-pipeline-link-args', 'data-postdata', 'data-getdata', 'data-checkout-select-ship-option-radio', 'data-snappydategroup']) {
          const payload = node.getAttribute(name);
          if (!payload || payload.length > 100_000 || auiState.length >= 40) continue;
          const shapeFields: { path: string; type: string }[] = [];
          const shape = (value: unknown, path: string, depth: number): void => {
            if (depth > 5 || shapeFields.length >= 60) return;
            if (typeof value === 'string' && value.length <= 100_000 && /^\s*[\[{]/.test(value)) { try { shape(JSON.parse(value), path, depth + 1); } catch {} return; }
            if (!value || typeof value !== 'object') return;
            if (!Array.isArray(value)) {
              const pair = value as Record<string, unknown>;
              if (typeof pair.name === 'string' && safeName(pair.name) && parameterNames.length < 40) {
                parameterNames.push(pair.name);
              }
            }
            if (Array.isArray(value)) { for (const child of value.slice(0, 5)) shape(child, `${path}[]`, depth + 1); return; }
            for (const [key, child] of Object.entries(value)) {
              if (!safeName(key) || shapeFields.length >= 60) continue;
              const next = path ? `${path}.${key}` : key;
              shapeFields.push({ path: next, type: child === null ? 'null' : Array.isArray(child) ? 'array' : typeof child });
              shape(child, next, depth + 1);
            }
          };
          try { shape(JSON.parse(payload), '', 0); } catch {}
          if (shapeFields.length && auiStructure.length < 40) auiStructure.push({ source: name, fields: shapeFields });
          const fields: { path: string; type: string }[] = [];
          const visit = (value: unknown, path: string, depth: number) => {
            if (depth > 6 || fields.length >= 60) return;
            if (typeof value === 'string' && value.length <= 100_000 && /^\s*[\[{]/.test(value)) {
              try { visit(JSON.parse(value), path, depth + 1); } catch { /* Strings are never evaluated or emitted. */ }
              return;
            }
            if (!value || typeof value !== 'object') return;
            if (Array.isArray(value)) { for (const child of value.slice(0, 10)) visit(child, `${path}[]`, depth + 1); return; }
            for (const [key, child] of Object.entries(value)) {
              const normalizedKey = keyForm(key);
              if (!auiKeys.has(normalizedKey) || !/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(key)) continue;
              const next = path ? `${path}.${key}` : key;
              fields.push({ path: next, type: child === null ? 'null' : Array.isArray(child) ? 'array' : typeof child });
              // Public values only from the current line's scalar object, never
              // alternative products/offers arrays or generic payload strings.
              const selectedScalar = !next.includes('[]') && !/(?:^|\.)(?:offers?|products?)\./i.test(next);
              if (selectedScalar && typeof child === 'string') {
                if (['asin','sku'].includes(normalizedKey) && /^[A-Z0-9]{10}$/i.test(child)) publicIdentity.push({ source: `${name}:${next}`, asin: child.toUpperCase() });
                if (['condition','conditiontype'].includes(normalizedKey) && /^(?:New|Used|Renewed|Used - Like New|Used - Very Good|Used - Good|Used - Acceptable)$/i.test(child)) explicitEnumObservations.push({ source: `${name}:${next}`, value: child });
                if (normalizedKey === 'purchasemode' && /^(?:one_time|subscribe_and_save)$/i.test(child)) explicitEnumObservations.push({ source: `${name}:${next}`, value: child });
                if (normalizedKey === 'lineitemid' && child && child.length <= 4096) jsonLineCandidates.push({ source: `${name}:${next}`, value: child });
                if (['selectedofferid','selectedofferingid'].includes(normalizedKey) && child && child.length <= 4096) selectedOfferCandidates.push({ source: `${name}:${next}`, value: child });
              }
              visit(child, next, depth + 1); if (fields.length >= 60) break;
            }
          };
          try { visit(JSON.parse(payload), '', 0); } catch { continue; }
          if (fields.length) auiState.push({ source: name, fields });
        }
        for (const name of ['data-asin', 'data-csa-c-item-id', 'data-sku']) {
          const value = node.getAttribute(name);
          if (value && /^[A-Z0-9]{10}$/i.test(value)) publicIdentity.push({ source: name, asin: value.toUpperCase() });
        }
        for (const name of ['data-condition', 'data-condition-type', 'data-purchase-mode']) {
          const value = node.getAttribute(name);
          const valid = name === 'data-purchase-mode' ? /^(?:one_time|subscribe_and_save)$/i : /^(?:New|Used|Renewed|Used - Like New|Used - Very Good|Used - Good|Used - Acceptable)$/i;
          if (value && valid.test(value)) explicitEnumObservations.push({ source: name, value });
        }
      }
      // The only raw hidden value admitted is the known public ASIN field of this
      // visible item. Offer values remain inside Chromium and leave only as hashes.
      for (const input of Array.from(el.querySelectorAll<HTMLInputElement>('input#ASIN, input[name="ASIN"], input[name="asin"]'))) {
        if (liveItemField(input) && /^[A-Z0-9]{10}$/i.test(input.value)) publicIdentity.push({ source: 'public_asin_input', asin: input.value.toUpperCase() });
      }
      const quantityObservations: { source: string; quantity: number }[] = [];
      for (const node of owned) {
        const value = node.getAttribute('data-steppervalue');
        const component = node.getAttribute('data-a-component') ?? node.getAttribute('data-a-type') ?? '';
        if (value !== null && stepperMetadata.length < 20) {
          const ancestors: { attributeNames: string[]; labelCategory: string }[] = [];
          for (let parent: HTMLElement | null = node; parent && itemOwner(parent) === el && ancestors.length < 4; parent = parent.parentElement) {
            const label = parent.getAttribute('aria-label') ?? '';
            ancestors.push({ attributeNames: parent.getAttributeNames().filter(safeName).slice(0, 30), labelCategory: /^Change quantity of\s+/i.test(label) ? 'change_quantity' : /increase/i.test(label) ? 'increase' : /decrease/i.test(label) ? 'decrease' : 'other' });
          }
          stepperMetadata.push({ ...(safeName(component) ? { component } : {}), ...(safeName(node.getAttribute('name') ?? '') ? { name: node.getAttribute('name') } : {}), ...(/^\d{1,3}$/.test(value) ? { numericState: Number(value) } : {}), numericLeaves: [node, ...Array.from(node.querySelectorAll<HTMLElement>('*'))].filter(child => visible(child) && !child.children.length).map(child => rendered(child).trim()).filter(text => /^\d{1,3}$/.test(text)).slice(0, 20).map(Number), ancestors });
        }
        if (node.getAttribute('name') === 'checkout-quantity-stepper' && component === 'stepper' && value && /^\d{1,3}$/.test(value) && Number(value) > 0) {
          const displayed = [node, ...Array.from(node.querySelectorAll<HTMLElement>('*'))].filter(child => visible(child) && !child.children.length).map(child => rendered(child).trim()).filter(text => /^\d{1,3}$/.test(text)).map(Number);
          if (displayed.length && displayed.every(number => number === Number(value))) quantityObservations.push({ source: 'named_checkout_quantity_stepper_state_and_display', quantity: Number(value) });
        }
        let semanticWrapper: HTMLElement | undefined;
        for (let candidate: HTMLElement | null = node; candidate && itemOwner(candidate) === el; candidate = candidate.parentElement) {
          if (/^Change quantity of\s+\S/i.test(candidate.getAttribute('aria-label') ?? '') && visible(candidate)) { semanticWrapper = candidate; break; }
        }
        const labels = [node.getAttribute('aria-label') ?? '', rendered(node), ...(semanticWrapper ? [semanticWrapper.getAttribute('aria-label') ?? ''] : [])].map((text) => text.replace(/\s+/g, ' ').trim());
        if (semanticWrapper) {
          const numericLeaves = Array.from(node.querySelectorAll<HTMLElement>('*')).filter((child) => visible(child) && !child.matches('input, button, select, [role="button"]') && !child.children.length).map((child) => rendered(child).trim()).filter((text) => /^\d{1,3}$/.test(text));
          labels.push(...numericLeaves);
        }
        const numericLabels = labels.flatMap((text) => { const match = text.match(/^(?:(?:quantity|qty)\s*:?\s*)?(\d{1,3})$/i); return match ? [Number(match[1])] : []; });
        if (value && /^\d{1,3}$/.test(value) && Number(value) > 0 && (/^(?:a-)?stepper$/i.test(component) || node.hasAttribute('data-quantityupdateurl') || Boolean(semanticWrapper)) && labels.some((text) => /\b(?:quantity|qty)\b/i.test(text)) && numericLabels.length && numericLabels.every((number) => number === Number(value))) quantityObservations.push({ source: 'visible_quantity_stepper_state_and_label', quantity: Number(value) });
      }
      for (const control of Array.from(el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('select, input[type="number"]')).filter(visible)) {
        if (itemOwner(control) !== el || !/^(?:quantity|itemQuantity|quantityDropdown)(?:[._-]\d+)?$/i.test(control.name || control.id)) continue;
        const selected = control instanceof HTMLSelectElement ? (control.selectedOptions.length === 1 ? control.selectedOptions[0]!.value : undefined) : control.value;
        if (selected && /^\d{1,3}$/.test(selected) && Number(selected) > 0) quantityObservations.push({ source: control instanceof HTMLSelectElement ? 'selected_quantity_option' : 'quantity_number_input', quantity: Number(selected) });
      }
      const asins = [...new Set([...publicIdentity.map((entry) => entry.asin), ...links.flatMap((entry) => entry.asin ? [entry.asin] : [])])];
      for (const candidate of jsonLineCandidates.slice(0, Math.max(0, 40 - lineIdentityHashes.length))) lineIdentityHashes.push({ source: candidate.source, namespace: /^\d{1,6}$/.test(candidate.value) ? 'row_index' : 'line_identity', sha256: await hashValue(candidate.value) });
      const uniqueLineHashes = [...new Set(lineIdentityHashes.filter((entry) => entry.namespace === 'line_identity').map((entry) => entry.sha256))];
      const lineBound = asins.length <= 1 && uniqueLineHashes.length <= 1 && (asins.length === 1 || uniqueLineHashes.length === 1);
      const selectedOfferHashes: { source: string; sha256: string }[] = [];
      if (lineBound) for (const candidate of selectedOfferCandidates.slice(0, 20)) selectedOfferHashes.push({ source: candidate.source, sha256: await hashValue(candidate.value) });
      const offerTokenHashes: { source: string; asin: string; sha256: string }[] = [];
      if (asins.length === 1) for (const input of Array.from(el.querySelectorAll<HTMLInputElement>('input[name]')).filter((input) => /^(?:offeringID|offerListingID)(?:\.\d+)?$/i.test(input.name)).slice(0, 20)) {
        if (!liveItemField(input) || !/^(?:offeringID|offerListingID)(?:\.\d+)?$/i.test(input.name) || !input.value || input.value.length > 4096) continue;
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.value));
        offerTokenHashes.push({ source: /offering/i.test(input.name) ? 'offeringID' : 'offerListingID', asin: asins[0]!, sha256: Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, '0')).join('') });
      }
      const attributeNames = [...new Set(owned.flatMap((node) => node.getAttributeNames()))].filter((name) => /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(name)).slice(0, 80);
      return { id: el.id, observedLines: lines(el), links, structure: structure(el), selections: selections(el), attributeNames,
        ...(publicIdentity.length ? { publicIdentity: publicIdentity.slice(0, 40) } : {}), ...(urlMetadata.length ? { urlMetadata } : {}), ...(urlEncodingShapes.length ? { urlEncodingShapes } : {}), ...(parameterNames.length ? { parameterNames: [...new Set(parameterNames)] } : {}), ...(auiStructure.length ? { auiStructure } : {}), ...(inputFields.length ? { inputFields } : {}), ...(stepperMetadata.length ? { stepperMetadata } : {}), ...(lineBound && explicitEnumObservations.length ? { explicitEnumObservations: explicitEnumObservations.slice(0, 40) } : {}), ...(quantityObservations.length ? { quantityObservations: quantityObservations.slice(0, 20) } : {}), ...(offerTokenHashes.length ? { offerTokenHashes } : {}), ...(lineIdentityHashes.length ? { lineIdentityHashes } : {}), ...(selectedOfferHashes.length ? { selectedOfferHashes } : {}), ...(auiState.length ? { auiState } : {}) };
    }));
    const recognizedKeys = new Set(['checkout','checkoutstate','state','data','items','item','lineitems','lineitem','product','products','offer','offers','offering','asin','sku','condition','conditiontype','purchasemode','purchaseoption','sellerid','merchantid','quantity','price','unitprice','subtotal','shipping','shippingcharge','tax','discount','total','ordertotal','giftcard','giftcardcredit','giftcardamount','payment','payments','amount','currency','offeringid','offerlistingid']);
    const financialKeys = new Set(['asin','sku','condition','conditiontype','purchasemode','purchaseoption','sellerid','merchantid','quantity','price','unitprice','subtotal','shipping','shippingcharge','tax','discount','total','ordertotal','giftcard','giftcardcredit','giftcardamount','amount','currency','offeringid','offerlistingid']);
    const keyForm = (key: string) => key.replace(/[_-]/g, '').toLowerCase();
    const stateNodes = Array.from(root.querySelectorAll<HTMLElement>('script[type="application/json"], script[type="a-state"], [data-a-state]')).slice(0, 40);
    const structuredState = stateNodes.flatMap((node) => {
      for (let ancestor = node.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) if (!visible(ancestor)) return [];
      const item = itemOwner(node);
      if (item && !itemRoots.includes(item)) return [];
      let stateKey: string | undefined;
      try { const metadata = JSON.parse(node.getAttribute('data-a-state') ?? '{}'); if (typeof metadata.key === 'string' && recognizedKeys.has(keyForm(metadata.key))) stateKey = metadata.key; } catch { /* Metadata is optional; never evaluate it. */ }
      const payload = node.matches('script[type="application/json"], script[type="a-state"]') ? node.textContent : node.getAttribute('data-a-state');
      if (!payload || payload.length > 200_000) return [];
      const fields: { path: string; type: string }[] = [];
      const visit = (value: unknown, path: string, depth: number) => {
        if (depth > 8 || fields.length >= 100 || value === null || typeof value !== 'object') return;
        if (Array.isArray(value)) { for (const child of value.slice(0, 20)) visit(child, `${path}[]`, depth + 1); return; }
        for (const [key, child] of Object.entries(value)) {
          if (!recognizedKeys.has(keyForm(key)) || !/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(key)) continue;
          const next = path ? `${path}.${key}` : key;
          if (financialKeys.has(keyForm(key))) fields.push({ path: next, type: child === null ? 'null' : Array.isArray(child) ? 'array' : typeof child });
          visit(child, next, depth + 1);
          if (fields.length >= 100) break;
        }
      };
      try { visit(JSON.parse(payload), '', 0); } catch { return []; }
      return stateKey || fields.length ? [{ ...(stateKey ? { stateKey } : {}), ...(item ? { itemId: item.id } : {}), fields }] : [];
    });
    const deliveryPanel = one('#checkout-ship-option-panel');
    const delivery = deliveryPanel ? { observedLines: lines(deliveryPanel), structure: structure(deliveryPanel), selections: selections(deliveryPanel) } : undefined;
    // No raw payment text, arbitrary payment IDs, field names, or values leave this callback.
    const paymentPanel = one('#checkout-payment-option-panel #checkout-paymentOptionPanel');
    const paymentText = paymentPanel ? rendered(paymentPanel) : '';
    const paymentMatches = [...paymentText.matchAll(/\b(Visa|Mastercard|Amex|American Express|Discover)\b\s*(?:card\s*)?(?:ending in|last four|\*{2,})\s*(\d{4})(?!\d)/gi)];
    const totalLines = lines(totalPanel);
    const labelValues: { label: string; value: string }[] = [];
    const moneyText = /^-?\$\s*\d[\d,]*(?:\.\d{2})?$/;
    const totalLabel = /^(?:Items(?:\s*\(\d+\))?|Shipping(?:\s*(?:&|and)\s*handling)?|(?:Estimated\s+)?Tax(?:\s+to be collected)?|Discounts?|Promotions?(?:\s+applied)?|Total|Order total|Gift\s*cards?(?:\s*(?:balance|credit|applied))?)\s*:?$/i;
    for (let index = 0; index < totalLines.length; index++) {
      const line = totalLines[index]!; const pair = line.match(/^(.*?)\s*:?\s+(-?\$\s*\d[\d,]*(?:\.\d{2})?)$/);
      if (pair && totalLabel.test(pair[1]!)) labelValues.push({ label: pair[1]!.replace(/:$/, '').trim(), value: pair[2]! });
      else if (totalLabel.test(line) && moneyText.test(totalLines[index + 1] ?? '')) labelValues.push({ label: line.replace(/:$/, '').trim(), value: totalLines[++index]! });
    }
    const giftCardCredits = labelValues.filter((pair) => /^gift\s*card/i.test(pair.label));
    const payment = { ...(paymentMatches.length === 1 ? { brand: paymentMatches[0]![1], lastFour: paymentMatches[0]![2], complete: true } : { complete: false }),
      ...(giftCardCredits.length ? { giftCardCreditObserved: true, source: 'displayed_totals_gift_card_line' } : /gift\s*card(?:\s+balance)?\s+(?:applied|used)/i.test(paymentText) ? { giftCardCreditObserved: true, source: 'displayed_selected_payment_text' } : {}) };
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
    return { items, structuredState, totals: { observedLines: totalLines, structure: structure(totalPanel), labelValues, ...(giftCardCredits.length ? { giftCardCredits } : {}) }, delivery, payment, finalControls };
  });
  if (!raw) return unsupported('modern_review_layout_unrecognized');
  return {
    status: 'partial', data: { diagnosticOnly: true, executableTerms: false, contextFingerprint: digest({ routing: routingIdentity(page.url()), accountRef: context.accountRef, sessionGeneration: context.sessionGeneration }),
      authenticationEvidence: 'same_run_account_page_and_modern_review', sections: raw, missing: ['executable_purchase_terms_not_extracted'] },
    observation: { source: 'amazon-web', observedAt: new Date().toISOString(), contextRef: context.accountRef, authentication: 'verified' },
    coverage: { complete: false, missing: ['executable_purchase_terms_not_extracted'] },
  };
}
