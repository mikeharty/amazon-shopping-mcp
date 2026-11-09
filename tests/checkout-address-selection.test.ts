import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { AmazonWebProvider } from '../packages/providers/amazon-web/provider.js';
import type { ProviderContext, Result } from '../packages/contracts/index.js';

const ctx: ProviderContext = { ownerId: 'fixture-owner', accountRef: 'fixture-account', marketplace: 'amazon.com', sessionGeneration: 7 };
const addressUrl = 'https://www.amazon.com/checkout/p/p-123-1111111-2222222/address?isBuyNow=1&pipelineType=Chewbacca&referrer=checkout';
const reviewUrl = addressUrl.replace('/address?', '/review?');
const greeting = '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span>';
const parts = '<span>Fixture Owner</span><span>123 Example St</span><span>Apt 4</span><span>Seattle, WA 98101</span><span>United States</span>';
const applied = `<main id="checkout-delivery-address-panel" data-address-id="fixture-home"><div class="destination-data-alignment">${parts}</div></main>`;
function row(checked = true) {
  return `<span id="select-destination-on-sasp-desktop-panel-id-fixture" data-action="select-destination-on-sasp-desktop-panel" data-select-destination-on-sasp-desktop-panel="fixture"><div class="a-radio" data-a-input-name="destinationSubmissionUrl"><label><input type="radio" name="destinationSubmissionUrl" ${checked ? 'checked' : ''} value="/checkout/p/p-123-1111111-2222222/address/shiptodestination?pipelineType=Chewbacca&amp;isBuyNow=1&amp;addressID=fixture-home&amp;action=select-shipping&amp;encoding=UTF8&amp;referrer=checkout&amp;ref_=address_select"><div class="destination-data-alignment">${parts}<span>Phone number: 206-555-0100</span></div></label></div></span>`;
}
function addressPage(checked = true) {
  return `<main id="shipping-address-selection-panel">${row(checked)}</main><span id="checkout-primary-continue-button-id" class="a-button-primary continue-button primary-action-button"><span class="a-button-inner"><input type="submit" data-testid="bottom-continue-button"><span id="checkout-primary-continue-button-id-announce">Deliver to this address</span></span></span><script>document.querySelector('#checkout-primary-continue-button-id input').addEventListener('click',e=>{e.preventDefault();location.href=${JSON.stringify(reviewUrl)}})</script>`;
}

