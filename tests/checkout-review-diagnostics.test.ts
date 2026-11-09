import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { AmazonWebProvider } from '../packages/providers/amazon-web/provider.js';
import { readModernReviewDiagnostics } from '../packages/providers/amazon-web/checkout/review-diagnostics.js';
import { createHash } from 'node:crypto';

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
    context = await browser.newContext({ offline: true }); page = await context.newPage();
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
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|HIDDEN_ITEM|OUTSIDE_PRIVATE_TEXT|FULL_CARD_PRIVATE|4111|paymentToken|purchaseTerms|intentId/);
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
    const target = 'https://www.amazon.com/checkout/p/p-999-1111111-2222222/spc';
    await page.route('**/spc?*', (route) => route.fulfill({ contentType: 'text/html', body: html.replace('<body>', `<body><script>history.replaceState(null,'',${JSON.stringify(target)})</script>`) }));
    expect(await provider.read('checkout_get', { url }, ctx)).toMatchObject({ status: 'unsupported', error: { code: 'modern_review_context_changed' } });
  });
  it.each(['cosmetic_tracking', 'purchase_mode', 'pipeline', 'checkout_session'])('checks transaction identity across %s redirects', async (kind) => {
    const target = kind === 'cosmetic_tracking' ? url.replace('hasWorkingJavascript=1', 'referrer=address')
      : kind === 'purchase_mode' ? url.replace('isBuyNow=1', 'isBuyNow=0')
      : kind === 'pipeline' ? url.replace('pipelineType=Chewbacca', 'pipelineType=Other') : url + '&checkoutSessionId=fixture-other-session';
    await page.route('**/spc?*', (route) => route.fulfill({ contentType: 'text/html', body: html.replace('<body>', `<body><script>history.replaceState(null,'',${JSON.stringify(target)})</script>`) }));
    const result = await provider.read('checkout_get', { url }, ctx);
    expect(result, JSON.stringify({result,pageUrl:page.url(),target,requested:url})).toMatchObject(kind === 'cosmetic_tracking'
      ? { status: 'partial', data: { diagnosticOnly: true, executableTerms: false } }
      : { status: 'unsupported', error: { code: 'modern_review_context_changed' } });
    expect(submissions).toBe(0);
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
  it('reads only explicit selected-item public identity, typed enums, quantity state and hashed offer linkage', async () => {
    html = html.replace('id="checkout-item-block-0"', 'id="checkout-item-block-0" data-asin="B0FIXTURE1" data-condition="New" data-purchase-mode="one_time"').replace('</article>', '<select name="quantity"><option value="1">1</option><option selected value="2">2</option></select><input type="hidden" name="ASIN" value="B0FIXTURE1"><input type="hidden" name="csrfToken" value="SECRET_CSRF"></article>');
    const result = await provider.read('checkout_get', { url }, ctx);
    expect(result).toMatchObject({ status: 'partial', data: { executableTerms: false, sections: { items: [{
      publicIdentity: [{ source: 'data-asin', asin: 'B0FIXTURE1' }, { source: 'public_asin_input', asin: 'B0FIXTURE1' }],
      explicitEnumObservations: [{ source: 'data-condition', value: 'New' }, { source: 'data-purchase-mode', value: 'one_time' }],
      quantityObservations: [{ source: 'selected_quantity_option', quantity: 2 }],
      offerTokenHashes: [{ source: 'offeringID', asin: 'B0FIXTURE1', sha256: createHash('sha256').update('SECRET_OFFER').digest('hex') }],
    }] } } });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|csrfToken/); expect(submissions).toBe(0);
  });
  it('observes structured state paths and types only while excluding unknown keys and all JSON values', async () => {
    html = html.replace('</article>', '<script type="a-state" data-a-state=\'{"key":"checkoutState"}\'>{"items":[{"asin":"SECRET_ASIN","condition":"SECRET_CONDITION","purchaseMode":"SECRET_MODE","quantity":7,"offeringID":"SECRET_OFFERING","unknownSecretKey":"SECRET_UNKNOWN","payment":{"cardNumber":"4111111111111111","cvv":"987"}}],"csrfToken":"SECRET_TOKEN"}</script></article>');
    const result = await provider.read('checkout_get', { url }, ctx);
    expect(result).toMatchObject({ data: { sections: { structuredState: [{ stateKey: 'checkoutState', itemId: 'checkout-item-block-0', fields: [
      { path: 'items[].asin', type: 'string' }, { path: 'items[].condition', type: 'string' }, { path: 'items[].purchaseMode', type: 'string' }, { path: 'items[].quantity', type: 'number' }, { path: 'items[].offeringID', type: 'string' },
    ] }] } } });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|unknownSecretKey|cardNumber|cvv|csrfToken|4111111111111111|987/);
  });
  it('does not infer item values from JSON, unrecognized enums, unrelated inputs or hidden templates', async () => {
    html = html.replace(/<a href="https:\/\/www.amazon.com\/dp\/[^>]+>Fixture cable<\/a>/, '<span>Fixture cable</span>').replace('id="checkout-item-block-0"', 'id="checkout-item-block-0" data-condition="SECRET_UNKNOWN" data-purchase-mode="standard"').replace('</article>', '<div style="display:none"><input name="ASIN" value="B0HIDDEN01"><input name="offeringID" value="SECRET_HIDDEN_OFFER"></div><input type="hidden" name="quantity" value="1"><script type="application/json">{"asin":"B0FIXTURE1","condition":"New","purchaseMode":"one_time"}</script></article>');
    const result = await provider.read('checkout_get', { url }, ctx);
    const item = (result.data as {sections:{items:Record<string,unknown>[]}}).sections.items[0]!;
    expect(item.publicIdentity).toBeUndefined(); expect(item.explicitEnumObservations).toBeUndefined(); expect(item.quantityObservations).toBeUndefined(); expect(item.offerTokenHashes).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|B0HIDDEN01/);
  });
  it('withholds offer binding on ambiguous public item identity and excludes structured hidden templates', async () => {
    html = html.replace('id="checkout-item-block-0"', 'id="checkout-item-block-0" data-asin="B0OTHER001"').replace('</article>', '<div style="display:none"><script type="application/json">{"tax":1,"condition":"SECRET_HIDDEN_STATE"}</script></div></article>');
    const result = await provider.read('checkout_get', { url }, ctx);
    expect((result.data as {sections:{items:Record<string,unknown>[],structuredState:unknown[]}}).sections.items[0]!.offerTokenHashes).toBeUndefined();
    expect((result.data as {sections:{structuredState:unknown[]}}).sections.structuredState).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('SECRET_HIDDEN_STATE');
  });
  it('observes gift-card credit and gross/net totals without treating credit as a discount or synthesizing missing fields', async () => {
    html = html.replace('<div>Order total: $26.40</div>', '<div>Total: $26.40</div><div>Gift Card:</div><div>-$26.40</div><div>Order total: $0.00</div>').replace('Visa ending in 4242', 'Gift card balance applied').replace('<div>Discount: $0.00</div>', '');
    const result = await provider.read('checkout_get', { url }, ctx);
    expect(result).toMatchObject({ status: 'partial', data: { executableTerms: false, sections: { totals: { giftCardCredits: [{ label: 'Gift Card', value: '-$26.40' }] }, payment: { complete: false, giftCardCreditObserved: true, source: 'displayed_totals_gift_card_line' } } } });
    expect(JSON.stringify(result)).not.toContain('Discount');
    expect((result.data as {sections:{totals:{labelValues:unknown[]}}}).sections.totals.labelValues).toContainEqual({ label: 'Order total', value: '$0.00' });
  });
  it('reads explicit AUI product routes, line-bound scalar enums, quantity stepper and hashed identities', async () => {
    html = html.replace(/<a href="https:\/\/www.amazon.com\/dp\/[^>]+>Fixture cable<\/a>/, '<span data-url="/gp/product/B0FIXTURE1?token=SECRET_URL">Fixture cable</span>')
      .replace('id="checkout-item-block-0"', 'id="checkout-item-block-0" data-line-item-id="SECRET_LINE"')
      .replace('</article>', '<div data-pipeline-link-args=\'{"asin":"B0FIXTURE1","condition":"New","purchaseMode":"one_time","selectedOfferId":"SECRET_SELECTED_OFFER","unknownCredential":"SECRET_CREDENTIAL"}\'>Product control</div><div data-a-component="stepper" data-steppervalue="2" aria-label="Quantity">2</div></article>');
    const result = await provider.read('checkout_get', { url }, ctx);
    expect(result).toMatchObject({ status: 'partial', data: { executableTerms: false, sections: { items: [{
      publicIdentity: [{ source: 'data-url_product_route', asin: 'B0FIXTURE1' }, { source: 'data-pipeline-link-args:asin', asin: 'B0FIXTURE1' }],
      explicitEnumObservations: [{ source: 'data-pipeline-link-args:condition', value: 'New' }, { source: 'data-pipeline-link-args:purchaseMode', value: 'one_time' }],
      quantityObservations: [{ source: 'visible_quantity_stepper_state_and_label', quantity: 2 }],
      lineIdentityHashes: [{ source: 'data-line-item-id', sha256: createHash('sha256').update('SECRET_LINE').digest('hex') }],
      selectedOfferHashes: [{ source: 'data-pipeline-link-args:selectedOfferId', sha256: createHash('sha256').update('SECRET_SELECTED_OFFER').digest('hex') }],
    }] } } });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|unknownCredential/);
  });
  it('reads bounded nested JSON, separates row indices and observes a semantic quantity wrapper', async () => {
    const payload = JSON.stringify({ lineItems: JSON.stringify({ asin: 'B0FIXTURE1', condition: 'New', purchaseMode: 'one_time', lineItemId: 'SECRET_LINE', credential: 'SECRET_NESTED' }) });
    html = html.replace('id="checkout-item-block-0"', 'id="checkout-item-block-0" data-line-item-id="0" data-lineitemid="SECRET_LINE"')
      .replace('</article>', `<div data-postdata='${payload}'>Control</div><div aria-label="Change quantity of Fixture cable"><div data-steppervalue="1"><button>Decrease</button><span>1</span><button>Increase</button></div></div></article>`);
    const result = await provider.read('checkout_get', { url }, ctx);
    const item = (result.data as {sections:{items:Record<string,unknown>[]}}).sections.items[0]!;
    expect(item.lineIdentityHashes).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'data-line-item-id', namespace: 'row_index' }),
      expect.objectContaining({ source: 'data-lineitemid', namespace: 'line_identity' }),
    ]));
    expect(item.explicitEnumObservations).toEqual(expect.arrayContaining([{ source: 'data-postdata:lineItems.condition', value: 'New' }]));
    expect(item.quantityObservations).toEqual([{ source: 'visible_quantity_stepper_state_and_label', quantity: 1 }]);
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|credential/);
  });
  it('returns sanitized URL structure and explicit public query ASIN without query values or opaque paths', async () => {
    html = html.replace('</article>', '<span data-url="/gp/product/B0FIXTURE1/ref=SECRET_TRACK?asin=B0FIXTURE1&amp;token=SECRET_QUERY">Product</span><span data-url="/checkout/ABCDEFGHIJKLMNOPQRSTUVWXYZ123456?token=SECRET_OTHER">Control</span></article>');
    const result = await provider.read('checkout_get', { url }, ctx);
    const item = (result.data as {sections:{items:Record<string,unknown>[]}}).sections.items[0]!;
    expect(item.urlMetadata).toEqual([
      { source: 'data-url', path: '/gp/product/B0FIXTURE1/ref=[omitted]', queryKeys: ['asin', 'token'] },
      { source: 'data-url', queryKeys: ['token'] },
    ]);
    expect(item.publicIdentity).toEqual(expect.arrayContaining([{ source: 'data-url_query:asin', asin: 'B0FIXTURE1' }]));
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
  });
  it('exposes only recognized AUI field paths/types without promoting unbound enums or alternative offers', async () => {
    html = html.replace(/<a href="https:\/\/www.amazon.com\/dp\/[^>]+>Fixture cable<\/a>/, '<span>Fixture cable</span>')
      .replace('</article>', '<div data-postdata=\'{"condition":"New","purchaseMode":"one_time","offers":[{"asin":"B0OTHER001","condition":"Used"}],"secretKey":"SECRET_VALUE"}\'>Control</div><div data-getdata=\'{"price":{"amount":7.40,"currency":"USD"},"cvv":"SECRET_CVV"}\'>Other control</div></article>');
    const result = await provider.read('checkout_get', { url }, ctx);
    const item = (result.data as {sections:{items:Record<string,unknown>[]}}).sections.items[0]!;
    expect(item.publicIdentity).toBeUndefined(); expect(item.explicitEnumObservations).toBeUndefined(); expect(item.selectedOfferHashes).toBeUndefined();
    expect(item.auiState).toEqual(expect.arrayContaining([{ source: 'data-getdata', fields: [{ path: 'price', type: 'object' }, { path: 'price.amount', type: 'number' }, { path: 'price.currency', type: 'string' }] }]));
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|secretKey|cvv|B0OTHER001/);
  });
  it.each([
    '<span data-url="https://evil.example/dp/B0OTHER001">Product</span>',
    '<span data-url="/checkout/modify?unknownProduct=B0OTHER001">Product</span>',
    '<span data-pipeline-link-args="not JSON asin B0OTHER001">Product</span>',
    '<span style="display:none" data-pipeline-link-args=\'{"asin":"B0OTHER001"}\'>Product</span>',
  ])('never invents public identity from unsafe, arbitrary or hidden AUI fields %#', async (fields) => {
    html = html.replace(/<a href="https:\/\/www.amazon.com\/dp\/[^>]+>Fixture cable<\/a>/, '<span>Fixture cable</span>').replace('</article>', fields + '</article>');
    const result = await provider.read('checkout_get', { url }, ctx);
    expect((result.data as {sections:{items:Record<string,unknown>[]}}).sections.items[0]!.publicIdentity).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('B0OTHER001');
  });
  it.each([
    '<div aria-label="Change quantity of Fixture cable"><div data-steppervalue="2"><span>1</span></div></div>',
    '<div data-a-component="stepper" data-steppervalue="2" aria-label="Quantity">1</div>',
    '<div data-a-component="stepper" data-steppervalue="2">2</div>',
    '<div data-steppervalue="2" aria-label="Quantity">2</div>',
  ])('requires recognized stepper state and agreeing visible quantity evidence %#', async (fields) => {
    html = html.replace('</article>', fields + '</article>');
    const result = await provider.read('checkout_get', { url }, ctx);
    expect((result.data as {sections:{items:Record<string,unknown>[]}}).sections.items[0]!.quantityObservations).toBeUndefined();
  });
});
