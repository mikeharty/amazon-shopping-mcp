import type { Page } from 'playwright';
import { digest } from '../../../store/crypto.js';

export type ShippingIdentity = { recipient: string; addressLines: string[]; city: string; region: string; postalCode: string; country: 'US' };
export type PhysicalAddressIdentity = ShippingIdentity;

const regions: Record<string, string> = { alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',connecticut:'CT',delaware:'DE',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',washington:'WA','west virginia':'WV',wisconsin:'WI',wyoming:'WY','district of columbia':'DC' };
// Keep meaningful punctuation (hyphens, apostrophes, slashes and unit markers).
const normalized = (value: string) => value.normalize('NFKC').replace(/\.(?=\s|$)/g, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
const street = (value: string) => normalized(value).replace(/\b(STREET|ROAD|AVENUE|BOULEVARD|DRIVE|LANE|COURT|PLACE|PARKWAY|APARTMENT|SUITE)\b(?=\s*(?:$|(?:APT|APARTMENT|UNIT|STE|SUITE|#)\s|\d))/g, (word) => ({ STREET:'ST', ROAD:'RD', AVENUE:'AVE', BOULEVARD:'BLVD', DRIVE:'DR', LANE:'LN', COURT:'CT', PLACE:'PL', PARKWAY:'PKWY', APARTMENT:'APT', SUITE:'STE' })[word]!);
const countryPattern = /(?:United States(?: of America)?|USA?|U\.S\.(?:A\.?)?)$/i;

/** Only complete explicitly separated US addresses are supported. No geocoding or defaults. */
export function parseAddressLines(observed: readonly string[]): ShippingIdentity | undefined {
  if (!observed.length || observed.length > 30 || observed.some((line) => typeof line !== 'string' || line.length > 1000)) return undefined;
  const lines = observed.flatMap((line) => line.split(/\r?\n/)).map((line) => line.normalize('NFKC').replace(/\s+/g, ' ').trim()).filter(Boolean)
    .filter((line) => !/^(?:phone(?: number)?|tel(?:ephone)?)\s*:\s*\+?[\d ().-]+(?:\s*(?:ext\.?|x)\s*\d+)?(?:\s+Edit address(?:\s*\|\s*Add delivery instructions)?)?$/i.test(line) && !/^(?:Edit|Change)(?: address)?$/i.test(line) && !/^\|\s*Add delivery instructions$/i.test(line));
  // Country may occupy its own direct span or trail the city/region/postcode span.
  const last = lines.at(-1);
  if (!last) return undefined;
  const match = last.match(countryPattern);
  if (!match || (match.index! > 0 && !/[\s,]/.test(last[match.index! - 1]!))) return undefined;
  const beforeCountry = last.slice(0, match.index).replace(/[,\s]+$/, '');
  lines.pop();
  if (beforeCountry) lines.push(beforeCountry);
  // Observed modern saved rows put the full street/locality in one comma-delimited
  // span after the recipient. Parse from the right; never supply absent fields.
  if (lines.length === 2) {
    const combined = lines[1]!.match(/^(.+),\s*([^,]+),\s*([A-Za-z ]+),\s*(\d{5}(?:-\d{4})?)$/);
    if (!combined) return undefined;
    lines.splice(1, 1, combined[1]!.trim(), `${combined[2]!.trim()}, ${combined[3]!.trim()} ${combined[4]!}`);
  }
  if (lines.length < 3 || lines.length > 5) return undefined;
  const cityLine = lines.at(-1)!.match(/^(.+?),\s*([A-Za-z ]+?)(?:,\s*|\s+)(\d{5}(?:-\d{4})?)$/);
  if (!cityLine) return undefined;
  const region = regions[cityLine[2]!.trim().toLowerCase()] ?? cityLine[2]!.trim().toUpperCase();
  if (!Object.values(regions).includes(region)) return undefined;
  const recipient = normalized(lines[0]!);
  const city = normalized(cityLine[1]!);
  const addressLines = lines.slice(1, -1).map(street);
  if (!/[A-Z]/.test(recipient) || /^\d+\s/.test(recipient) || !/[A-Z]/.test(city) || !addressLines.length || !/^(?:\d+[A-Z]?(?:-\d+)?\s+\S|PO BOX\s+\d)/.test(addressLines[0]!) || !/[A-Z]/.test(addressLines[0]!)) return undefined;
  // Additional lines must carry a real unit/building identity, never an empty label.
  if (addressLines.some((line) => !line || /^(?:APT|STE|UNIT|BUILDING|BLDG|FLOOR|FL|#)$/.test(line))) return undefined;
  return { recipient, addressLines, city, region, postalCode: cityLine[3]!, country: 'US' };
}

// Existing checkout callers use this name.
export const shippingIdentity = parseAddressLines;

export function samePhysicalAddress(a: ShippingIdentity | undefined, b: ShippingIdentity | undefined): boolean {
  if (!a || !b) return false;
  // Revalidate complete identity objects; no missing-field equality is accepted.
  const validate = (v: ShippingIdentity) => v.country === 'US' && Array.isArray(v.addressLines)
    ? parseAddressLines([v.recipient, ...v.addressLines, `${v.city}, ${v.region} ${v.postalCode}`, v.country]) : undefined;
  const left = validate(a); const right = validate(b);
  return Boolean(left && right && left.recipient === right.recipient && left.city === right.city && left.region === right.region && left.postalCode === right.postalCode && left.country === right.country && left.addressLines.join(' ') === right.addressLines.join(' '));
}

/** Read only an independently rendered applied shipping block. Caller owns auth/URL checks. */
export async function readAppliedShippingAddress(page: Page): Promise<{ physicalIdentity: ShippingIdentity; savedAddressIdFingerprint?: string } | undefined> {
  const raw = await page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    if (Array.from(document.querySelectorAll('#shipping-address-selection-panel')).some(visible)) return undefined;
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('#checkout-delivery-address-panel .destination-data-alignment, #checkout-delivery-address-panel .displayAddressDiv, #shipping-address-summary .displayAddressDiv, #shipping-address-summary .displayAddressUL, #shipping-address-summary'))
      .filter(visible).filter((el, _, all) => !all.some((other) => other !== el && el.contains(other)));
    if (candidates.length !== 1) return undefined;
    const root = candidates[0]!;
    if (root.closest('[data-select-destination-on-sasp-desktop-panel], [id^="address-book-entry-"]') || Array.from(root.querySelectorAll('input[type="radio"], [role="radio"], select')).some(visible)) return undefined;
    // Controls and hidden descendants never become address evidence.
    const renderedText = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (!(node instanceof HTMLElement) || !visible(node) || node.matches('a, button, input, select, textarea, script, style, [role="button"]')) return '';
      if (node.tagName === 'BR') return '\n';
      const content = Array.from(node.childNodes).map(renderedText).join('');
      const block = /^(?:block|flow-root|flex|grid|list-item|table|table-row|table-cell)$/.test(getComputedStyle(node).display);
      return block ? `\n${content}\n` : content;
    };
    const parts = Array.from(root.children).filter((el) => ['SPAN', 'LI', 'DIV'].includes(el.tagName) && visible(el)).map((el) => renderedText(el).trim()).filter(Boolean);
    const lines = parts.length ? parts : renderedText(root).split(/\n+/);
    const id = root.closest('[data-selected-address-id], [data-address-id]') ?? root.querySelector('[data-selected-address-id], [data-address-id]');
    return { lines, savedAddressId: id?.getAttribute('data-selected-address-id') ?? id?.getAttribute('data-address-id') ?? undefined };
  });
  if (!raw) return undefined;
  const physicalIdentity = parseAddressLines(raw.lines);
  return physicalIdentity ? { physicalIdentity, ...(raw.savedAddressId ? { savedAddressIdFingerprint: digest(raw.savedAddressId) } : {}) } : undefined;
}
