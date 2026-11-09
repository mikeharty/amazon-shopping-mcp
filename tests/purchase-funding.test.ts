import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { createOwnerUi } from '../apps/gateway/owner-ui.js';
import { purchaseTermsSchema, type PurchaseTerms } from '../packages/core/purchasing.js';
import { digest } from '../packages/store/crypto.js';
import type { Store } from '../packages/store/index.js';
import { AmazonWebProvider } from '../packages/providers/amazon-web/provider.js';
import { purchaseQuote } from '../packages/providers/amazon-web/checkout/purchasing.js';

const money = (minorUnits: number) => ({ currency: 'USD' as const, minorUnits });
function legacyTerms(): PurchaseTerms {
  return {
    schemaVersion: 1, flow: 'buy_now', reviewUrl: 'https://www.amazon.com/checkout/p/review',
    lines: [{ asin: 'B0FIXTURE1', title: 'Fixture cable pack', sellerId: 'A1FIXTURE', quantity: 1, condition: 'New', purchaseMode: 'one_time', unitPrice: money(740) }],
    subtotal: money(740), shipping: money(0), tax: money(83), discount: money(0), total: money(823),
    address: { ref: 'fixture-address', fingerprint: 'a'.repeat(64), summary: 'Fixture Owner, 123 Example St, Seattle WA 98101' },
    payment: { ref: 'fixture-payment', fingerprint: 'b'.repeat(64), summary: 'Visa ending in 4242' },
    shippingGroups: [{ ref: 'fixture-shipment', delivery: 'November 10, 2026', speed: 'Free delivery', asins: ['B0FIXTURE1'] }], promotions: [], warnings: [],
  };
}
function fundedTerms(gift = 823): PurchaseTerms {
  const terms = legacyTerms();
  return { ...terms, funding: { giftCardApplied: money(gift), additionalAmountDue: money(823 - gift) }, payment: gift === 823 ? { ref: 'fixture-gift-balance', fingerprint: 'c'.repeat(64), summary: 'Amazon gift card balance' } : terms.payment };
}

describe('One-time purchase funding model', () => {
  it('keeps legacy terms byte-for-byte equivalent without adding funding defaults', () => {
    const legacy = legacyTerms();
    const parsed = purchaseTermsSchema.parse(legacy);
    expect(parsed).toEqual(legacy); expect(parsed).not.toHaveProperty('funding');
    expect(digest(parsed)).toBe(digest(legacy));
  });
  it.each([823, 500, 0])('preserves gross price when %i cents are paid from gift-card balance', (gift) => {
    const parsed = purchaseTermsSchema.parse(fundedTerms(gift));
    expect(parsed.total.minorUnits).toBe(823); expect(parsed.discount.minorUnits).toBe(0);
    expect(parsed.funding!.giftCardApplied.minorUnits + parsed.funding!.additionalAmountDue.minorUnits).toBe(823);
  });
  it.each([
    ['negative gift credit', (t: PurchaseTerms) => { t.funding!.giftCardApplied.minorUnits = -1; }],
    ['negative additional payment', (t: PurchaseTerms) => { t.funding!.additionalAmountDue.minorUnits = -1; }],
    ['overfunding', (t: PurchaseTerms) => { t.funding!.giftCardApplied.minorUnits = 824; }],
    ['funding mismatch', (t: PurchaseTerms) => { t.funding!.additionalAmountDue.minorUnits = 1; }],
    ['gross total confused with cash due', (t: PurchaseTerms) => { t.total.minorUnits = 0; }],
    ['gift card confused with discount', (t: PurchaseTerms) => { t.discount.minorUnits = 823; }],
    ['line price mismatch', (t: PurchaseTerms) => { t.lines[0]!.unitPrice.minorUnits = 741; }],
    ['noninteger funding', (t: PurchaseTerms) => { t.funding!.giftCardApplied.minorUnits = 822.5; }],
  ] as const)('rejects %s', (_, change) => {
    const terms = fundedTerms(); change(terms);
    expect(purchaseTermsSchema.safeParse(terms).success).toBe(false);
  });
  it('rejects a non-USD funding currency or incomplete funding object', () => {
    expect(purchaseTermsSchema.safeParse({ ...fundedTerms(), funding: { giftCardApplied: { currency: 'CAD', minorUnits: 823 }, additionalAmountDue: money(0) } }).success).toBe(false);
    expect(purchaseTermsSchema.safeParse({ ...fundedTerms(), funding: { giftCardApplied: money(823), additionalAmountDue: { currency: 'CAD', minorUnits: 0 } } }).success).toBe(false);
    expect(purchaseTermsSchema.safeParse({ ...fundedTerms(), funding: { giftCardApplied: money(823) } }).success).toBe(false);
  });
  it.each([true, false])('rejects gift funding for recurring terms, including immediate-order=%s', (createsImmediateOrder) => {
    const terms = fundedTerms(); terms.flow = 'subscribe_and_save'; terms.lines[0]!.purchaseMode = 'subscribe_and_save';
    terms.recurring = { frequencyRef: '2', frequency: 'Every 2 months', nextDelivery: 'January 10, 2027', discount: '5%', futurePricePolicy: 'Future prices may change', createsImmediateOrder };
    expect(purchaseTermsSchema.safeParse(terms).success).toBe(false);
  });
  it('binds funding changes and funding omission into the existing exact-term digest', () => {
    const full = purchaseTermsSchema.parse(fundedTerms()); const split = purchaseTermsSchema.parse(fundedTerms(500));
    expect(full.total).toEqual(split.total); expect(digest(full)).not.toBe(digest(split));
    expect(digest(full)).not.toBe(digest(purchaseTermsSchema.parse(legacyTerms())));
  });
  it('stops a funded intent when the fresh supported quote lacks funding, before clicking any purchase control', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage(); let submitted = 0;
      const fixture = await readFile(new URL('./fixtures/purchase-review.html', import.meta.url), 'utf8');
      await page.route('**/*', (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.includes('place-order')) submitted++;
        return route.fulfill({ contentType: 'text/html', body: path.includes('order-history') ? '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span><main id="ordersContainer">No orders</main>' : fixture });
      });
      const provider = new AmazonWebProvider({ sessionGeneration: 1, run: (fn) => fn(page), close: async () => {} });
      await page.goto('https://www.amazon.com/checkout/p/review');
      const fresh = await purchaseQuote(page, 'buy_now'); expect(fresh.status).toBe('ok');
      const terms = fresh.data as PurchaseTerms;
      terms.funding = { giftCardApplied: money(terms.total.minorUnits), additionalAmountDue: money(0) };
      const result = await provider.mutate('checkout_submit', purchaseTermsSchema.parse(terms), { ownerId: 'fixture-owner', accountRef: 'fixture-account', marketplace: 'amazon.com', sessionGeneration: 1, intentExpiresAt: new Date(Date.now() + 60000).toISOString() });
      expect(result).toMatchObject({ status: 'conflict', error: { code: 'TERMS_CHANGED_OR_UNVERIFIED' } }); expect(submitted).toBe(0);
    } finally { await browser.close(); }
  });
});