describe('Journal-adapter address selection without ordering', () => {
  let browser: Browser, context: BrowserContext, page: Page, provider: AmazonWebProvider;
  let addressHtml: string, reviewHtml: string, continueRequests: number;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => {
    addressHtml = addressPage(); reviewHtml = applied; continueRequests = 0;
    context = await browser.newContext(); page = await context.newPage();
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://www.amazon.com') return route.abort();
      if (url.pathname.endsWith('/review')) { continueRequests++; return route.fulfill({ contentType: 'text/html', body: reviewHtml }); }
      return route.fulfill({ contentType: 'text/html', body: url.pathname.includes('order-history') ? greeting : addressHtml });
    });
    provider = new AmazonWebProvider({ sessionGeneration: 7, run: (fn) => fn(page), close: async () => {} });
  });
  afterEach(async () => { await context?.close(); });
  async function input() {
    const result = await provider.read('checkout_addresses_get', { url: addressUrl }, ctx);
    expect(result.status).toBe('ok');
    const snapshot = result.data as { revision:string; contextFingerprint:string; addresses:{addressRef:string;fingerprint:string;physicalIdentity?:unknown}[] };
    expect(snapshot.addresses[0]?.physicalIdentity).toBeDefined();
    return { url: addressUrl, expectedRevision: snapshot.revision, expectedContextFingerprint: snapshot.contextFingerprint, expectedSessionGeneration: 7, addressRef: snapshot.addresses[0]!.addressRef, expectedFingerprint: snapshot.addresses[0]!.fingerprint };
  }
  it('continues an already-selected exact saved address and independently verifies applied identity without ordering', async () => {
    const result = await provider.mutate('checkout_address_select', await input(), ctx);
    expect(result).toMatchObject({ status: 'ok', data: { verification: 'saved_address_id_and_physical_destination', orderSubmitted: false, appliedAddress: { physicalIdentity: { recipient: 'FIXTURE OWNER', addressLines: ['123 EXAMPLE ST', 'APT 4'], city: 'SEATTLE', region: 'WA', postalCode: '98101', country: 'US' } } } });
    expect(continueRequests).toBe(1);
    expect((result.data as Record<string, unknown>).intentId).toBeUndefined();
  });
  it('reports physical-only verification when review omits saved ID and phone', async () => {
    reviewHtml = applied.replace(' data-address-id="fixture-home"', '');
    expect(await provider.mutate('checkout_address_select', await input(), ctx)).toMatchObject({ status: 'ok', data: { verification: 'physical_destination_only' } });
  });
  it('retains exact legacy select action support alongside observed modern select-shipping', async () => {
    addressHtml = addressHtml.replace('action=select-shipping', 'action=select');
    expect(await provider.mutate('checkout_address_select', await input(), ctx)).toMatchObject({ status: 'ok', data: { orderSubmitted: false } });
    expect(continueRequests).toBe(1);
  });
  it.each(['expectedRevision','expectedContextFingerprint','addressRef','expectedFingerprint','expectedSessionGeneration'])('blocks stale or changed %s before any effect', async (field) => {
    const args = await input();
    (args as Record<string, unknown>)[field] = field === 'expectedSessionGeneration' ? 6 : '0'.repeat(64);
    expect((await provider.mutate('checkout_address_select', args, ctx)).status).toBe('conflict');
    expect(continueRequests).toBe(0);
  });
  it.each([
    ['edit action', 'action=select-shipping', 'action=edit'],
    ['diagnostic-only action', 'action=select-shipping', 'action=shipToThisAddress'],
    ['default action', 'action=select-shipping', 'action=setDefaultAddress'],
    ['create action', 'action=select-shipping', 'action=createAddress'],
    ['wrong pipeline', 'pipelineType=Chewbacca&amp;isBuyNow=1&amp;addressID', 'pipelineType=Other&amp;isBuyNow=1&amp;addressID'],
    ['duplicate destination', 'addressID=fixture-home', 'addressID=fixture-home&amp;addressID=other'],
    ['order label', 'Deliver to this address', 'Place your order'],
    ['wrong test ID', 'bottom-continue-button', 'place-order-button'],
    ['inline handler', 'type="submit" data-testid', 'type="submit" onclick="return false" data-testid'],
  ])('rejects unsafe %s before Continue', async (_, from, to) => {
    addressHtml = addressHtml.replace(from, to);
    const result = await provider.mutate('checkout_address_select', await input(), ctx);
    expect(result.status).toBe('unsupported'); expect(continueRequests).toBe(0);
  });
  it.each([
    ['radio onchange', 'type="radio"', 'type="radio" onchange="window.inlineEffects++"'],
    ['radio onclick', 'type="radio"', 'type="radio" onclick="window.inlineEffects++"'],
    ['label handler', '<label>', '<label onpointerdown="window.inlineEffects++">'],
    ['declarative row handler', 'data-action="select-destination', 'onchange="window.inlineEffects++" data-action="select-destination'],
    ['Continue inner handler', 'class="a-button-inner"', 'class="a-button-inner" onkeydown="window.inlineEffects++"'],
    ['contradictory input value', 'type="submit" data-testid', 'type="submit" value="Place your order" data-testid'],
    ['contradictory aria label', 'type="submit" data-testid', 'type="submit" aria-label="Edit address" data-testid'],
    ['contradictory input name', 'type="submit" data-testid', 'type="submit" name="setDefaultAddress" data-testid'],
  ])('rejects %s before changing an unchecked radio or clicking Continue', async (_, from, to) => {
    addressHtml = addressPage(false).replace(from, to).replace('</script>', ';window.inlineEffects=0;window.radioEffects=0;document.querySelector(\'input[type="radio"]\').addEventListener(\'change\',()=>window.radioEffects++)</script>');
    const result = await provider.mutate('checkout_address_select', await input(), ctx);
    expect(result.status).toBe('unsupported'); expect(continueRequests).toBe(0);
    expect(await page.evaluate(() => ({ radio: (window as unknown as {radioEffects:number}).radioEffects, inline: (window as unknown as {inlineEffects:number}).inlineEffects }))).toEqual({ radio: 0, inline: 0 });
    expect(await page.locator('input[type="radio"]').isChecked()).toBe(false);
  });
  it.each([
    ['different applied street', applied.replace('123 Example St', '456 Wrong St')],
    ['different applied unit', applied.replace('Apt 4', 'Apt 5')],
    ['different saved ID', applied.replace('fixture-home', 'different-home')],
    ['missing independent summary', '<main id="checkout-delivery-address-panel">Address selection received</main>'],
  ])('returns outcome_unknown after effect with %s and permits read reconciliation without repeating selection', async (_, html) => {
    reviewHtml = html;
    const result = await provider.mutate('checkout_address_select', await input(), ctx);
    expect(result).toMatchObject({ status: 'outcome_unknown', error: { retryable: false } });
    expect(continueRequests).toBe(1);
    reviewHtml = applied;
    const reconciled = await provider.read('checkout_addresses_get', { url: addressUrl, reconcileCurrent: true }, ctx);
    expect(reconciled).toMatchObject({ status: 'ok', data: { reconciliationOnly: true } });
    expect(continueRequests).toBe(2); // A GET of review, never a second Continue.
  });
  it('treats radio auto-navigation as the first effect and never clicks a subsequent payment Continue', async () => {
    addressHtml = addressPage(false).replace('</script>', `;document.querySelector('input[type="radio"]').addEventListener('change',()=>{location.href=${JSON.stringify(reviewUrl)}})</script>`);
    reviewHtml = '<main id="checkout-delivery-address-panel">Unproven address</main><button id="checkout-primary-continue-button-id">Place your order</button>';
    expect(await provider.mutate('checkout_address_select', await input(), ctx)).toMatchObject({ status: 'outcome_unknown' });
    expect(continueRequests).toBe(1);
  }, 15_000);
});
