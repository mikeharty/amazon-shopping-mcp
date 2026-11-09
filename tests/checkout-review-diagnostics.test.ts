import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { AmazonWebProvider } from '../packages/providers/amazon-web/provider.js';
import { readModernReviewDiagnostics } from '../packages/providers/amazon-web/checkout/review-diagnostics.js';

const url = 'https://www.amazon.com/checkout/p/p-123-1111111-2222222/spc?pipelineType=Chewbacca&isBuyNow=1&hasWorkingJavascript=1';
const ctx = { ownerId: 'fixture-owner', accountRef: 'fixture-account', marketplace: 'amazon.com' as const, sessionGeneration: 1 };
const greeting = '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span>';
describe('Non-executable modern review diagnostics', () => {
  let browser: Browser, context: BrowserContext, page: Page, provider: AmazonWebProvider;
  let fixture: string, html: string, accountHtml: string, visits: string[], submissions: number;
  beforeAll(async () => { browser = await chromium.launch(); fixture = await readFile(new URL('fixtures/checkout-review-modern-diagnostics.html', import.meta.url), 'utf8'); });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => {
    html = fixture; accountHtml = greeting; visits = []; submissions = 0;
    context = await browser.newContext(); page = await context.newPage();
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname; visits.push(path);
      if (path.includes('place-order')) submissions++;
      return route.fulfill({ contentType: 'text/html', body: path.includes('order-history') ? accountHtml : html });
    });
    provider = new AmazonWebProvider({ sessionGeneration: 1, run: (fn) => fn(page), close: async () => {} });
  });
  afterEach(async () => { await context?.close(); });
  it('uses a fresh account proof and exposes only scoped rendered evidence, never executable terms', async () => {
    const result = await provider.read('checkout_get', { url }, ctx);
    expect(result).toMatchObject({ status: 'partial', observation: { authentication: 'verified' }, data: { diagnosticOnly: true, executableTerms: false, sections: {
      items: [{ id: 'checkout-item-block-0', links: [{ asin: 'B0FIXTURE1' }, { sellerId: 'A1FIXTURE' }] }], payment: { brand: 'Visa', lastFour: '4242', complete: true }, finalControls: [{ label: 'Place your order', path: '/checkout/spc/place-order' }],
    } } });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|HIDDEN_ITEM|OUTSIDE_PRIVATE_TEXT|FULL_CARD_PRIVATE|4111|paymentToken|offeringID|purchaseTerms|intentId/);
    expect(visits).toEqual(['/gp/your-account/order-history', '/checkout/p/p-123-1111111-2222222/spc']);
    await provider.read('checkout_get', { url }, ctx);
    expect(visits.filter((path) => path.includes('order-history'))).toHaveLength(2);
    expect(submissions).toBe(0);
  });
  it.each([
    url.replace('www.amazon.com', 'evil.example'), url + '&isBuyNow=0', url + '&unsafe=1', url + '#place-order', url.replace('/spc?', '/address?'), url.replace('https://', 'https://user:secret@'),
  ])('rejects unsafe URLs before any navigation: %s', async (target) => {
    expect(await readModernReviewDiagnostics(page, target, ctx)).toMatchObject({ status: 'unsupported', error: { code: 'invalid_modern_review_url' } });
    expect(visits).toEqual([]);
  });
  it.each(['account_missing', 'account_inline_signin', 'checkout_signin', 'checkout_payment'])('withholds review evidence for %s', async (failure) => {
    if (failure === 'account_missing') accountHtml = '<div>No greeting</div>';
    if (failure === 'account_inline_signin') accountHtml += '<input type="password">';
    if (failure === 'checkout_signin') html += '<form name="signIn"><input name="email"></form>';
    if (failure === 'checkout_payment') html += '<input name="cvv">';
    const result = await provider.read('checkout_get', { url }, ctx);
    expect(result.status).toBe('requires_user_action');
    expect(result.data).toBeUndefined(); expect(submissions).toBe(0);
  });
  it('rejects redirect to another purchase context', async () => {
    await page.route('**/spc?*', (route) => route.fulfill({ status: 302, headers: { location: 'https://www.amazon.com/checkout/p/p-999-1111111-2222222/spc' } }));
    expect(await provider.read('checkout_get', { url }, ctx)).toMatchObject({ status: 'unsupported', error: { code: 'modern_review_context_changed' } });
  });
  it.each(['hidden', 'duplicate', 'missing'])('rejects an %s recognized review root', async (kind) => {
    html = kind === 'hidden' ? '<div style="display:none">' + fixture + '</div>' : kind === 'duplicate' ? fixture + fixture : fixture.replace('id="checkout-item-block-panel"', 'id="unknown-panel"');
    expect(await provider.read('checkout_get', { url }, ctx)).toMatchObject({ status: 'unsupported', error: { code: 'modern_review_layout_unrecognized' } });
  });
  it('does not default absent quantity, mode, condition, discount or payment identity', async () => {
    html = html.replace(/<div id="item-(?:quantity|mode|condition)">[^<]*<\/div>/g, '').replace('<div>Discount: $0.00</div>', '').replace('Visa ending in 4242', 'Selected payment');
    const result = await provider.read('checkout_get', { url }, ctx);
    expect(result.status).toBe('partial');
    expect(JSON.stringify(result)).not.toMatch(/Qty:|One-time|Condition:|Discount:|one_time|"quantity"|"condition"/);
    expect(result).toMatchObject({ data: { sections: { payment: { complete: false } } } });
  });
  it('preserves the legacy checkout reader path', async () => {
    html = greeting + '<main id="checkout-review"></main>';
    const result = await provider.read('checkout_get', { url: 'https://www.amazon.com/checkout/p/review' }, ctx);
    expect(visits).toEqual(['/checkout/p/review']);
    expect((result.data as {diagnosticOnly?:boolean}).diagnosticOnly).toBeUndefined();
  });
  it('observes gp/product links, item delivery selection, and an explicitly associated final label', async () => {
    html = html.replace('/dp/B0FIXTURE1', '/gp/product/B0FIXTURE1').replace('</article>', '<label><input type="radio" checked value="SECRET_ITEM_DELIVERY">Friday delivery</label></article>').replace('value="Place your order"', 'aria-labelledby="final-announce"').replace('</form>', '<span id="final-announce">Place your order</span></form>');
    const result = await provider.read('checkout_get', { url }, ctx);
    expect(result).toMatchObject({ status: 'partial', data: { sections: { items: [{ links: [{ asin: 'B0FIXTURE1' }, { sellerId: 'A1FIXTURE' }], selections: [{ checked: true, label: 'Friday delivery' }] }], finalControls: [{ label: 'Place your order' }] } } });
    expect(JSON.stringify(result)).not.toContain('SECRET_ITEM_DELIVERY'); expect(submissions).toBe(0);
  });
});
