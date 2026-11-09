import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { parseAddressLines, readAppliedShippingAddress, readAppliedShippingEvidence, samePhysicalAddress, shippingIdentity, type ShippingIdentity } from '../packages/providers/amazon-web/checkout/address-identity.js';

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
  it('parses the observed complete comma-delimited saved address span from the right', () => {
    const observed = ['Jamie Example', '123 Example Street APT 4B, Seattle, WA, 98101-1234, United States', 'Phone number: 2065550100', 'Edit address\n | Add delivery instructions'];
    expect(samePhysicalAddress(parseAddressLines(observed), parseAddressLines(home))).toBe(true);
    expect(parseAddressLines(observed)?.addressLines).toEqual(['123 EXAMPLE ST APT 4B']);
    expect(samePhysicalAddress(parseAddressLines(observed.map((line) => line.replace('4B', '4.2'))), parseAddressLines(observed.map((line) => line.replace('4B', '42'))))).toBe(false);
  });
  it.each([
    '123 Example St APT 4B, Seattle, WA, 98101-1234',
    '123 Example St APT 4B, Seattle, WA, United States',
    '123 Example St APT 4B, Seattle, 98101-1234, United States',
    '123 Example St APT 4B, WA, 98101-1234, United States',
    'Seattle, WA, 98101-1234, United States',
    '123 Example St APT 4B, Seattle, WA, 98101-1234, Canada',
  ])('rejects incomplete or unsupported comma-delimited address: %s', (address) => {
    expect(parseAddressLines(['Jamie Example', address, 'Edit address\n | Add delivery instructions'])).toBeUndefined();
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
  it('reads the exact observed final-review shipping block as complete physical proof', async () => {
    const html = '<section id="checkout-delivery-address-panel"><section id="checkout-deliveryAddressPanel"><div id="deliver-to-address-text">' + home.join('<br>') + '</div></section></section>';
    expect((await read(html))?.physicalIdentity).toEqual(parseAddressLines(home));
  });
  const addressOnly = '123 Example Street APT 4B, Seattle, WA, 98101-1234, United States';
  const panelWithHeading = (heading: string) => '<section id="checkout-delivery-address-panel"><section id="checkout-deliveryAddressPanel">' + heading + '<div id="deliver-to-address-text">' + addressOnly + '</div></section></section>';
  it('reads the recipient only from a unique rendered Delivering to heading in the same panel', async () => {
    const result = await read(panelWithHeading('<h2>Delivering to Jamie Example</h2>'));
    expect(samePhysicalAddress(result?.physicalIdentity, parseAddressLines(home))).toBe(true);
    const changed = await read(panelWithHeading('<h3>Delivering to Taylor Example</h3>'));
    expect(changed?.physicalIdentity.recipient).toBe('TAYLOR EXAMPLE');
    expect(samePhysicalAddress(changed?.physicalIdentity, parseAddressLines(home))).toBe(false);
  });
  it('accepts a heading beside the inner address panel within the same known outer panel', async () => {
    const html = '<section id="checkout-delivery-address-panel"><h2>Delivering to Jamie Example</h2><section id="checkout-deliveryAddressPanel"><div id="deliver-to-address-text">' + addressOnly + '</div></section></section>';
    expect(samePhysicalAddress((await read(html))?.physicalIdentity, parseAddressLines(home))).toBe(true);
  });
  it.each([
    '<h2>Delivering to Jamie Example</h2><h3>Delivering to Taylor Example</h3>',
    '<h2 style="display:none">Delivering to Jamie Example</h2>',
    '<button><span role="heading">Delivering to Jamie Example</span></button>',
    '<h2>Shipping destination</h2>',
  ])('keeps absent or ambiguous observed recipients partial: %s', async (heading) => {
    expect(await read(panelWithHeading(heading))).toBeUndefined();
  });
  it('returns bounded neighboring heading evidence without inventing a recipient', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(panelWithHeading('<h2>Shipping destination<button>PRIVATE_CONTROL</button><span style="display:none">PRIVATE_HIDDEN</span></h2>'));
      expect(await readAppliedShippingEvidence(page)).toEqual({ lines: [addressOnly], neighborHeadingLines: ['Shipping destination'], neighborPanelLines: ['Shipping destination'] });
    } finally { await page.close(); }
  });
  it('rejects a heading that contradicts an explicitly rendered recipient in the address block', async () => {
    const html = panelWithHeading('<h2>Delivering to Taylor Example</h2>').replace(addressOnly, home.join('<br>'));
    expect(await read(html)).toBeUndefined();
  });
  it('recognizes a plain span announcement only within the same applied panel', async () => {
    expect(samePhysicalAddress((await read(panelWithHeading('<span>Delivering to Jamie Example</span>')))?.physicalIdentity, parseAddressLines(home))).toBe(true);
    expect(await read('<span>Delivering to Jamie Example</span>' + panelWithHeading(''))).toBeUndefined();
  });
  async function readLinkedHeader(header: string, outsideExperience = false) {
    const context = await browser.newContext({ offline: true }); const page = await context.newPage();
    try {
      const body = (outsideExperience ? header : '') + '<main id="checkout-experience-container">' + (outsideExperience ? '' : '<header id="delivery-header">' + header + '</header>') + panelWithHeading('') + '</main>';
      await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body }));
      await page.goto('https://www.amazon.com/checkout/p/p-123-1111111-2222222/spc?pipelineType=Chewbacca&isBuyNow=1');
      return await readAppliedShippingEvidence(page);
    } finally { await context.close(); }
  }
  it('reads the known visible same-checkout recipient link without clicking', async () => {
    const result = await readLinkedHeader('<a id="change-delivery-link" href="/checkout/p/p-123-1111111-2222222/address?pipelineType=Chewbacca&amp;isBuyNow=1">Delivering to Jamie Example<span style="display:none">SECRET_HIDDEN</span></a>');
    expect(samePhysicalAddress(result?.physicalIdentity, parseAddressLines(home))).toBe(true);
    expect(result?.knownHeaderLabels).toEqual(['Delivering to Jamie Example']);
    expect(result?.knownHeaderControls).toEqual([{ tag: 'a', id: 'change-delivery-link', ancestorIds: ['delivery-header', 'checkout-experience-container'], path: '/checkout/p/p-123-1111111-2222222/address', queryKeys: ['pipelineType', 'isBuyNow'], text: 'Delivering to Jamie Example', ariaLabel: '' }]);
  });
  it('returns a noncanonical known header label as partial diagnostic evidence only', async () => {
    const result = await readLinkedHeader('<a id="change-delivery-link" href="/checkout/p/p-123-1111111-2222222/address">Change shipping destination</a>');
    expect(result?.knownHeaderLabels).toEqual(['Change shipping destination']);
    expect(result?.physicalIdentity).toBeUndefined();
  });
  it('rejects the known recipient link outside the same checkout experience', async () => {
    const result = await readLinkedHeader('<a id="change-delivery-link" href="/checkout/p/p-123-1111111-2222222/address">Delivering to Jamie Example</a>', true);
    expect(result?.physicalIdentity).toBeUndefined(); expect(result?.knownHeaderControls).toBeUndefined();
  });
  it('returns safe structural metadata for the named control without returning query tokens', async () => {
    const result = await readLinkedHeader('<a id="change-delivery-link" href="/checkout/p/p-123-1111111-2222222/address?token=SECRET_QUERY" aria-label="Selected delivery destination">Change shipping destination<input type="hidden" value="SECRET_INPUT"></a>');
    expect(result?.physicalIdentity).toBeUndefined();
    expect(result?.knownHeaderControls?.[0]).toMatchObject({ path: '/checkout/p/p-123-1111111-2222222/address', queryKeys: ['token'], text: 'Change shipping destination', ariaLabel: 'Selected delivery destination' });
    expect(JSON.stringify(result)).not.toContain('SECRET_');
  });
  it.each([
    '<a id="change-delivery-link" href="https://evil.example/checkout/p/p-123-1111111-2222222/address">Delivering to Jamie Example</a>',
    '<a id="change-delivery-link" href="/checkout/p/p-999-1111111-2222222/address">Delivering to Jamie Example</a>',
    '<a id="change-delivery-link" href="/checkout/p/p-123-1111111-2222222/address?isBuyNow=0">Delivering to Jamie Example</a>',
    '<a id="change-delivery-link" href="/checkout/p/p-123-1111111-2222222/address?unsafe=1">Delivering to Jamie Example</a>',
    '<a id="change-delivery-link" style="display:none" href="/checkout/p/p-123-1111111-2222222/address">Delivering to Jamie Example</a>',
    '<a href="/checkout/p/p-123-1111111-2222222/address">Delivering to Jamie Example</a>',
    '<a id="change-delivery-link" href="/checkout/p/p-123-1111111-2222222/address">Delivering to Jamie Example</a><a id="change-delivery-link" href="/checkout/p/p-123-1111111-2222222/address">Delivering to Taylor Example</a>',
    '<a id="change-delivery-link" href="/checkout/p/p-123-1111111-2222222/address" aria-label="Delivering to Taylor Example">Delivering to Jamie Example</a>',
  ])('rejects unsafe, hidden, generic or ambiguous recipient link proof %#', async (header) => {
    expect((await readLinkedHeader(header))?.physicalIdentity).toBeUndefined();
  });
  it.each([
    '<span style="display:none">Delivering to Jamie Example</span>',
    '<div>Delivering to Jamie Example</div><div>Delivering to Taylor Example</div>',
    '<button>Delivering to Jamie Example</button>',
    '<div>Delivering to Jamie Example ' + addressOnly + '</div>',
  ])('does not prove hidden, contradictory, control or combined-address recipient announcements %#', async (announcement) => {
    expect(await read(panelWithHeading(announcement))).toBeUndefined();
  });
  it('returns filtered partial evidence without relaxing the write postcondition', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<section id="checkout-delivery-address-panel"><section id="checkout-deliveryAddressPanel"><div id="deliver-to-address-text">Jamie Example<br>123 Example Street Apt 4B<br>Seattle, WA 98101-1234<input type="hidden" value="SECRET_VALUE"><span style="display:none">PRIVATE_HIDDEN</span><button>Edit address</button></div></section></section>');
      const evidence = await readAppliedShippingEvidence(page);
      expect(evidence).toEqual({ lines: ['Jamie Example', '123 Example Street Apt 4B', 'Seattle, WA 98101-1234'] });
      expect(JSON.stringify(evidence)).not.toMatch(/SECRET|PRIVATE_HIDDEN|Edit address/);
      expect(await readAppliedShippingAddress(page)).toBeUndefined();
    } finally { await page.close(); }
  });
  it.each([
    '<div id="deliver-to-address-text">' + home.join('<br>') + '</div>',
    '<section id="shipping-address-selection-panel">Choices</section><section id="checkout-delivery-address-panel"><section id="checkout-deliveryAddressPanel"><div id="deliver-to-address-text">' + home.join('<br>') + '</div></section></section>',
    '<section id="checkout-delivery-address-panel"><section id="checkout-deliveryAddressPanel"><div id="deliver-to-address-text" style="display:none">' + home.join('<br>') + '</div></section></section>',
  ])('does not expose applied evidence from unscoped, hidden or still-editable state %#', async (html) => {
    const page = await browser.newPage();
    try { await page.setContent(html); expect(await readAppliedShippingEvidence(page)).toBeUndefined(); }
    finally { await page.close(); }
  });
});
