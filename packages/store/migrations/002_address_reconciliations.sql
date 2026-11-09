CREATE TABLE IF NOT EXISTS address_selection_reconciliations(
 operation_id uuid PRIMARY KEY REFERENCES operations(id),
 owner_id text NOT NULL, account_id uuid NOT NULL REFERENCES accounts(id),
 snapshot_operation_id uuid NOT NULL REFERENCES operations(id),
 reconciliation_operation_id uuid NOT NULL REFERENCES operations(id),
 evidence_digest text NOT NULL, receipt text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS address_reconciliation_owner_account ON address_selection_reconciliations(owner_id,account_id);
INSERT INTO schema_migrations(version) VALUES ('002_address_reconciliations') ON CONFLICT DO NOTHING;
