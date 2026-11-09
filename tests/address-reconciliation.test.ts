import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../packages/store/index.js';
import { AddressSelectionReconciliation } from '../packages/store/address-reconciliation.js';
import { OperationQueries } from '../packages/store/operations.js';
import { digest } from '../packages/store/crypto.js';
import { shippingIdentity } from '../packages/providers/amazon-web/checkout/address-identity.js';
import type { Result } from '../packages/contracts/index.js';

const connection = process.env.TEST_DATABASE_URL;
const addressUrl = 'https://www.amazon.com/checkout/p/p-123-1111111-2222222/address?isBuyNow=1&pipelineType=Chewbacca';
const reviewUrl = addressUrl.replace('/address?', '/spc?') + '&hasWorkingJavascript=1';
describe.skipIf(!connection)('Isolated operator recovery for uncertain address selection', () => {
  const db = `address_recovery_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool, store: Store, recovery: AddressSelectionReconciliation;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: connection }); await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(connection!); url.pathname = `/${db}`;
    store = new Store(url.toString(), randomBytes(32).toString('base64')); await store.migrate();
    recovery = new AddressSelectionReconciliation(store);
  }, 30_000);
  afterAll(async () => { await store?.close(); await admin?.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); await admin?.end(); });
  async function result(id: string, owner: string, mutate: (value: Result<Record<string, unknown>>) => void) {
    const row = await store.getOperation(owner, id); const payload = row.result as Result<Record<string, unknown>>;
    mutate(payload); await store.pool.query('UPDATE operations SET result=$2 WHERE id=$1', [id, store.vault.seal(payload, owner)]);
  }
  async function seed() {
    const owner = `fixture-${randomUUID()}`; const account = await store.account(owner);
    const physicalIdentity = shippingIdentity(['Fixture Owner', '123 Example St', 'Apt 4', 'Seattle, WA 98101', 'United States'])!;
    const target = { addressRef: digest(randomUUID()), fingerprint: digest('WHOLE PRIVATE SAVED ENTRY'), physicalIdentity, savedAddressIdFingerprint: digest('fixture-address-id'), selected: true };
    const contextFingerprint = digest({ checkoutUrl: addressUrl, accountRef: account.id, sessionGeneration: 7 });
    const revision = digest({ contextFingerprint, addresses: [target] });
    const snapshot = await store.start(owner, account.id, 'checkout_addresses_get', 'read', { url: addressUrl }, randomUUID());
    const operation = await store.start(owner, account.id, 'checkout_address_select', 'write', { url: addressUrl, expectedRevision: revision, expectedContextFingerprint: contextFingerprint, expectedSessionGeneration: 7, addressRef: target.addressRef, expectedFingerprint: target.fingerprint }, randomUUID());
    const reconciliation = await store.start(owner, account.id, 'checkout_addresses_get', 'read', { url: addressUrl, reconcileCurrent: true, reconcileUrl: reviewUrl }, randomUUID());
    const observation = { authentication: 'verified' as const, source: 'amazon-web', observedAt: '2026-11-01T00:00:08Z', contextRef: account.id };
    const pre: Result = { status: 'ok', data: { recognized: true, revision, contextFingerprint, sessionGeneration: 7, checkoutUrl: addressUrl, addresses: [target] }, observation };
    const post: Result = { status: 'ok', data: { reconciliationOnly: true, sessionGeneration: 9, checkoutUrl: reviewUrl, appliedAddress: { physicalIdentity, savedAddressIdFingerprint: target.savedAddressIdFingerprint, checkoutUrl: reviewUrl } }, observation };
    for (const [index, op, payload] of [[0, snapshot, pre], [1, operation, { status: 'outcome_unknown', error: { code: 'ADDRESS_SELECTION_OUTCOME_UNKNOWN', retryable: false } }], [2, reconciliation, post]] as const) {
      await store.pool.query("UPDATE operations SET status=$2,result=$3,created_at='2026-11-01T00:00:00Z'::timestamptz+$4*interval '1 second',started_at='2026-11-01T00:00:01Z'::timestamptz+$4*interval '1 second',updated_at='2026-11-01T00:00:02Z'::timestamptz+$4*interval '1 second' WHERE id=$1", [op.id, payload.status, store.vault.seal(payload, owner), index * 3]);
    }
    await store.pool.query('UPDATE accounts SET session_generation=9,quarantined=true,quarantine_reason=$2 WHERE id=$1', [account.id, operation.id]);
    return { owner, account, operation, snapshot, reconciliation, args: { operationId: operation.id, snapshotOperationId: snapshot.id, reconciliationOperationId: reconciliation.id } };
  }
  it('defaults to dry-run, applies one encrypted linked receipt atomically and preserves original unknown history and idempotency', async () => {
    const f = await seed();
    const original = await store.pool.query('SELECT * FROM operations WHERE id=$1', [f.operation.id]);
    expect(await recovery.run(f.owner, f.args)).toMatchObject({ status: 'dry_run_verified', quarantineReleased: false });
    expect((await store.getAccount(f.owner, f.account.id)).quarantined).toBe(true);
    expect((await store.pool.query('SELECT * FROM address_selection_reconciliations WHERE operation_id=$1', [f.operation.id])).rowCount).toBe(0);
    expect(await recovery.run(f.owner, { ...f.args, apply: true })).toMatchObject({ status: 'applied', quarantineReleased: true, verificationScope: 'saved_address_id_and_physical_destination' });
    expect((await store.getAccount(f.owner, f.account.id))).toMatchObject({ quarantined: false, quarantine_reason: null });
    expect((await store.pool.query('SELECT * FROM operations WHERE id=$1', [f.operation.id])).rows).toEqual(original.rows);
    const receipt = (await store.pool.query('SELECT * FROM address_selection_reconciliations WHERE operation_id=$1', [f.operation.id])).rows[0];
    expect(receipt.receipt).not.toMatch(/PRIVATE|Fixture|Example|address_selection_reconciliation/);
    expect(store.vault.open(receipt.receipt, f.owner)).toMatchObject({ operationId: f.operation.id, snapshotOperationId: f.snapshot.id, reconciliationOperationId: f.reconciliation.id, operatorAction: 'explicit_local_cli_apply' });
    expect((await recovery.run(f.owner, { ...f.args, apply: true })).status).toBe('already_reconciled');
    expect((await store.pool.query('SELECT * FROM address_selection_reconciliations WHERE operation_id=$1', [f.operation.id])).rowCount).toBe(1);
    expect((await store.start(f.owner, f.account.id, f.operation.kind, 'write', f.operation.input, original.rows[0].idempotency_key)).id).toBe(f.operation.id);
    const diagnostics = await new OperationQueries(store).diagnostics(f.owner, true);
    expect(diagnostics.queue).toMatchObject({ uncertain: 0, reconciledUncertain: 1 });
    expect(diagnostics.issues.some((issue) => issue.code === 'uncertain_write')).toBe(false);
    expect((await new OperationQueries(store).list(f.owner, { status: 'outcome_unknown' })).operations[0]).toMatchObject({ status: 'outcome_unknown', reconciled: true });
    await store.deletePrivateData(f.owner);
    expect((await store.pool.query('SELECT * FROM address_selection_reconciliations WHERE owner_id=$1', [f.owner])).rowCount).toBe(0);
  });
  it('never clears another account or a newer quarantine when an existing receipt is replayed', async () => {
    const f = await seed(); const other = await seed();
    await recovery.run(f.owner, { ...f.args, apply: true });
    const newReason = randomUUID(); await store.pool.query('UPDATE accounts SET quarantined=true,quarantine_reason=$2,session_generation=10 WHERE id=$1', [f.account.id, newReason]);
    expect(await recovery.run(f.owner, { ...f.args, apply: true })).toMatchObject({ status: 'already_reconciled', quarantineReleased: false });
    expect((await store.getAccount(f.owner, f.account.id))).toMatchObject({ quarantined: true, quarantine_reason: newReason });
    expect((await store.getAccount(other.owner, other.account.id))).toMatchObject({ quarantined: true, quarantine_reason: other.operation.id });
  });
  it('detects changed linked evidence after an existing receipt without re-releasing quarantine', async () => {
    const f = await seed(); await recovery.run(f.owner, { ...f.args, apply: true });
    await result(f.reconciliation.id, f.owner, (value) => { value.data!.sessionGeneration = 999; });
    await expect(recovery.run(f.owner, { ...f.args, apply: true })).rejects.toMatchObject({ code: 'RECONCILIATION_LINKED_EVIDENCE_CHANGED' });
  });
  it('serializes concurrent applications into one release and one encrypted receipt', async () => {
    const f = await seed();
    const outcomes = await Promise.all([recovery.run(f.owner, { ...f.args, apply: true }), recovery.run(f.owner, { ...f.args, apply: true })]);
    expect(outcomes.map((value) => value.status).sort()).toEqual(['already_reconciled', 'applied']);
    expect(outcomes.filter((value) => value.quarantineReleased)).toHaveLength(1);
    expect((await store.pool.query('SELECT * FROM address_selection_reconciliations WHERE operation_id=$1', [f.operation.id])).rowCount).toBe(1);
  });
  it.each(['owner','account','snapshot','session','context','destination','saved_id','missing_identity','stale_read','financial','other_financial','queued_effect','active','other_unknown','quarantine','no_proof','partial_proof','intent'] as const)('rejects invalid %s proof without releasing quarantine', async (failure) => {
    const f = await seed();
    if (failure === 'owner') { await expect(recovery.run('foreign-owner', f.args)).rejects.toMatchObject({ code: 'RECONCILIATION_OPERATION_NOT_FOUND' }); return; }
    if (failure === 'account') { const other = await seed(); f.args.snapshotOperationId = other.snapshot.id; }
    if (failure === 'snapshot') await result(f.snapshot.id, f.owner, (value) => { value.data!.revision = '0'.repeat(64); });
    if (failure === 'session') await result(f.reconciliation.id, f.owner, (value) => { value.data!.sessionGeneration = 8; });
    if (failure === 'context') await result(f.reconciliation.id, f.owner, (value) => { (value.data!.appliedAddress as Record<string, unknown>).checkoutUrl = reviewUrl.replace('isBuyNow=1', 'isBuyNow=0'); });
    if (failure === 'destination') await result(f.reconciliation.id, f.owner, (value) => { ((value.data!.appliedAddress as Record<string, unknown>).physicalIdentity as Record<string, unknown>).addressLines = ['456 Wrong St']; });
    if (failure === 'saved_id') await result(f.reconciliation.id, f.owner, (value) => { (value.data!.appliedAddress as Record<string, unknown>).savedAddressIdFingerprint = digest('other'); });
    if (failure === 'missing_identity') await result(f.reconciliation.id, f.owner, (value) => { delete (value.data!.appliedAddress as Record<string, unknown>).physicalIdentity; });
    if (failure === 'stale_read') await store.pool.query("UPDATE operations SET created_at='2026-10-01',started_at='2026-10-01',updated_at='2026-10-01' WHERE id=$1", [f.reconciliation.id]);
    if (failure === 'financial') await store.pool.query("UPDATE operations SET kind='checkout_submit',mode='commit' WHERE id=$1", [f.operation.id]);
    if (failure === 'other_financial' || failure === 'queued_effect') {
      const extra = await store.start(f.owner, f.account.id, 'orders_get', 'read', {}, randomUUID());
      await store.pool.query('UPDATE operations SET mode=$2,kind=$3,status=$4 WHERE id=$1', [extra.id, failure === 'other_financial' ? 'commit' : 'write', failure === 'other_financial' ? 'checkout_submit' : 'cart_remove', failure === 'other_financial' ? 'failed' : 'queued']);
    }
    if (failure === 'active' || failure === 'other_unknown') {
      const extra = await store.start(f.owner, f.account.id, 'cart_get', 'read', {}, randomUUID());
      await store.pool.query('UPDATE operations SET mode=$2,status=$3 WHERE id=$1', [extra.id, failure === 'active' ? 'write' : 'read', failure === 'active' ? 'working' : 'outcome_unknown']);
    }
    if (failure === 'quarantine') await store.pool.query('UPDATE accounts SET quarantine_reason=$2 WHERE id=$1', [f.account.id, randomUUID()]);
    if (failure === 'no_proof') await result(f.reconciliation.id, f.owner, (value) => { value.observation!.authentication = undefined; });
    if (failure === 'partial_proof') { await result(f.reconciliation.id, f.owner, (value) => { value.status = 'partial'; }); await store.pool.query("UPDATE operations SET status='partial' WHERE id=$1", [f.reconciliation.id]); }
    if (failure === 'intent') await result(f.operation.id, f.owner, (value) => { value.data = { intentId: randomUUID() }; });
    await expect(recovery.run(f.owner, { ...f.args, apply: true })).rejects.toBeDefined();
    expect((await store.getAccount(f.owner, f.account.id)).quarantined).toBe(true);
    expect((await store.pool.query('SELECT * FROM address_selection_reconciliations WHERE operation_id=$1', [f.operation.id])).rowCount).toBe(0);
  });
  it('reports physical-only scope without inferring an exact saved entry when review omits saved ID', async () => {
    const f = await seed(); await result(f.reconciliation.id, f.owner, (value) => { delete (value.data!.appliedAddress as Record<string, unknown>).savedAddressIdFingerprint; });
    expect(await recovery.run(f.owner, f.args)).toMatchObject({ verificationScope: 'physical_destination_only', quarantineReleased: false });
  });
});
