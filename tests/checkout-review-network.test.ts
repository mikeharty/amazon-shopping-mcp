import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page, type Request, type Response } from 'playwright';
import { observeReviewNetworkMetadata, readModernReviewDiagnostics } from '../packages/providers/amazon-web/checkout/review-diagnostics.js';

const url = 'https://www.amazon.com/checkout/p/p-123-1111111-2222222/spc?pipelineType=Chewbacca&isBuyNow=1';
const ctx = { ownerId: 'fixture-owner', accountRef: 'fixture-account', marketplace: 'amazon.com' as const, sessionGeneration: 1 };
function surface() {
  const events = new EventEmitter(); const frame = {};
  const page = Object.assign(events, { mainFrame: () => frame }) as unknown as Page;
  const request = (target: string, resourceType = 'fetch', requestFrame: object = frame, method = 'GET') => ({ url: () => target, frame: () => requestFrame, resourceType: () => resourceType, method: () => method, headers: () => { throw Error('Request headers forbidden'); }, postData: () => { throw Error('Request body forbidden'); } }) as unknown as Request;
  const response = (req: Request, contentType = 'application/json') => ({ request: () => req, status: () => 200, headers: () => new Proxy({ 'content-type': contentType }, { get(target, key) { if (key !== 'content-type') throw Error('Private response header forbidden'); return target['content-type']; } }), body: () => { throw Error('Body forbidden'); }, text: () => { throw Error('Text forbidden'); }, json: () => { throw Error('JSON forbidden'); } }) as unknown as Response;
  return { events, page, frame, request, response };
}
describe('Metadata-only per-call response observation', () => {
  it('captures current main-frame routes while masking purchase IDs, encoded/opaque segments and all query values', () => {
    const s = surface(); const observer = observeReviewNetworkMetadata(s.page, url);
    const req = s.request('https://www.amazon.com/checkout/p/p-123-1111111-2222222/getCheckoutData/SECRET_PATH/%70rivate?token=SECRET_QUERY&cookie=SECRET_COOKIE');
    s.events.emit('request', req); s.events.emit('response', s.response(req));
    const result = observer.close();
    expect(result).toEqual([{ path: '/checkout/p/[purchase]/getCheckoutData/[segment]/[segment]', queryKeys: ['token', 'cookie'], resourceType: 'fetch', method: 'GET', status: 200, contentClass: 'json' }]);
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|p-123|%70rivate/);
  });
  it('excludes requests started before the window, foreign origins/purchases/frames, credential URLs and other resource types', () => {
    const s = surface(); const prior = s.request('https://www.amazon.com/api/items'); s.events.emit('request', prior);
    const observer = observeReviewNetworkMetadata(s.page, url);
    s.events.emit('response', s.response(prior));
    for (const req of [s.request('https://foreign.example/api/items'), s.request('https://user:SECRET_PASSWORD@www.amazon.com/api/items'), s.request('https://www.amazon.com/checkout/p/p-999-1111111-2222222/items'), s.request('https://www.amazon.com/api/items', 'fetch', {}), s.request('https://www.amazon.com/api/items', 'script')]) { s.events.emit('request', req); s.events.emit('response', s.response(req)); }
    expect(observer.close()).toEqual([]);
  });
  it('caps metadata at 30, classifies only content type, detaches both listeners and ignores late callbacks', () => {
    const s = surface(); const observer = observeReviewNetworkMetadata(s.page, url);
    const late = s.events.listeners('response')[0]!;
    for (let index = 0; index < 40; index++) { const req = s.request('https://www.amazon.com/api/items?index=SECRET'); s.events.emit('request', req); s.events.emit('response', s.response(req, index === 0 ? 'text/html; charset=utf-8' : index === 1 ? 'image/png' : 'application/problem+json')); }
    const result = observer.close(); expect(result).toHaveLength(30); expect(result.slice(0, 3).map((item) => item.contentClass)).toEqual(['html', 'other', 'json']);
    expect(s.events.listenerCount('request')).toBe(0); expect(s.events.listenerCount('response')).toBe(0);
    expect(() => late({ request: () => { throw Error('Late response was accessed'); } })).not.toThrow();
    expect(result).toHaveLength(30);
  });
  it('captures method enums and rejects contradictory or unbound query identity and nonexact document context', () => {
    const s = surface(); const observer = observeReviewNetworkMetadata(s.page, url + '&checkoutSessionId=PRIVATE_EXPECTED_SESSION');
    for (const method of ['GET', 'POST', 'HEAD', 'DELETE']) { const req = s.request('https://www.amazon.com/api/items?purchaseId=123-1111111-2222222&checkoutSessionId=PRIVATE_EXPECTED_SESSION', 'fetch', s.frame, method); s.events.emit('request', req); s.events.emit('response', s.response(req)); }
    for (const target of ['https://www.amazon.com/api/items?purchaseId=999-1111111-2222222', 'https://www.amazon.com/api/items?checkoutSessionId=PRIVATE_OTHER_SESSION', 'https://www.amazon.com/api/items?purchaseId=123-1111111-2222222&purchaseId=999-1111111-2222222']) { const req = s.request(target); s.events.emit('request', req); s.events.emit('response', s.response(req)); }
    for (const target of [url, url.replace('isBuyNow=1', 'isBuyNow=0'), 'https://www.amazon.com/api/items']) { const req = s.request(target, 'document'); s.events.emit('request', req); s.events.emit('response', s.response(req)); }
    const result = observer.close(); expect(result.map((entry) => entry.method)).toEqual(['GET','POST','HEAD','other']); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|123-1111111|999-1111111/);
    const unbound = observeReviewNetworkMetadata(s.page, url); const request = s.request('https://www.amazon.com/api/items?checkoutSessionId=PRIVATE_UNBOUND'); s.events.emit('request', request); s.events.emit('response', s.response(request)); expect(unbound.close()).toEqual([]);
  });
});

