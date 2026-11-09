import { z } from 'zod';
import type { PoolClient } from 'pg';
import { DomainError, type Result } from '../contracts/index.js';
import { samePhysicalAddress, type ShippingIdentity } from '../providers/amazon-web/checkout/address-identity.js';
import { addressRoutingIdentity, canonicalAddressUrl, isAddressStepUrl } from '../providers/amazon-web/checkout/purchasing.js';
import { digest } from './crypto.js';
import type { Account, Store } from './index.js';

export const addressReconciliationInput = z.object({ operationId: z.uuid(), snapshotOperationId: z.uuid(), reconciliationOperationId: z.uuid(), apply: z.boolean().default(false) }).strict();
type Input = z.input<typeof addressReconciliationInput>;
type OperationEvidence = { id: string; owner_id: string; account_id: string; kind: string; mode: string; status: string; revision: number; input_digest: string; idempotency_key: string; intent_id: string | null; input: Record<string, unknown>; result?: Result; created_at: Date; started_at: Date | null; updated_at: Date; created_at_exact: string; started_at_exact: string | null; updated_at_exact: string };
type Receipt = { schemaVersion: 1; kind: 'address_selection_reconciliation'; ownerId: string; accountId: string; operationId: string; snapshotOperationId: string; reconciliationOperationId: string; evidenceDigest: string; evidenceDigests: Record<string, string>; verificationScope: 'physical_destination_only' | 'saved_address_id_and_physical_destination'; historicalSessionGeneration: number; reconciledSessionGeneration: number; operatorAction: 'explicit_local_cli_apply'; createdAt: string };
export type ReconciliationSummary = { status: 'dry_run_verified' | 'applied' | 'already_reconciled'; operationId: string; snapshotOperationId: string; reconciliationOperationId: string; evidenceDigest: string; verificationScope: Receipt['verificationScope']; quarantineReleased: boolean };
const fail = (code: string): never => { throw new DomainError(code, 'Address reconciliation proof rejected; no quarantine was released'); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = (value: Date | null): number => value instanceof Date ? value.getTime() : NaN;

function sameCheckout(addressUrl: unknown, checkoutUrl: unknown): boolean {
  if (typeof addressUrl !== 'string' || typeof checkoutUrl !== 'string' || !isAddressStepUrl(addressUrl)) return false;
  try {
    const actual = new URL(checkoutUrl);
    if (!/^\/checkout\/p\/p-\d{3}-\d{7}-\d{7}\/(?:address|review|spc|pay|payment|shipoptionselect)$/.test(actual.pathname)) return false;
    actual.pathname = actual.pathname.replace(/\/[^/]+$/, '/address');
    return isAddressStepUrl(actual.toString()) && addressRoutingIdentity(actual.toString()) === addressRoutingIdentity(addressUrl);
  } catch { return false; }
}

/** Local operator recovery for address selection only. Never approves or submits purchases. */
export class AddressSelectionReconciliation {
  constructor(private readonly store: Store) {}

  async run(ownerId: string, input: Input): Promise<ReconciliationSummary> {
    const args = addressReconciliationInput.parse(input);
    if (new Set([args.operationId, args.snapshotOperationId, args.reconciliationOperationId]).size !== 3) fail('RECONCILIATION_DISTINCT_EVIDENCE_REQUIRED');
    return this.store.transaction(async (client) => {
      const initial = await client.query('SELECT account_id FROM operations WHERE id=$1 AND owner_id=$2', [args.operationId, ownerId]);
      if (!initial.rows[0]) fail('RECONCILIATION_OPERATION_NOT_FOUND');
      // Same lock order as claim/finish/start: account before operation rows.
      const account = await this.store.getAccount(ownerId, initial.rows[0].account_id, client, true);
      const prior = await client.query('SELECT * FROM address_selection_reconciliations WHERE operation_id=$1 AND owner_id=$2 AND account_id=$3 FOR UPDATE', [args.operationId, ownerId, account.id]);
      if (prior.rows[0]) {
        const receipt = this.store.vault.open<Receipt>(prior.rows[0].receipt, ownerId);
        if (receipt.schemaVersion !== 1 || receipt.kind !== 'address_selection_reconciliation' || receipt.ownerId !== ownerId || receipt.accountId !== account.id || receipt.operationId !== args.operationId || receipt.snapshotOperationId !== args.snapshotOperationId || receipt.reconciliationOperationId !== args.reconciliationOperationId || receipt.evidenceDigest !== prior.rows[0].evidence_digest || receipt.evidenceDigest !== digest(receipt.evidenceDigests) || prior.rows[0].snapshot_operation_id !== receipt.snapshotOperationId || prior.rows[0].reconciliation_operation_id !== receipt.reconciliationOperationId) fail('RECONCILIATION_RECEIPT_CONFLICT');
        const evidence = await this.lockEvidence(client, ownerId, account.id, args);
        const currentDigests = this.evidenceDigests(evidence.operation, evidence.snapshot, evidence.reconciliation);
        if (digest(currentDigests) !== receipt.evidenceDigest) fail('RECONCILIATION_LINKED_EVIDENCE_CHANGED');
        // Idempotency must never clear a newer quarantine or re-release the account.
        return this.summary(receipt, 'already_reconciled', false);
      }
      const evidence = await this.lockEvidence(client, ownerId, account.id, args);
      const { operation, snapshot, reconciliation } = evidence;
      const receipt = this.verify(ownerId, account, operation, snapshot, reconciliation);
      if (!account.enabled || !account.quarantined || account.quarantine_reason !== operation.id) fail('RECONCILIATION_QUARANTINE_MISMATCH');
      const blockers = await client.query(`SELECT id FROM operations o WHERE o.owner_id=$1 AND o.account_id=$2 AND o.id<>$3 AND (
        (o.status='outcome_unknown' AND NOT EXISTS(SELECT 1 FROM address_selection_reconciliations r WHERE r.operation_id=o.id AND r.owner_id=o.owner_id AND r.account_id=o.account_id))
        OR (o.mode<>'read' AND o.status IN ('queued','working','dispatching'))
        OR ((o.mode='commit' OR o.intent_id IS NOT NULL OR o.kind IN ('checkout_submit','subscriptions_submit')) AND o.created_at >= $4)
      ) LIMIT 1`, [ownerId, account.id, operation.id, operation.created_at]);
      if (blockers.rowCount) fail('RECONCILIATION_OTHER_EFFECTS_UNRESOLVED');
      if (!args.apply) return this.summary(receipt, 'dry_run_verified', false);
      await client.query(`INSERT INTO address_selection_reconciliations(operation_id,owner_id,account_id,snapshot_operation_id,reconciliation_operation_id,evidence_digest,receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [operation.id, ownerId, account.id, snapshot.id, reconciliation.id, receipt.evidenceDigest, this.store.vault.seal(receipt, ownerId)]);
      const released = await client.query('UPDATE accounts SET quarantined=false,quarantine_reason=NULL WHERE id=$1 AND owner_id=$2 AND quarantined=true AND quarantine_reason=$3', [account.id, ownerId, operation.id]);
      if (released.rowCount !== 1) fail('RECONCILIATION_QUARANTINE_CHANGED');
      await client.query("INSERT INTO audit(owner_id,action,resource_id) VALUES($1,'address_selection_reconciled',$2)", [ownerId, operation.id]);
      return this.summary(receipt, 'applied', true);
    });
  }

  private async lockEvidence(client: PoolClient, ownerId: string, accountId: string, args: z.infer<typeof addressReconciliationInput>) {
    const ids = [args.operationId, args.snapshotOperationId, args.reconciliationOperationId];
    const found = await client.query(`SELECT *,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_exact,
      to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at_exact,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_exact
      FROM operations WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND account_id=$3 ORDER BY id FOR UPDATE`, [ids, ownerId, accountId]);
    if (found.rows.length !== 3) fail('RECONCILIATION_EVIDENCE_OWNER_MISMATCH');
    const decoded = found.rows.map((row) => ({ ...row, input: this.store.vault.open(row.input, ownerId), result: row.result ? this.store.vault.open(row.result, ownerId) : undefined }) as OperationEvidence);
    return { operation: decoded.find((row) => row.id === args.operationId)!, snapshot: decoded.find((row) => row.id === args.snapshotOperationId)!, reconciliation: decoded.find((row) => row.id === args.reconciliationOperationId)! };
  }

  private verify(ownerId: string, account: Account, operation: OperationEvidence, snapshot: OperationEvidence, reconciliation: OperationEvidence): Receipt {
    if (operation.kind !== 'checkout_address_select' || operation.mode !== 'write' || operation.status !== 'outcome_unknown' || operation.result?.status !== 'outcome_unknown' || operation.intent_id || record(operation.result.data).intentId !== undefined) fail('RECONCILIATION_NOT_ADDRESS_SELECTION');
    for (const read of [snapshot, reconciliation]) {
      if (read.kind !== 'checkout_addresses_get' || read.mode !== 'read' || read.status !== 'ok' || read.result?.status !== 'ok' || read.intent_id || read.result.observation?.authentication !== 'verified' || read.result.observation.source !== 'amazon-web' || read.result.observation.contextRef !== account.id) fail('RECONCILIATION_AUTHENTICATED_READ_REQUIRED');
    }
    if (snapshot.input.inspectCurrent === true || snapshot.input.reconcileCurrent === true || snapshot.input.reconcileUrl !== undefined || reconciliation.input.reconcileCurrent !== true || reconciliation.input.inspectCurrent === true) fail('RECONCILIATION_WRONG_READ_MODE');
    const pre = record(snapshot.result!.data); const post = record(reconciliation.result!.data); const applied = record(post.appliedAddress);
    if (pre.recognized !== true || pre.revision !== operation.input.expectedRevision || pre.contextFingerprint !== operation.input.expectedContextFingerprint || pre.sessionGeneration !== operation.input.expectedSessionGeneration || !Number.isInteger(pre.sessionGeneration) || !hash(pre.revision) || !hash(pre.contextFingerprint)) fail('RECONCILIATION_SNAPSHOT_CHANGED');
    if (post.reconciliationOnly !== true || post.sessionGeneration !== account.session_generation || !sameCheckout(operation.input.url, pre.checkoutUrl) || !sameCheckout(operation.input.url, snapshot.input.url) || !sameCheckout(operation.input.url, reconciliation.input.url) || !sameCheckout(operation.input.url, applied.checkoutUrl) || (post.checkoutUrl !== undefined && canonicalAddressUrl(String(post.checkoutUrl)) !== canonicalAddressUrl(String(applied.checkoutUrl))) || (reconciliation.input.reconcileUrl !== undefined && !sameCheckout(operation.input.url, reconciliation.input.reconcileUrl))) fail('RECONCILIATION_CHECKOUT_OR_SESSION_CHANGED');
    const targets = Array.isArray(pre.addresses) ? pre.addresses.map(record).filter((address) => address.addressRef === operation.input.addressRef && address.fingerprint === operation.input.expectedFingerprint) : [];
    if (targets.length !== 1 || !hash(operation.input.addressRef) || !hash(operation.input.expectedFingerprint)) fail('RECONCILIATION_TARGET_AMBIGUOUS');
    const target = targets[0]!;
    if (!samePhysicalAddress(target.physicalIdentity as ShippingIdentity, applied.physicalIdentity as ShippingIdentity)) fail('RECONCILIATION_DESTINATION_UNPROVED');
    if (applied.savedAddressIdFingerprint !== undefined && (!hash(applied.savedAddressIdFingerprint) || applied.savedAddressIdFingerprint !== target.savedAddressIdFingerprint)) fail('RECONCILIATION_SAVED_ADDRESS_CHANGED');
    const times = [date(snapshot.created_at), date(snapshot.started_at), date(snapshot.updated_at), date(operation.created_at), date(operation.started_at), date(operation.updated_at), date(reconciliation.created_at), date(reconciliation.started_at), date(reconciliation.updated_at)];
    const exactTimes = [snapshot.created_at_exact, snapshot.started_at_exact, snapshot.updated_at_exact, operation.created_at_exact, operation.started_at_exact, operation.updated_at_exact, reconciliation.created_at_exact, reconciliation.started_at_exact, reconciliation.updated_at_exact];
    if (times.some((time) => !Number.isFinite(time)) || exactTimes.some((time) => !time || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(time)) || exactTimes.some((time, index) => index > 0 && time! < exactTimes[index - 1]!)) fail('RECONCILIATION_EVIDENCE_ORDER_INVALID');
    const evidenceDigests = this.evidenceDigests(operation, snapshot, reconciliation);
    return { schemaVersion: 1, kind: 'address_selection_reconciliation', ownerId, accountId: account.id, operationId: operation.id, snapshotOperationId: snapshot.id, reconciliationOperationId: reconciliation.id, evidenceDigest: digest(evidenceDigests), evidenceDigests, verificationScope: applied.savedAddressIdFingerprint ? 'saved_address_id_and_physical_destination' : 'physical_destination_only', historicalSessionGeneration: Number(pre.sessionGeneration), reconciledSessionGeneration: account.session_generation, operatorAction: 'explicit_local_cli_apply', createdAt: new Date().toISOString() };
  }

  private evidenceDigests(operation: OperationEvidence, snapshot: OperationEvidence, reconciliation: OperationEvidence): Record<string, string> {
    const journal = (op: OperationEvidence) => ({ id: op.id, ownerId: op.owner_id, accountId: op.account_id, input: op.input, inputDigest: op.input_digest, idempotencyKey: op.idempotency_key, result: op.result, kind: op.kind, mode: op.mode, status: op.status, revision: op.revision, intentId: op.intent_id, createdAt: op.created_at_exact, startedAt: op.started_at_exact, updatedAt: op.updated_at_exact });
    return { operation: digest(journal(operation)), snapshot: digest(journal(snapshot)), reconciliation: digest(journal(reconciliation)) };
  }

  private summary(receipt: Receipt, status: ReconciliationSummary['status'], quarantineReleased: boolean): ReconciliationSummary {
    return { status, operationId: receipt.operationId, snapshotOperationId: receipt.snapshotOperationId, reconciliationOperationId: receipt.reconciliationOperationId, evidenceDigest: receipt.evidenceDigest, verificationScope: receipt.verificationScope, quarantineReleased };
  }
}
