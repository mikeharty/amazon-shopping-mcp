import type { Page } from 'playwright';
import type { ProviderContext, Result } from '../../../contracts/index.js';
import { classifyPage, isVerifiedAuthenticatedAmazonPage } from '../../../browser-runtime/index.js';
import { digest } from '../../../store/crypto.js';
import { readAppliedShippingAddress, readAppliedShippingEvidence, samePhysicalAddress, type ShippingIdentity } from './address-identity.js';
import { addressRoutingIdentity, canonicalAddressUrl, hasVisibleAddressAuthForm, isAddressStepUrl, readCheckoutAddresses } from './purchasing.js';

const stop = (code: string, status: 'unsupported' | 'conflict' = 'unsupported'): Result => ({ status, error: { code, retryable: false } });
const uncertain = (): Result => ({ status: 'outcome_unknown', error: { code: 'ADDRESS_SELECTION_OUTCOME_UNKNOWN', retryable: false }, data: { instructions: 'Read current checkout address state to reconcile. Do not repeat address selection.' } });
type Address = { addressRef: string; fingerprint: string; ancestorIds: string[]; selected?: boolean; summary?: string; selectionIdentity?: string; savedAddressIdFingerprint?: string; physicalIdentity?: ShippingIdentity };
type Snapshot = { revision: string; contextFingerprint: string; sessionGeneration: number; checkoutUrl: string; addresses: Address[] };

function sameCheckoutStage(url: string, addressUrl: string): boolean {
  try {
    const current = new URL(url); const requested = new URL(addressUrl);
    if (current.origin !== 'https://www.amazon.com' || current.username || current.password || current.hash) return false;
    if (!/^\/checkout\/p\/p-\d{3}-\d{7}-\d{7}\/(?:address|review|spc|pay|payment|shipoptionselect)$/.test(current.pathname)) return false;
    const addressContext = new URL(current); addressContext.pathname = addressContext.pathname.replace(/\/[^/]+$/, '/address');
    return isAddressStepUrl(addressContext.toString()) && addressContext.pathname === requested.pathname && addressRoutingIdentity(addressContext.toString()) === addressRoutingIdentity(addressUrl);
  } catch { return false; }
}

/** Observed applied shipping content, independent of the editable address radios. */
async function appliedAddress(page: Page, addressUrl: string) {
  if (!sameCheckoutStage(page.url(), addressUrl) || (await classifyPage(page)).kind !== 'ready' || await hasVisibleAddressAuthForm(page)) return undefined;
  const applied = await readAppliedShippingAddress(page);
  return applied ? { ...applied, checkoutUrl: canonicalAddressUrl(page.url()) } : undefined;
}

