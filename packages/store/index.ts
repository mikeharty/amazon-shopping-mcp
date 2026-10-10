import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg, { type PoolClient } from "pg";
import { makeWorkerUtils } from "graphile-worker";
import { DomainError, type Result } from "../contracts/index.js";
import {
  productHistorySubject,
  type ObservationProvenance,
} from "../core/observations.js";
import { Vault, digest } from "./crypto.js";
export type Account = {
  id: string;
  owner_id: string;
  marketplace: "amazon.com";
  session_generation: number;
  enabled: boolean;
  quarantined: boolean;
  quarantine_reason: string | null;
};
export type Operation = {
  id: string;
  owner_id: string;
  account_id: string;
  kind: string;
  mode: "read" | "write" | "commit";
  input: Record<string, unknown>;
  status: string;
  revision: number;
  result?: Result;
  intent_id?: string;
  worker_id?: string;
};
export type Intent = {
  id: string;
  owner_id: string;
  account_id: string;
  kind: string;
  terms: Record<string, unknown>;
  digest: string;
  expires_at: Date;
  approved_at: Date | null;
  consumed_at: Date | null;
  session_generation: number;
};
export class Store {
  readonly pool: pg.Pool;
  readonly vault: Vault;
  constructor(connectionString: string, encryptionKey: string) {
    this.pool = new pg.Pool({ connectionString, max: 8 });
    this.pool.on("error", () => {
      console.error("Database connection failed; reconnect required.");
    });
    this.pool.on("connect", (client) =>
      client.on("error", () => {
        console.error("Database client disconnected.");
      }),
    );
    this.vault = new Vault(encryptionKey);
  }
  async migrate() {
    const worker = await makeWorkerUtils({ pgPool: this.pool });
    await worker.migrate();
    await worker.release();
    await this.pool.query(
      await readFile(
        new URL("./migrations/001_initial.sql", import.meta.url),
        "utf8",
      ),
    );
    // Repair the pre-release generation-keyed history without inventing old context.
    let after: string | null = null;
    while (true) {
      const {
        rows,
      }: {
        rows: Array<{
          id: string;
          value: string;
          owner_id: string;
          marketplace: "amazon.com";
        }>;
      } = await this.pool.query(
        "SELECT observations.*,accounts.marketplace FROM observations JOIN accounts ON accounts.id=observations.account_id WHERE provenance IS NULL AND kind='products_get' AND ($1::uuid IS NULL OR observations.id>$1::uuid) ORDER BY observations.id LIMIT 100",
        [after],
      );
      if (!rows.length) break;
      for (const row of rows) {
        const value = this.vault.open<Record<string, unknown>>(
          row.value,
          row.owner_id,
        );
        if (
          !value ||
          typeof value !== "object" ||
          typeof value.asin !== "string" ||
          !/^[A-Z0-9]{10}$/.test(value.asin)
        )
          continue;
        const provenance: ObservationProvenance = {
          marketplace: row.marketplace,
          asin: value.asin,
          sessionGeneration: null,
          source: "legacy-provider-unrecorded",
          sourceObservedAt: null,
          providerContextRef: null,
          contextRef: `unverified:${row.id}`,
          deliveryContext: { status: "unverified" },
          productIdentityVerified: false,
          quoteEligible: false,
        };
        await this.pool.query(
          "UPDATE observations SET subject=$2,provenance=$3 WHERE id=$1 AND provenance IS NULL",
          [
            row.id,
            productHistorySubject(row.marketplace, value.asin),
            this.vault.seal(provenance, row.owner_id),
          ],
        );
      }
      after = rows.at(-1)!.id;
    }
  }
  async close() {
    await this.pool.end();
  }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async account(owner: string): Promise<Account> {
    const { rows } = await this.pool.query(
      `INSERT INTO accounts(id,owner_id,marketplace) VALUES($1,$2,'amazon.com') ON CONFLICT(owner_id,marketplace) DO UPDATE SET owner_id=excluded.owner_id RETURNING *`,
      [randomUUID(), owner],
    );
    return rows[0];
  }
  async getAccount(
    owner: string,
    id: string,
    c: pg.Pool | PoolClient = this.pool,
    lock = false,
  ): Promise<Account> {
    const { rows } = await c.query(
      `SELECT * FROM accounts WHERE id=$1 AND owner_id=$2 ${lock ? "FOR UPDATE" : ""}`,
      [id, owner],
    );
    if (!rows[0]) throw new DomainError("NOT_FOUND", "Account not found", 404);
    return rows[0];
  }
  private operation(row: Record<string, unknown>): Operation {
    return {
      ...row,
      input: this.vault.open(String(row.input), String(row.owner_id)),
      result: row.result
        ? this.vault.open(String(row.result), String(row.owner_id))
        : undefined,
    } as Operation;
  }
  async getOperation(owner: string, id: string): Promise<Operation> {
    const { rows } = await this.pool.query(
      "SELECT * FROM operations WHERE id=$1 AND owner_id=$2",
      [id, owner],
    );
    if (!rows[0])
      throw new DomainError("NOT_FOUND", "Operation not found", 404);
    return this.operation(rows[0]);
  }
  private async enqueue(c: PoolClient, id: string, accountId: string) {
    await c.query(
      `SELECT graphile_worker.add_job('execute_operation',$1::json,queue_name:=$2,job_key:=$3,max_attempts:=3)`,
      [
        JSON.stringify({ operationId: id }),
        `account:${accountId}`,
        `operation:${id}`,
      ],
    );
  }
  async start(
    owner: string,
    accountId: string,
    kind: string,
    mode: "read" | "write",
    input: Record<string, unknown>,
    key: string,
  ): Promise<Operation> {
    return this.transaction(async (c) => {
      const account = await this.getAccount(owner, accountId, c, true);
      if (!account.enabled)
        throw new DomainError(
          "ACCOUNT_DISCONNECTED",
          "Account access is disconnected",
        );
      const hash = digest({ accountId, kind, mode, input });
      const old = await c.query(
        "SELECT * FROM operations WHERE owner_id=$1 AND idempotency_key=$2",
        [owner, key],
      );
      if (old.rows[0]) {
        if (old.rows[0].input_digest !== hash)
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "Key already identifies a different request",
          );
        return this.operation(old.rows[0]);
      }
      if (mode === "write" && account.quarantined)
        throw new DomainError(
          "ACCOUNT_QUARANTINED",
          "Uncertain prior action requires reconciliation",
        );
      const id = randomUUID();
      const { rows } = await c.query(
        `INSERT INTO operations(id,owner_id,account_id,kind,mode,input,input_digest,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          id,
          owner,
          accountId,
          kind,
          mode,
          this.vault.seal(input, owner),
          hash,
          key,
        ],
      );
      await this.enqueue(c, id, accountId);
      return this.operation(rows[0]);
    });
  }
  async prepare(
    owner: string,
    accountId: string,
    kind: string,
    terms: Record<string, unknown>,
    ttlSeconds = 300,
    expectedSessionGeneration?: number,
  ): Promise<Intent> {
    return this.transaction(async (c) => {
      const a = await this.getAccount(owner, accountId, c, true);
      if (expectedSessionGeneration !== undefined && a.session_generation !== expectedSessionGeneration)
        throw new DomainError("STALE_SESSION", "Browser session changed during preparation");
      if (!a.enabled)
        throw new DomainError(
          "ACCOUNT_DISCONNECTED",
          "Account access is disconnected",
        );
      if (a.quarantined)
        throw new DomainError(
          "ACCOUNT_QUARANTINED",
          "Resolve the uncertain prior action first",
        );
      const id = randomUUID();
      await c.query(
        `INSERT INTO intents(id,owner_id,account_id,kind,terms,digest,session_generation,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+make_interval(secs:=$8))`,
        [
          id,
          owner,
          accountId,
          kind,
          this.vault.seal(terms, owner),
          digest(terms),
          a.session_generation,
          ttlSeconds,
        ],
      );
      return this.getIntent(owner, id, c);
    });
  }
  async getIntent(
    owner: string,
    id: string,
    c: pg.Pool | PoolClient = this.pool,
  ): Promise<Intent> {
    const { rows } = await c.query(
      "SELECT * FROM intents WHERE id=$1 AND owner_id=$2",
      [id, owner],
    );
    if (!rows[0]) throw new DomainError("NOT_FOUND", "Intent not found", 404);
    return { ...rows[0], terms: this.vault.open(rows[0].terms, owner) };
  }
  // Only call from authenticated owner UI. Never expose as an MCP tool.
  async approve(
    owner: string,
    id: string,
    expectedDigest: string,
  ): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE intents AS i SET approved_at=now() WHERE i.id=$1 AND i.owner_id=$2 AND i.digest=$3 AND i.expires_at>now() AND i.consumed_at IS NULL AND EXISTS(SELECT 1 FROM accounts AS a WHERE a.id=i.account_id AND a.owner_id=i.owner_id AND a.enabled AND NOT a.quarantined AND a.session_generation=i.session_generation)`,
      [id, owner, expectedDigest],
    );
    if (!rowCount)
      throw new DomainError(
        "STALE_INTENT",
        "Intent expired, changed or consumed",
      );
    await this.pool.query(
      "INSERT INTO audit(owner_id,action,resource_id) VALUES($1,$2,$3)",
      [owner, "owner_approved", id],
    );
  }
  async submit(
    owner: string,
    intentId: string,
    key: string,
  ): Promise<Operation> {
    return this.transaction(async (c) => {
      const initial = await this.getIntent(owner, intentId, c);
      const a = await this.getAccount(owner, initial.account_id, c, true);
      const locked = await c.query(
        "SELECT * FROM intents WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [intentId, owner],
      );
      const intent = locked.rows[0];
      const existing = await c.query(
        "SELECT * FROM operations WHERE intent_id=$1 AND owner_id=$2",
        [intentId, owner],
      );
      if (existing.rows[0]) return this.operation(existing.rows[0]);
      if (!a.enabled)
        throw new DomainError(
          "ACCOUNT_DISCONNECTED",
          "Account access is disconnected",
        );
      if (a.quarantined)
        throw new DomainError(
          "ACCOUNT_QUARANTINED",
          "Uncertain prior action requires reconciliation",
        );
      if (
        !intent.approved_at ||
        intent.consumed_at ||
        new Date(intent.expires_at) <= new Date() ||
        intent.session_generation !== a.session_generation
      )
        throw new DomainError(
          "CONSENT_REQUIRED",
          "A current owner-approved intent is required",
        );
      const collision = await c.query(
        "SELECT id FROM operations WHERE owner_id=$1 AND idempotency_key=$2",
        [owner, key],
      );
      if (collision.rows.length)
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "Key already identifies another operation",
        );
      const id = randomUUID();
      const { rows } = await c.query(
        `INSERT INTO operations(id,owner_id,account_id,kind,mode,input,input_digest,idempotency_key,intent_id) VALUES($1,$2,$3,$4,'commit',$5,$6,$7,$8) RETURNING *`,
        [
          id,
          owner,
          intent.account_id,
          intent.kind,
          intent.terms,
          intent.digest,
          key,
          intentId,
        ],
      );
      await c.query("UPDATE intents SET consumed_at=now() WHERE id=$1", [
        intentId,
      ]);
      await this.enqueue(c, id, intent.account_id);
      return this.operation(rows[0]);
    });
  }
  async claim(id: string, worker: string): Promise<Operation | null> {
    return this.transaction(async (c) => {
      const initial = await c.query(
        "SELECT owner_id,account_id FROM operations WHERE id=$1",
        [id],
      );
      if (!initial.rows[0]) return null;
      const a = await this.getAccount(
        initial.rows[0].owner_id,
        initial.rows[0].account_id,
        c,
        true,
      );
      const found = await c.query(
        "SELECT * FROM operations WHERE id=$1 FOR UPDATE",
        [id],
      );
      const op = found.rows[0];
      if (!op || op.status !== "queued") return null;
      if (!a.enabled) {
        await c.query(
          "UPDATE operations SET status='cancelled',revision=revision+1 WHERE id=$1",
          [id],
        );
        return null;
      }
      if (op.mode !== "read" && a.quarantined) {
        await c.query(
          `UPDATE operations SET status='conflict',revision=revision+1,updated_at=now() WHERE id=$1`,
          [id],
        );
        return null;
      }
      const { rows } = await c.query(
        `UPDATE operations SET status='working',worker_id=$2,started_at=now(),heartbeat_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, worker],
      );
      return this.operation(rows[0]);
    });
  }
  async markDispatch(id: string, worker: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE operations SET status='dispatching',revision=revision+1,updated_at=now() WHERE id=$1 AND worker_id=$2 AND status='working' AND mode<>'read'`,
      [id, worker],
    );
    return rowCount === 1;
  }
  async finish(op: Operation, worker: string, result: Result): Promise<void> {
    await this.transaction(async (c) => {
      await this.getAccount(op.owner_id, op.account_id, c, true);
      const { rows } = await c.query(
        "SELECT status FROM operations WHERE id=$1 AND worker_id=$2 FOR UPDATE",
        [op.id, worker],
      );
      if (!rows[0] || !["working", "dispatching"].includes(rows[0].status))
        throw new DomainError(
          "STALE_WORKER",
          "Worker no longer owns operation",
        );
      if (result.status === "outcome_unknown")
        await c.query(
          "UPDATE accounts SET quarantined=true,quarantine_reason=$2 WHERE id=$1",
          [op.account_id, op.id],
        );
      await c.query(
        `UPDATE operations SET status=$3,result=$4,revision=revision+1,updated_at=now() WHERE id=$1 AND worker_id=$2`,
        [op.id, worker, result.status, this.vault.seal(result, op.owner_id)],
      );
    });
  }
  async cancel(
    owner: string,
    id: string,
    revision: number,
  ): Promise<Operation> {
    const { rowCount } = await this.pool.query(
      `UPDATE operations SET status='cancelled',revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND revision=$3 AND status='queued'`,
      [id, owner, revision],
    );
    if (!rowCount)
      throw new DomainError(
        "TOO_LATE_OR_STALE",
        "Only queued work can be cancelled; dispatched side effects may already exist",
      );
    return this.getOperation(owner, id);
  }
  async recoverStale(before: Date): Promise<number> {
    return this.transaction(async (c) => {
      const candidates = await c.query(
        "SELECT id,account_id,owner_id FROM operations WHERE status IN ('working','dispatching') AND heartbeat_at<$1 ORDER BY account_id,id",
        [before],
      );
      let recovered = 0;
      for (const candidate of candidates.rows) {
        await this.getAccount(
          candidate.owner_id,
          candidate.account_id,
          c,
          true,
        );
        const current = await c.query(
          "SELECT * FROM operations WHERE id=$1 AND status IN ('working','dispatching') AND heartbeat_at<$2 FOR UPDATE",
          [candidate.id, before],
        );
        const row = current.rows[0];
        if (!row) continue;
        const uncertain = row.mode !== "read";
        const result: Result = uncertain
          ? {
              status: "outcome_unknown",
              error: { code: "STALE_WORKER_UNKNOWN_OUTCOME", retryable: false },
            }
          : {
              status: "failed",
              error: { code: "STALE_READ_INTERRUPTED", retryable: true },
            };
        await c.query(
          "UPDATE operations SET status=$2,result=$3,revision=revision+1,updated_at=now() WHERE id=$1",
          [row.id, result.status, this.vault.seal(result, row.owner_id)],
        );
        if (uncertain)
          await c.query(
            "UPDATE accounts SET quarantined=true,quarantine_reason=$2 WHERE id=$1",
            [row.account_id, row.id],
          );
        recovered++;
      }
      return recovered;
    });
  }
  async heartbeat(worker: string) {
    await this.pool.query(
      `INSERT INTO worker_health(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now()`,
      [worker],
    );
    await this.pool.query(
      `UPDATE operations SET heartbeat_at=now() WHERE worker_id=$1 AND status IN ('working','dispatching')`,
      [worker],
    );
  }
  async workerHealth(): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM worker_health WHERE heartbeat_at>now()-interval '45 seconds' LIMIT 1`,
    );
    return r.rows.length > 0;
  }
  async disconnect(owner: string, accountId: string): Promise<void> {
    await this.transaction(async (c) => {
      await this.getAccount(owner, accountId, c, true);
      const busy = await c.query(
        "SELECT id FROM operations WHERE account_id=$1 AND status IN ('working','dispatching') LIMIT 1",
        [accountId],
      );
      if (busy.rows.length)
        throw new DomainError(
          "ACCOUNT_BUSY",
          "Wait for active operations to settle before disconnecting",
        );
      await c.query(
        "UPDATE accounts SET enabled=false,session_generation=session_generation+1 WHERE id=$1",
        [accountId],
      );
      await c.query(
        "UPDATE operations SET status='cancelled',revision=revision+1 WHERE account_id=$1 AND status='queued'",
        [accountId],
      );
      await c.query(
        "UPDATE watches SET paused=true,revision=revision+1 WHERE account_id=$1",
        [accountId],
      );
    });
  }
  async deletePrivateData(owner: string): Promise<void> {
    await this.transaction(async (c) => {
      await c.query("SELECT id FROM accounts WHERE owner_id=$1 FOR UPDATE", [
        owner,
      ]);
      const busy = await c.query(
        "SELECT id FROM operations WHERE owner_id=$1 AND status IN ('working','dispatching','outcome_unknown') LIMIT 1",
        [owner],
      );
      if (busy.rows.length)
        throw new DomainError(
          "UNRESOLVED_OPERATIONS",
          "Active or uncertain operations must be resolved before deleting the audit trail",
        );
      for (const table of [
        "events",
        "watches",
        "observations",
        "operations",
        "intents",
        "audit",
      ])
        await c.query(`DELETE FROM ${table} WHERE owner_id=$1`, [owner]);
      await c.query(
        "UPDATE accounts SET enabled=false,session_generation=session_generation+1 WHERE owner_id=$1",
        [owner],
      );
    });
  }
  async reconnect(owner: string, accountId: string): Promise<void> {
    await this.transaction(async (c) => {
      const a = await this.getAccount(owner, accountId, c, true);
      if (a.quarantined)
        throw new DomainError(
          "ACCOUNT_QUARANTINED",
          "Resolve the uncertain prior action before reconnecting",
        );
      await c.query(
        "UPDATE accounts SET enabled=true,session_generation=session_generation+1 WHERE id=$1",
        [accountId],
      );
    });
  }
}