describe('Authenticated read-only network discovery integration', () => {
  let browser: Browser; let fixture: string;
  beforeAll(async () => { browser = await chromium.launch(); fixture = await readFile(new URL('fixtures/checkout-review-modern-diagnostics.html', import.meta.url), 'utf8'); });
  afterAll(async () => { await browser?.close(); });
  it.each(['ok', 'context', 'auth', 'layout', 'navigation_error'])('keeps capture bounded and discards data on %s failure', async (failure) => {
    const context = await browser.newContext({ offline: true }); const page = await context.newPage();
    const forbidden = vi.fn(() => { throw Error('Payload access forbidden'); });
    const originalOn = page.on.bind(page); const originalOff = page.off.bind(page); let attached = 0; let detached = 0;
    vi.spyOn(page, 'on').mockImplementation(((event: string, callback: (...args: unknown[]) => void) => { if (event === 'request' || event === 'response') attached++; return originalOn(event as never, callback as never); }) as typeof page.on);
    vi.spyOn(page, 'off').mockImplementation(((event: string, callback: (...args: unknown[]) => void) => { if (event === 'request' || event === 'response') detached++; return originalOff(event as never, callback as never); }) as typeof page.off);
    originalOn('response', (response) => { vi.spyOn(response, 'body').mockImplementation(forbidden); vi.spyOn(response, 'text').mockImplementation(forbidden); vi.spyOn(response, 'json').mockImplementation(forbidden); });
    await page.route('**/*', (route) => {
      const target = new URL(route.request().url());
      if (target.pathname.includes('order-history')) return route.fulfill({ contentType: 'text/html', body: '<span id="nav-link-accountList-nav-line-1">Hello, Fixture</span>' });
      if (target.pathname.endsWith('/spc')) {
        if (failure === 'navigation_error') return route.abort();
        const script = `<script>fetch('/api/items?token=SECRET_QUERY').catch(()=>{});</script>`;
        const html = failure === 'layout' ? '<main>Unknown layout</main>' : fixture + script + (failure === 'auth' ? '<input type="password">' : '') + (failure === 'context' ? `<script>history.replaceState(null,'','/checkout/p/p-999-1111111-2222222/spc')</script>` : '');
        return route.fulfill({ contentType: 'text/html', body: html });
      }
      return route.fulfill({ contentType: 'application/json', body: '{"PRIVATE_BODY":"SECRET_RESPONSE"}' });
    });
    try {
      if (failure === 'navigation_error') await expect(readModernReviewDiagnostics(page, url, ctx)).rejects.toThrow();
      else {
        const result = await readModernReviewDiagnostics(page, url, ctx);
        if (failure === 'ok') {
          expect(result).toMatchObject({ status: 'partial', data: { diagnosticOnly: true, executableTerms: false, networkMetadata: expect.arrayContaining([{ path: '/api/items', queryKeys: ['token'], resourceType: 'fetch', method: 'GET', status: 200, contentClass: 'json' }]) } });
          expect(JSON.stringify(result)).not.toMatch(/SECRET_QUERY|SECRET_RESPONSE|PRIVATE_BODY/);
        } else expect(result.data).toBeUndefined();
      }
      expect(attached).toBe(2); expect(detached).toBeGreaterThanOrEqual(2); expect(forbidden).not.toHaveBeenCalled();
    } finally { await context.close(); }
  });
});
