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

export type AppliedShippingEvidence = { lines: string[]; neighborHeadingLines?: string[]; neighborPanelLines?: string[]; knownHeaderLabels?: string[]; physicalIdentity?: ShippingIdentity; savedAddressIdFingerprint?: string };

/** Owner-private read evidence only. Caller owns authentication and checkout-context checks. */
export async function readAppliedShippingEvidence(page: Page): Promise<AppliedShippingEvidence | undefined> {
  const raw = await page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    if (Array.from(document.querySelectorAll('#shipping-address-selection-panel')).some(visible)) return undefined;
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('#checkout-delivery-address-panel #checkout-deliveryAddressPanel #deliver-to-address-text, #checkout-delivery-address-panel .destination-data-alignment, #checkout-delivery-address-panel .displayAddressDiv, #shipping-address-summary .displayAddressDiv, #shipping-address-summary .displayAddressUL, #shipping-address-summary'))
      .filter(visible).filter((el, _, all) => !all.some((other) => other !== el && el.contains(other)));
    if (candidates.length !== 1) return undefined;
    const root = candidates[0]!;
    if (root.closest('[data-select-destination-on-sasp-desktop-panel], [id^="address-book-entry-"]') || Array.from(root.querySelectorAll('input[type="radio"], [role="radio"], select')).some(visible)) return undefined;
    // Controls and hidden descendants never become address evidence.
    const renderedText = (node: Node, omitted?: Node): string => {
      if (node === omitted) return '\n';
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (!(node instanceof HTMLElement) || !visible(node) || node.matches('a, button, input, select, textarea, script, style, [role="button"]')) return '';
      if (node.tagName === 'BR') return '\n';
      const content = Array.from(node.childNodes).map((child) => renderedText(child, omitted)).join('');
      const block = /^(?:block|flow-root|flex|grid|list-item|table|table-row|table-cell)$/.test(getComputedStyle(node).display);
      return block ? `\n${content}\n` : content;
    };
    const parts = Array.from(root.children).filter((el) => ['SPAN', 'LI', 'DIV'].includes(el.tagName) && visible(el)).map((el) => renderedText(el).trim()).filter(Boolean);
    const lines = (parts.length ? parts : [renderedText(root)]).flatMap((part) => part.split(/\n+/)).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!lines.length || lines.length > 30 || lines.some((line) => line.length > 1000)) return undefined;
    const panel = root.closest('#checkout-delivery-address-panel') ?? root.closest('#checkout-deliveryAddressPanel');
    const headings = panel ? Array.from(panel.querySelectorAll<HTMLElement>('h2, h3, [role="heading"]')).filter(visible)
      .filter((el, _, all) => !root.contains(el) && !el.closest('a, button, [role="button"]') && !all.some((other) => other !== el && el.contains(other))) : [];
    const neighborHeadingLines = headings.map((heading) => renderedText(heading).replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (neighborHeadingLines.length > 10 || neighborHeadingLines.some((line) => line.length > 1000)) return undefined;
    // The native recipient announcement can be a plain span/div. Keep it scoped
    // to this same applied shipping panel, with the address block separated out.
    const neighborPanelLines = panel ? renderedText(panel, root).split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
    if (neighborPanelLines.length > 30 || neighborPanelLines.some((line) => line.length > 1000)) return undefined;
    // This observed link is the selected-recipient announcement, not an action
    // to execute. No other interactive control is admitted as recipient proof.
    const headerLinks = panel ? Array.from(panel.querySelectorAll<HTMLAnchorElement>('a#change-delivery-link')).filter(visible) : [];
    const knownHeaderLabels: string[] = [];
    if (headerLinks.length === 1) {
      const link = headerLinks[0]!;
      try {
        const current = new URL(location.href); const destination = new URL(link.href, location.href);
        const purchase = current.pathname.match(/^\/checkout\/p\/(p-\d{3}-\d{7}-\d{7})\//)?.[1];
        const allowed = ['ref', 'ref_', 'referrer', 'pipelineType', 'isBuyNow', 'hasWorkingJavascript', 'purchaseId', 'checkoutSessionId'];
        const safe = purchase && current.origin === 'https://www.amazon.com' && destination.origin === current.origin && !destination.username && !destination.password && !destination.hash && destination.pathname === `/checkout/p/${purchase}/address` &&
          [...destination.searchParams.keys()].every((key) => allowed.includes(key) && destination.searchParams.getAll(key).length === 1) &&
          ['pipelineType', 'isBuyNow', 'purchaseId', 'checkoutSessionId'].every((key) => !destination.searchParams.has(key) || JSON.stringify(destination.searchParams.getAll(key)) === JSON.stringify(current.searchParams.getAll(key)));
        if (safe) {
          const text = Array.from(link.childNodes).map((node) => renderedText(node)).join('');
          for (const value of [text, link.getAttribute('aria-label') ?? '']) {
            const label = value.replace(/\s+/g, ' ').trim();
            if (label && label.length <= 1000 && !knownHeaderLabels.includes(label)) knownHeaderLabels.push(label);
          }
        }
      } catch { /* Unsafe or unsupported links never establish recipient evidence. */ }
    }
    const id = root.closest('[data-selected-address-id], [data-address-id]') ?? root.querySelector('[data-selected-address-id], [data-address-id]');
    return { lines, neighborHeadingLines, neighborPanelLines, knownHeaderLabels, ambiguousHeader: headerLinks.length > 1, savedAddressId: id?.getAttribute('data-selected-address-id') ?? id?.getAttribute('data-address-id') ?? undefined };
  });
  if (!raw) return undefined;
  const recipients = [...new Set([...raw.neighborHeadingLines, ...raw.neighborPanelLines, ...raw.knownHeaderLabels].flatMap((line) => {
    const match = line.match(/^Delivering to\s+(.+)$/i);
    return match ? [match[1]!.trim()] : [];
  }))];
  let physicalIdentity = parseAddressLines(raw.lines);
  if (raw.ambiguousHeader || recipients.length > 1 || recipients.some((recipient) => raw.lines.some((line) => line.length > 20 && normalized(recipient).includes(normalized(line))))) physicalIdentity = undefined;
  else if (recipients.length === 1) {
    if (physicalIdentity && physicalIdentity.recipient !== normalized(recipients[0]!)) physicalIdentity = undefined;
    else physicalIdentity ??= parseAddressLines([recipients[0]!, ...raw.lines]);
  }
  return { lines: raw.lines, ...(raw.neighborHeadingLines.length ? { neighborHeadingLines: raw.neighborHeadingLines } : {}), ...(raw.neighborPanelLines.length ? { neighborPanelLines: raw.neighborPanelLines } : {}), ...(raw.knownHeaderLabels.length ? { knownHeaderLabels: raw.knownHeaderLabels } : {}), ...(physicalIdentity ? { physicalIdentity } : {}), ...(raw.savedAddressId ? { savedAddressIdFingerprint: digest(raw.savedAddressId) } : {}) };
}

/** Strict write postcondition: rendered evidence alone never establishes a complete identity. */
export async function readAppliedShippingAddress(page: Page): Promise<{ physicalIdentity: ShippingIdentity; savedAddressIdFingerprint?: string } | undefined> {
  const evidence = await readAppliedShippingEvidence(page);
  return evidence?.physicalIdentity ? { physicalIdentity: evidence.physicalIdentity, ...(evidence.savedAddressIdFingerprint ? { savedAddressIdFingerprint: evidence.savedAddressIdFingerprint } : {}) } : undefined;
}
