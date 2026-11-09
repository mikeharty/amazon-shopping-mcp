import { describe, expect, it } from "vitest";
import { createRegistry } from "../apps/gateway/registry.js";
import { DomainError } from "../packages/contracts/index.js";
import type { Store } from "../packages/store/index.js";

describe("Owner-private checkout address read registration", () => {
  it('registers address selection only in purchasing profile and journals exact scoped inputs as a write', async () => {
    const starts: unknown[][] = [];
    const store = { getAccount: async (owner: string, account: string) => {
      if (owner !== 'fixture-owner' || account !== 'fixture-account') throw new DomainError('NOT_FOUND', 'Account not found', 404);
      return { id: account };
    }, start: async (...args: unknown[]) => { starts.push(args); return { id: 'write-operation' }; } } as unknown as Store;
    const options = { liveEnabled: true, retainObservations: false, origin: 'http://127.0.0.1', purchasingEnabled: true };
    const tool = createRegistry(store, options).tools.find((item) => item.name === 'checkout_address_select')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    const request = new Request('http://127.0.0.1/mcp');
    const args = { accountRef: 'fixture-account', url: 'https://www.amazon.com/checkout/p/p-123-1111111-2222222/address', idempotencyKey: 'stable-address-selection', expectedRevision: 'a'.repeat(64), expectedContextFingerprint: 'b'.repeat(64), expectedSessionGeneration: 7, addressRef: 'c'.repeat(64), expectedFingerprint: 'd'.repeat(64) };
    expect((await tool.handler(args, { request, owner: { id: 'fixture-owner', scopes: ['account:read'] } })).structuredContent).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect((await tool.handler({ ...args, accountRef: 'foreign-account' }, { request, owner: { id: 'fixture-owner', scopes: ['checkout:prepare'] } })).structuredContent).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
    expect(starts).toHaveLength(0);
    expect((await tool.handler(args, { request, owner: { id: 'fixture-owner', scopes: ['checkout:prepare'] } })).structuredContent).toMatchObject({ status: 'pending' });
    expect(starts[0]?.slice(0, 4)).toEqual(['fixture-owner', 'fixture-account', 'checkout_address_select', 'write']);
    expect(starts[0]?.[5]).toBe('stable-address-selection');
    expect(createRegistry(store, { ...options, purchasingEnabled: false }).tools.some((item) => item.name === 'checkout_address_select')).toBe(false);
  });
  it("uses an account-scoped durable read and denies foreign accounts or missing read scope", async () => {
    const starts: unknown[][] = [];
    const store = {
      getAccount: async (owner: string, account: string) => {
        if (owner !== 'fixture-owner' || account !== 'fixture-account') throw new DomainError('NOT_FOUND', 'Account not found', 404);
        return { id: account };
      },
      start: async (...args: unknown[]) => { starts.push(args); return { id: 'fixture-operation' }; },
    } as unknown as Store;
    const options = { liveEnabled: true, retainObservations: false, origin: 'http://127.0.0.1', purchasingEnabled: true };
    const tool = createRegistry(store, options).tools.find((item) => item.name === 'checkout_addresses_get')!;
    expect(tool.annotations.readOnlyHint).toBe(true);
    const input = { accountRef: 'fixture-account', url: 'https://www.amazon.com/checkout/p/p-123-1111111-2222222/address' };
    const request = new Request('http://127.0.0.1/mcp');
    const owner = { id: 'fixture-owner', scopes: ['account:read'] };
    expect((await tool.handler(input, { request, owner: { ...owner, scopes: [] } })).structuredContent).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect((await tool.handler({ ...input, accountRef: 'foreign-account' }, { request, owner })).structuredContent).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
    expect(starts).toHaveLength(0);
    expect((await tool.handler(input, { request, owner })).structuredContent).toMatchObject({ status: 'pending', operationId: 'fixture-operation' });
    expect(starts[0]?.slice(0, 5)).toEqual(['fixture-owner', 'fixture-account', 'checkout_addresses_get', 'read', { url: input.url }]);
    await tool.handler({ ...input, inspectCurrent: true }, { request, owner });
    expect(starts[1]?.[4]).toEqual({ url: input.url, inspectCurrent: true });
    expect(createRegistry(store, { ...options, purchasingEnabled: false }).tools.some((item) => item.name === 'checkout_addresses_get')).toBe(false);
  });
});
