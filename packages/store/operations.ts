import { z } from "zod";
import { DomainError } from "../contracts/index.js";
import { digest } from "./crypto.js";
import type { Store } from "./index.js";

export const operationStatus = z.enum(["queued", "working", "dispatching", "ok", "partial", "requires_user_action", "unsupported", "conflict", "failed", "outcome_unknown", "cancelled"]);
export const operationListInput = z.object({
  accountRef: z.uuid().optional(),
  status: operationStatus.optional(),
  mode: z.enum(["read", "write", "commit"]).optional(),
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();
const cursorSchema = z.object({
  version: z.literal(1), filter: z.string(), id: z.uuid(),
  timestamp: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
}).strict();

export class OperationQueries {
  constructor(private readonly store: Store) {}

  async list(owner: string, input: z.input<typeof operationListInput>) {
    const args = operationListInput.parse(input);
    if (args.accountRef) await this.store.getAccount(owner, args.accountRef);
    const filter = digest({ account: args.accountRef, status: args.status, mode: args.mode, kind: args.kind });
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (args.cursor) {
      try {
        cursor = cursorSchema.parse(this.store.vault.open(args.cursor, `operation-list:${owner}`));
        if (cursor.filter !== filter) throw new Error();
      } catch {
        throw new DomainError("INVALID_CURSOR", "Use the returned cursor with the same owner and filters", 400);
      }
    }
    const { rows } = await this.store.pool.query<{
      id: string; account_id: string; kind: string; mode: string; status: string;
      revision: number; created_at: Date; updated_at: Date; started_at: Date | null; sort_timestamp: string; reconciled: boolean;
    }>(`SELECT id,account_id,kind,mode,status,revision,created_at,updated_at,started_at,
      EXISTS(SELECT 1 FROM address_selection_reconciliations r WHERE r.operation_id=operations.id AND r.owner_id=operations.owner_id AND r.account_id=operations.account_id) AS reconciled,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_timestamp
      FROM operations WHERE owner_id=$1
      AND ($2::uuid IS NULL OR account_id=$2) AND ($3::text IS NULL OR status=$3)
      AND ($4::text IS NULL OR mode=$4) AND ($5::text IS NULL OR kind=$5)
      AND ($6::timestamptz IS NULL OR (created_at,id)<($6::timestamptz,$7::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $8`,
    [owner, args.accountRef ?? null, args.status ?? null, args.mode ?? null, args.kind ?? null,
      cursor?.timestamp ?? null, cursor?.id ?? null, args.limit + 1]);
    const page = rows.slice(0, args.limit);
    const last = page.at(-1);
    return {
      operations: page.map((row) => ({
        id: row.id, accountRef: row.account_id, kind: row.kind, mode: row.mode,
        status: row.status, reconciled: row.reconciled, revision: row.revision, createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null,
      })),
      nextCursor: rows.length > args.limit && last ? this.store.vault.seal({
        version: 1, filter, timestamp: last.sort_timestamp, id: last.id,
      }, `operation-list:${owner}`) : undefined,
    };
  }

  async diagnostics(owner: string, liveEnabled: boolean) {
    const { rows: [account] } = await this.store.pool.query<{
      id: string; enabled: boolean; quarantined: boolean; session_generation: number;
    }>("SELECT id,enabled,quarantined,session_generation FROM accounts WHERE owner_id=$1 AND marketplace='amazon.com'", [owner]);
    if (!account) throw new DomainError("NOT_FOUND", "Initialize the local account with amazon_capabilities first", 404);
    const { rows: [row] } = await this.store.pool.query<{
      sampled_at: Date; last_heartbeat: Date | null; worker_online: boolean;
      queued: number; active: number; uncertain: number; reconciled_uncertain: number; stale_active: number;
      oldest_queued_at: Date | null; queue_delayed: boolean;
    }>(`SELECT now() AS sampled_at,
      (SELECT max(heartbeat_at) FROM worker_health) AS last_heartbeat,
      EXISTS(SELECT 1 FROM worker_health WHERE heartbeat_at>now()-interval '45 seconds') AS worker_online,
      count(*) FILTER(WHERE status='queued')::int AS queued,
      count(*) FILTER(WHERE status IN ('working','dispatching'))::int AS active,
      count(*) FILTER(WHERE status='outcome_unknown' AND NOT EXISTS(SELECT 1 FROM address_selection_reconciliations r WHERE r.operation_id=operations.id AND r.owner_id=operations.owner_id AND r.account_id=operations.account_id))::int AS uncertain,
      count(*) FILTER(WHERE status='outcome_unknown' AND EXISTS(SELECT 1 FROM address_selection_reconciliations r WHERE r.operation_id=operations.id AND r.owner_id=operations.owner_id AND r.account_id=operations.account_id))::int AS reconciled_uncertain,
      count(*) FILTER(WHERE status IN ('working','dispatching') AND
        (heartbeat_at IS NULL OR heartbeat_at<now()-interval '120 seconds'))::int AS stale_active,
      min(created_at) FILTER(WHERE status='queued') AS oldest_queued_at,
      COALESCE(min(created_at) FILTER(WHERE status='queued')<now()-interval '120 seconds',false) AS queue_delayed
      FROM operations WHERE owner_id=$1 AND account_id=$2`, [owner, account.id]);
    if (!row) throw new Error("Diagnostics unavailable");
    const recent = await this.list(owner, { accountRef: account.id, limit: 1 });
    const issues: Array<{ code: string; action: string }> = [];
    if (!liveEnabled) issues.push({ code: "live_disabled", action: "Enable AMAZON_LIVE_ENABLED in the gateway and worker configuration after dedicated sign-in, then restart both." });
    if (!account.enabled) issues.push({ code: "account_disabled", action: "Use the local owner control to enable account access, then restart the worker. Watches remain paused." });
    if (account.quarantined || row.uncertain) issues.push({ code: "uncertain_write", action: "Inspect operations with outcome_unknown and reconcile the observed Amazon state. Do not replay or clear quarantine automatically." });
    if (!row.worker_online) issues.push({ code: "worker_offline", action: "Start the worker with pnpm run worker. If its profile is owned, inspect the existing process; never delete a live ownership lock." });
    if (row.stale_active) issues.push({ code: "stale_operations", action: "Inspect active operations and worker health. A stale heartbeat does not establish whether an external effect occurred." });
    if (row.queue_delayed) issues.push({ code: "queue_delayed", action: "Inspect queued operations and the active browser handoff before submitting more work." });
    if (recent.operations[0]?.status === "requires_user_action") issues.push({ code: "recent_handoff", action: "Inspect the latest operation. For a sign-in challenge, stop local:start with Ctrl-C and run pnpm run local:start --login. With manually started processes, stop the worker, complete browser:login, then restart it." });
    return {
      sampledAt: row.sampled_at.toISOString(),
      readiness: issues.length ? "needs_attention" : "available",
      authentication: "not_checked",
      account: { accountRef: account.id, enabled: account.enabled, quarantined: account.quarantined, sessionGeneration: account.session_generation },
      liveEnabled,
      worker: { online: row.worker_online, lastHeartbeatAt: row.last_heartbeat?.toISOString() ?? null, scope: "local-service" },
      queue: { queued: row.queued, active: row.active, uncertain: row.uncertain, reconciledUncertain: row.reconciled_uncertain, staleActive: row.stale_active, oldestQueuedAt: row.oldest_queued_at?.toISOString() ?? null },
      latestOperation: recent.operations[0] ?? null,
      issues,
      note: "Local configuration and journal health only. This does not contact Amazon, verify current sign-in, retry jobs or alter account state. Worker liveness is service-wide; operation counts are owner-scoped.",
    };
  }
}
