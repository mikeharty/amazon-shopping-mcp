import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { parseAddressLines, readAppliedShippingAddress, samePhysicalAddress, shippingIdentity, type ShippingIdentity } from '../packages/providers/amazon-web/checkout/address-identity.js';

const home = ['Jamie Example', '123 Example Street', 'Apartment 4B', 'Seattle, Washington 98101-1234', 'United States'];

describe('Complete physical delivery identity', () => {
  it('normalizes supported street/state/country forms and excludes explicit phone/control lines', () => {
    const parsed = shippingIdentity([...home, 'Phone number: +1 (206) 555-0100', 'Edit address']);
    expect(parsed).toEqual({ recipient: 'JAMIE EXAMPLE', addressLines: ['123 EXAMPLE ST', 'APT 4B'], city: 'SEATTLE', region: 'WA', postalCode: '98101-1234', country: 'US' });
    expect(samePhysicalAddress(parsed, parseAddressLines(['Jamie Example', '123 Example St. Apt. 4B', 'Seattle, WA, 98101-1234, US']))).toBe(true);
  });
  it('omits the observed phone and edit-controls span without supplying absent address fields', () => {
    const phoneControls = 'Phone number: +1 (206) 555-0100 Edit address | Add delivery instructions';
    expect(parseAddressLines([...home, phoneControls])).toEqual(parseAddressLines(home));
    expect(parseAddressLines([...home.slice(0, -1), phoneControls])).toBeUndefined();
    expect(parseAddressLines([...home.filter((_, index) => index !== 1), phoneControls])).toBeUndefined();
  });
  it('preserves meaningful number punctuation', () => {
    expect(samePhysicalAddress(parseAddressLines(home.map((line) => line.replace('4B', '4.2'))), parseAddressLines(home.map((line) => line.replace('4B', '42'))))).toBe(false);
  });
  it.each([
    ['unit', ['Jamie Example', '123 Example St', 'Apt 5B', 'Seattle, WA 98101-1234', 'US']],
    ['missing unit', ['Jamie Example', '123 Example St', 'Seattle, WA 98101-1234', 'US']],
    ['zip', ['Jamie Example', '123 Example St Apt 4B', 'Seattle, WA 98102-1234', 'US']],
    ['zip extension', ['Jamie Example', '123 Example St Apt 4B', 'Seattle, WA 98101', 'US']],
    ['recipient', ['Taylor Example', '123 Example St Apt 4B', 'Seattle, WA 98101-1234', 'US']],
    ['city', ['Jamie Example', '123 Example St Apt 4B', 'Tacoma, WA 98101-1234', 'US']],
    ['region', ['Jamie Example', '123 Example St Apt 4B', 'Seattle, OR 98101-1234', 'US']],
    ['street number', ['Jamie Example', '124 Example St Apt 4B', 'Seattle, WA 98101-1234', 'US']],
    ['country', ['Jamie Example', '123 Example St Apt 4B', 'Seattle, WA 98101-1234', 'Canada']],
  ])('does not match a changed %s', (_, changed) => {
    expect(samePhysicalAddress(parseAddressLines(home), parseAddressLines(changed))).toBe(false);
  });
  it.each([
    home.slice(1), home.filter((_, index) => index !== 1), home.slice(0, -1),
    ['Jamie Example', '123 Example St', 'Seattle, WA', 'US'],
    ['Jamie Example', '123 Example St', 'Seattle, ZZ 98101', 'US'],
    ['Jamie Example', '123 Example St', 'Apt', 'Seattle, WA 98101', 'US'],
    [],
  ].map((lines) => ({ lines })))('refuses incomplete or unsupported address %#', ({ lines }) => {
    expect(parseAddressLines(lines)).toBeUndefined();
  });
  it('never accepts absent identities or incomplete object fields as equal', () => {
    expect(samePhysicalAddress(undefined, undefined)).toBe(false);
    const incomplete = { ...parseAddressLines(home), country: undefined } as unknown as ShippingIdentity;
    expect(samePhysicalAddress(incomplete, incomplete)).toBe(false);
  });
});

describe('Independent rendered shipping proof', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });
  const summary = '<div id="shipping-address-summary" data-selected-address-id="private-saved-id">' + home.map((line) => '<span style="display:block">' + line + '</span>').join('') + '<span>Phone: 206-555-0100 <a href="#">Edit</a></span></div>';
  async function read(html: string) {
    const page = await browser.newPage();
    try { await page.setContent(html); return await readAppliedShippingAddress(page); }
    finally { await page.close(); }
  }
  it('reads only a unique applied summary and hashes its saved ID', async () => {
    const result = await read(summary);
    expect(result?.physicalIdentity).toEqual(parseAddressLines(home));
    expect(result?.savedAddressIdFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('private-saved-id');
  });
  it('ignores hidden descendants and edit controls in the applied lines', async () => {
    expect((await read(summary.replace('Jamie Example', 'Jamie Example<span style="display:none">Wrong Recipient</span><button>Edit</button>')))?.physicalIdentity).toEqual(parseAddressLines(home));
  });
  it('preserves a BR between street and apartment inside one address span', async () => {
    const combined = summary.replace('<span style="display:block">123 Example Street</span><span style="display:block">Apartment 4B</span>', '<span style="display:block">123 Example Street<br>Apartment 4B</span>');
    expect((await read(combined))?.physicalIdentity).toEqual(parseAddressLines(home));
  });
  it('filters controls and hidden content from the plain-text root fallback', async () => {
    const plain = '<div id="shipping-address-summary">' + home.join('<br>') + '<button>PRIVATE_CONTROL</button><a href="#">Private Link</a><span style="display:none">Wrong address</span></div>';
    expect((await read(plain))?.physicalIdentity).toEqual(parseAddressLines(home));
  });
  it('preserves nested block boundaries in a single direct address span', async () => {
    const combined = summary.replace('<span style="display:block">123 Example Street</span><span style="display:block">Apartment 4B</span>', '<span style="display:block"><div>123 Example Street</div><div>Apartment 4B</div></span>');
    expect((await read(combined))?.physicalIdentity).toEqual(parseAddressLines(home));
  });
  it.each([
    '<section style="display:none">' + summary + '</section>',
    '<section id="shipping-address-selection-panel"><input type="radio" checked></section>' + summary,
    summary + summary,
    '<div>Jamie Example<br>123 Example Street<br>Seattle, WA 98101<br>US</div>',
    summary.replace('data-selected-address-id="private-saved-id"', 'data-select-destination-on-sasp-desktop-panel="choice"'),
    summary.replace('</div>', '<input type="radio" checked></div>'),
  ])('withholds proof for hidden, ambiguous, editable or unrecognized state %#', async (html) => {
    expect(await read(html)).toBeUndefined();
  });
  it('supports the known modern applied delivery container with the chooser hidden', async () => {
    const modern = '<section id="shipping-address-selection-panel" style="display:none">Old choices</section><section id="checkout-delivery-address-panel"><div class="destination-data-alignment">' + home.map((line) => '<span>' + line + '</span>').join('') + '</div></section>';
    expect((await read(modern))?.physicalIdentity).toEqual(parseAddressLines(home));
  });
});