describe('Private owner approval funding display', () => {
  async function review(terms: PurchaseTerms) {
    const id = randomUUID(); let approvals = 0;
    const intent = { id, account_id: 'fixture-account', kind: 'checkout_submit', terms, digest: digest(terms), session_generation: 1, expires_at: new Date(Date.now() + 60000), consumed_at: null };
    const store = { getIntent: async () => intent, getAccount: async () => ({ enabled: true, quarantined: false, session_generation: 1 }), approve: async () => { approvals++; } } as unknown as Store;
    const origin = 'http://127.0.0.1:3433'; const token = 'fixture-owner-token';
    const ui = createOwnerUi(store, { ownerId: 'fixture-owner', ownerToken: token, origin });
    const privatePath = `${origin}/owner/intents/${id}`;
    const unauthenticated = await (await ui(new Request(privatePath))).text();
    expect(unauthenticated).toContain('Owner sign-in'); expect(unauthenticated).not.toContain('Purchase total');
    const login = await ui(new Request(`${origin}/owner/login`, { method: 'POST', headers: { origin }, body: new URLSearchParams({ token }) }));
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const html = await (await ui(new Request(privatePath, { headers: { cookie } }))).text();
    expect(approvals).toBe(0); expect(html).toContain('Approve these exact terms once'); expect(html).toContain(`name="digest" value="${intent.digest}"`);
    return html;
  }
  it('shows gross purchase amount, gift card use and zero additional payment separately', async () => {
    const html = await review(fundedTerms());
    expect(html).toContain('Purchase total: $8.23'); expect(html).toContain('Gift card balance used: $8.23'); expect(html).toContain('Additional payment due: $0.00');
    expect(html).not.toContain('Purchase total: $0.00'); expect(html).not.toContain('Total charged for this order: $0.00');
  });
  it('shows partial gift funding and the observed remaining payment identity', async () => {
    const html = await review(fundedTerms(500));
    expect(html).toContain('Purchase total: $8.23'); expect(html).toContain('Gift card balance used: $5.00'); expect(html).toContain('Additional payment due: $3.23'); expect(html).toContain('Visa ending in 4242');
  });
  it('preserves legacy owner amount labels and omits funding rows when funding is absent', async () => {
    const html = await review(legacyTerms());
    expect(html).toContain('Total charged for this order: $8.23'); expect(html).not.toContain('Gift card balance used:'); expect(html).not.toContain('Additional payment due:');
  });
});