export async function reconcileCurrentAddress(page: Page, input: Record<string, unknown>, context: ProviderContext): Promise<Result> {
  const currentUrl = input.reconcileUrl === undefined ? page.url() : input.reconcileUrl;
  if (typeof input.url !== 'string' || !isAddressStepUrl(input.url) || typeof currentUrl !== 'string' || !sameCheckoutStage(currentUrl, input.url)) return stop('address_reconciliation_context_mismatch', 'conflict');
  // Reconciliation is a fresh read. It never repeats selection or clears quarantine.
  await page.goto('https://www.amazon.com/gp/your-account/order-history', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if ((await classifyPage(page)).kind !== 'ready' || !await isVerifiedAuthenticatedAmazonPage(page) || await hasVisibleAddressAuthForm(page)) return { status: 'requires_user_action', error: { code: 'challenge_signin', retryable: false } };
  await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (!sameCheckoutStage(page.url(), input.url)) return stop('address_reconciliation_context_mismatch', 'conflict');
  const state = await classifyPage(page);
  if (state.kind !== 'ready' || await hasVisibleAddressAuthForm(page)) return { status: 'requires_user_action', error: { code: state.kind === 'challenge' ? `challenge_${state.challenge}` : 'challenge_signin', retryable: false } };
  const evidence = await readAppliedShippingEvidence(page);
  if (!evidence) return stop('applied_shipping_address_unobserved');
  const checkoutUrl = canonicalAddressUrl(page.url());
  const observation = { source: 'amazon-web', observedAt: new Date().toISOString(), contextRef: context.accountRef, authentication: 'verified' as const };
  if (!evidence.physicalIdentity) return { status: 'partial', data: { checkoutUrl, observedShippingLines: evidence.lines, ...(evidence.neighborHeadingLines ? { neighborHeadingLines: evidence.neighborHeadingLines } : {}), ...(evidence.neighborPanelLines ? { neighborPanelLines: evidence.neighborPanelLines } : {}), ...(evidence.knownHeaderLabels ? { knownHeaderLabels: evidence.knownHeaderLabels } : {}), ...(evidence.knownHeaderControls ? { knownHeaderControls: evidence.knownHeaderControls } : {}), sessionGeneration: context.sessionGeneration, reconciliationOnly: true }, coverage: { complete: false, missing: ['parsed_shipping_identity'] }, observation };
  const applied = { physicalIdentity: evidence.physicalIdentity, savedAddressIdFingerprint: evidence.savedAddressIdFingerprint, checkoutUrl };
  return { status: 'ok', data: { checkoutUrl, appliedAddress: applied, sessionGeneration: context.sessionGeneration, reconciliationOnly: true }, observation };
}

export async function selectCheckoutAddress(page: Page, input: Record<string, unknown>, context: ProviderContext): Promise<Result> {
  if (typeof input.url !== 'string' || !isAddressStepUrl(input.url)) return stop('invalid_address_step_url');
  if (input.expectedSessionGeneration !== context.sessionGeneration) return stop('stale_address_session', 'conflict');
  const observed = await readCheckoutAddresses(page, { url: input.url }, context);
  if (observed.status !== 'ok' || observed.observation?.authentication !== 'verified') return observed;
  const snapshot = observed.data as Snapshot;
  if (snapshot.revision !== input.expectedRevision || snapshot.contextFingerprint !== input.expectedContextFingerprint) return stop('stale_address_snapshot', 'conflict');
  const matches = snapshot.addresses.filter((address) => address.addressRef === input.addressRef && address.fingerprint === input.expectedFingerprint);
  if (matches.length !== 1) return stop('address_identity_changed', 'conflict');
  const target = matches[0]!;
  if (!target.physicalIdentity || !target.selectionIdentity || !target.savedAddressIdFingerprint) return stop('address_selection_identity_incomplete');
  const rowIds = target.ancestorIds.filter((id) => id.startsWith('select-destination-on-sasp-desktop-panel-id-'));
  if (rowIds.length !== 1) return stop('address_selection_control_ambiguous');
  const row = page.locator(`#shipping-address-selection-panel span[id=${JSON.stringify(rowIds[0])}]`);
  const radio = row.locator('.a-radio[data-a-input-name] label input[type="radio"][name="destinationSubmissionUrl"]');
  if (await row.count() !== 1 || !await row.isVisible() || await radio.count() !== 1 || !await radio.isEnabled()) return stop('address_selection_control_unavailable');
  const radioHasInlineHandler = async () => radio.evaluate((el) => {
    const boundary = el.closest('[data-select-destination-on-sasp-desktop-panel]');
    if (!boundary) return true;
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.getAttributeNames().some((name) => /^on/i.test(name))) return true;
      if (node === boundary) return false;
    }
    return true;
  });
  if (await radioHasInlineHandler()) return stop('address_selection_inline_handler');
  const payload = await radio.inputValue();
  let destination: URL;
  try { destination = new URL(payload, page.url()); } catch { return stop('address_selection_destination_unsafe'); }
  const current = new URL(snapshot.checkoutUrl);
  const keys = ['pipelineType', 'isBuyNow', 'referrer', 'ref_', 'ref', 'addressID', 'action', 'encoding'];
  if (!/^(?:\/(?!\/)|https:\/\/)/.test(payload) || destination.origin !== 'https://www.amazon.com' || destination.username || destination.password || destination.hash || destination.pathname !== `${current.pathname}/shiptodestination` ||
      [...destination.searchParams.keys()].some((key) => !keys.includes(key) || destination.searchParams.getAll(key).length !== 1) || !['select', 'select-shipping'].includes(destination.searchParams.get('action') ?? '') || !destination.searchParams.get('addressID') ||
      ['pipelineType', 'isBuyNow'].some((key) => JSON.stringify(destination.searchParams.getAll(key)) !== JSON.stringify(current.searchParams.getAll(key)))) return stop('address_selection_destination_unsafe');
  const selectionIdentity = digest(JSON.stringify({ path: destination.pathname, addressID: destination.searchParams.get('addressID'), action: destination.searchParams.getAll('action'), pipelineType: destination.searchParams.getAll('pipelineType'), isBuyNow: destination.searchParams.getAll('isBuyNow') }));
  if (selectionIdentity !== target.selectionIdentity || digest(destination.searchParams.get('addressID')) !== target.savedAddressIdFingerprint || await row.getAttribute('data-action') !== 'select-destination-on-sasp-desktop-panel') return stop('address_selection_identity_changed', 'conflict');
  const continueControl = page.locator('#checkout-primary-continue-button-id input[type="submit"]');
  const safeContinue = async (requireSelected = true) => {
    if (!isAddressStepUrl(page.url()) || addressRoutingIdentity(page.url()) !== addressRoutingIdentity(snapshot.checkoutUrl) || (await classifyPage(page)).kind !== 'ready' || await hasVisibleAddressAuthForm(page)) return false;
    if (await row.count() !== 1 || !await row.isVisible() || await radio.count() !== 1 || (requireSelected && !await radio.isChecked()) || await radio.inputValue() !== payload || await radioHasInlineHandler() || await continueControl.count() !== 1 || !await continueControl.isVisible() || !await continueControl.isEnabled()) return false;
    const summary = (await row.locator('.a-radio[data-a-input-name] label').innerText()).replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (summary !== target.summary || await row.getAttribute('data-action') !== 'select-destination-on-sasp-desktop-panel') return false;
    return continueControl.evaluate((el) => {
      const input = el as HTMLInputElement; const parent = el.closest('#checkout-primary-continue-button-id');
      const label = parent?.querySelector('#checkout-primary-continue-button-id-announce')?.textContent?.replace(/\s+/g, ' ').trim().toLowerCase();
      const semantics = [input.value, input.getAttribute('aria-label'), input.name, input.textContent, label].filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
      const contradictory = /\b(?:place\s*(?:your\s*)?order|confirm\s*(?:your\s*)?(?:order|purchase)|buy\s*now|1[ .-]?click|subscribe|default|edit|add\s*(?:a\s*|new\s*)?address|delete|remove)\b/i.test(semantics);
      for (let node: Element | null = input; node; node = node.parentElement) {
        if (node.getAttributeNames().some((name) => /^on/i.test(name))) return false;
        if (node === parent) break;
      }
      return !contradictory && label === 'deliver to this address' && input.getAttribute('data-testid') === 'bottom-continue-button' && !input.form && !input.hasAttribute('formaction') && parent?.classList.contains('continue-button') === true && parent.classList.contains('primary-action-button') && parent.classList.contains('a-button-primary');
    });
  };
  let dispatched = false;
  try {
    if (!await safeContinue(false)) return stop('address_continue_control_unsafe');
    if (!await radio.isChecked()) {
      const summary = (await row.locator('.a-radio[data-a-input-name] label').innerText()).replace(/\s+/g, ' ').trim().slice(0, 1000);
      if (summary !== target.summary || await radio.inputValue() !== payload || !isAddressStepUrl(page.url()) || addressRoutingIdentity(page.url()) !== addressRoutingIdentity(snapshot.checkoutUrl)) return stop('address_selection_identity_changed', 'conflict');
      dispatched = true; // Native selection can submit/navigate through Amazon's listener.
      await radio.check({ timeout: 5_000 });
      const alreadyApplied = await appliedAddress(page, snapshot.checkoutUrl);
      if (alreadyApplied) return verifiedSelection(alreadyApplied, target, context);
    }
    if (!await safeContinue()) return dispatched ? uncertain() : stop('address_continue_control_unsafe');
    dispatched = true;
    await continueControl.click({ timeout: 5_000 });
    await page.waitForFunction(() => {
      const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      return !Array.from(document.querySelectorAll('#shipping-address-selection-panel')).some(visible) && Array.from(document.querySelectorAll('#checkout-delivery-address-panel, #shipping-address-summary')).some(visible);
    }, undefined, { timeout: 10_000 });
    const applied = await appliedAddress(page, snapshot.checkoutUrl);
    return applied ? verifiedSelection(applied, target, context) : uncertain();
  } catch { return dispatched ? uncertain() : stop('address_selection_preflight_failed'); }
}

function verifiedSelection(applied: NonNullable<Awaited<ReturnType<typeof appliedAddress>>>, target: Address, context: ProviderContext): Result {
  if (!target.physicalIdentity || !samePhysicalAddress(applied.physicalIdentity, target.physicalIdentity) || (applied.savedAddressIdFingerprint !== undefined && applied.savedAddressIdFingerprint !== target.savedAddressIdFingerprint)) return uncertain();
  return { status: 'ok', data: { selectedAddressRef: target.addressRef, selectedFingerprint: target.fingerprint, appliedAddress: applied, verification: applied.savedAddressIdFingerprint ? 'saved_address_id_and_physical_destination' : 'physical_destination_only', orderSubmitted: false }, observation: { source: 'amazon-web', observedAt: new Date().toISOString(), contextRef: context.accountRef, authentication: 'verified' } };
}
