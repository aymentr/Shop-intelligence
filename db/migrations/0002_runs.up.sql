-- B-002 migration 0002: collection runs, publication receipts, run errors.
-- Spec: B-002 revision 2.1 + Amendments A (A2 EMPTY), B, C (rev 1-3 + H1) + IA-1, and the
-- Milestone 2 plan rev 2 (founder decisions D1, D2', D4, D6).
--
-- STEP 1 ONLY: tables, CHECK constraints, indexes, IA-1 composite foreign keys, read grants.
-- Not yet present (later steps of the M2 plan):
--   si_request_lock_key, trg_runs_insert                 -> step 2 (T1)
--   trg_runs_transition (SECURITY INVOKER), heartbeat,
--   trg_runs_no_delete, run_errors integrity checks      -> step 3 (T3, reaper)
--   si_complete_run, trg_runs_publish_check, receipt checks -> step 4 (T2)
-- Until those exist NO application role may write to these tables: write grants are
-- added in the same step as the trigger that enforces them.
-- Runs as si_owner with search_path = pg_catalog, pg_temp (runner), so everything is qualified.
-- References only 0001 objects (dependency rule).

------------------------------------------------------------------------------------------
-- collection_runs
------------------------------------------------------------------------------------------
CREATE TABLE si.collection_runs (
  run_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           text NOT NULL REFERENCES si.sources (source_id),
  request_key         text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_sha256      text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  attempt             int  NOT NULL CHECK (attempt BETWEEN 1 AND 20),
  status              text NOT NULL CHECK (status IN ('REJECTED','RUNNING','COMPLETED','FAILED')),
  outcome_code        text CHECK (outcome_code IN (
                        'NO_RIGHTS','RIGHTS_EXPIRED','RIGHTS_EXPIRING','EVALUATION_NOT_ALLOWED','RETAIN_NOT_ALLOWED',
                        'SOURCE_RETIRED','EVIDENCE_KIND_MISMATCH','NETWORK_SCOPE_MISMATCH','SOURCE_ERROR',
                        'VALIDATION_FAILED','DUPLICATE_CONFLICT','RIGHTS_CHANGED','LEASE_EXPIRED','LOCK_TIMEOUT',
                        'PERSISTENCE_ERROR','INTERNAL',
                        'SOURCE_SUSPENDED','RIGHTS_TERMINATED')),                -- Q2 (founder-approved)
  rights_version_id   bigint,                                               -- NULL only for REJECTED / NO_RIGHTS
  conflict_policy     text NOT NULL CHECK (conflict_policy IN ('FAIL_RUN','KEEP_FIRST')),   -- snapshot at T1
  lease_token         uuid,
  lease_expires_at    timestamptz,
  started_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at         timestamptz,
  rights_checked_at   timestamptz,
  -- historical counts: what happened in this attempt (frozen once terminal, step 3)
  received_count      int NOT NULL DEFAULT 0 CHECK (received_count   >= 0),
  published_count     int NOT NULL DEFAULT 0 CHECK (published_count  >= 0),
  duplicate_count     int NOT NULL DEFAULT 0 CHECK (duplicate_count  >= 0),
  conflict_count      int NOT NULL DEFAULT 0 CHECK (conflict_count   >= 0),
  suppressed_count    int NOT NULL DEFAULT 0 CHECK (suppressed_count >= 0),
  error_count         int NOT NULL DEFAULT 0 CHECK (error_count      >= 0),
  -- retention: what is still held (A2 adds EMPTY)
  retention_state     text NOT NULL DEFAULT 'NONE'
                        CHECK (retention_state IN ('NONE','EMPTY','RETAINED','PARTIALLY_PURGED','PURGED')),
  retain_until        timestamptz,
  first_purged_at     timestamptz,
  purged_at           timestamptz,
  -- Amendment C rev2 C-S2': clock-free control-sequence capture (computed by triggers, steps 2/4)
  start_control_seq   int NOT NULL CHECK (start_control_seq >= 0),
  publish_control_seq int CHECK (publish_control_seq >= 0),

  UNIQUE (source_id, request_key, attempt),
  UNIQUE (run_id, source_id),                                              -- target for run_errors-style FKs
  UNIQUE (run_id, source_id, rights_version_id),                           -- target for the receipt FK
  -- IA-1: a run's rights version belongs to the run's source (MATCH SIMPLE: NULL version allowed)
  CONSTRAINT runs_ia1_rights_version_source
    FOREIGN KEY (rights_version_id, source_id) REFERENCES si.rights_versions (rights_version_id, source_id),

  -- 2.1 per-status shape
  CONSTRAINT runs_rejected_shape CHECK (status <> 'REJECTED' OR (finished_at IS NOT NULL AND outcome_code IS NOT NULL
             AND lease_token IS NULL AND received_count = 0)),
  CONSTRAINT runs_running_shape CHECK (status <> 'RUNNING' OR (finished_at IS NULL AND lease_token IS NOT NULL
             AND lease_expires_at IS NOT NULL AND rights_version_id IS NOT NULL AND outcome_code IS NULL)),
  -- (A2: "retain_until IS NOT NULL" removed from the COMPLETED shape; the EMPTY rules below cover it)
  CONSTRAINT runs_completed_shape CHECK (status <> 'COMPLETED' OR (finished_at IS NOT NULL AND rights_version_id IS NOT NULL
             AND rights_checked_at IS NOT NULL AND outcome_code IS NULL AND error_count = 0 AND lease_token IS NULL
             AND received_count = published_count + duplicate_count + suppressed_count)),
  CONSTRAINT runs_failed_shape CHECK (status <> 'FAILED' OR (finished_at IS NOT NULL AND outcome_code IS NOT NULL
             AND published_count = 0)),
  CONSTRAINT runs_retention_iff_completed CHECK ((status = 'COMPLETED') = (retention_state <> 'NONE')),
  CONSTRAINT runs_first_purged CHECK (retention_state NOT IN ('PARTIALLY_PURGED','PURGED') OR first_purged_at IS NOT NULL),
  CONSTRAINT runs_purged_at CHECK ((retention_state = 'PURGED') = (purged_at IS NOT NULL)),
  -- Amendment A2: successful empty collections
  CONSTRAINT runs_empty_iff_none_published CHECK ((retention_state = 'EMPTY') = (status = 'COMPLETED' AND published_count = 0)),
  CONSTRAINT runs_empty_iff_no_deadline CHECK ((retention_state = 'EMPTY') = (status = 'COMPLETED' AND retain_until IS NULL)),
  CONSTRAINT runs_empty_final CHECK (retention_state <> 'EMPTY' OR (first_purged_at IS NULL AND purged_at IS NULL)),
  -- D4 consistency (makes A2 / 2.1 prose enforceable)
  CONSTRAINT runs_duplicates_cannot_empty CHECK (status <> 'COMPLETED' OR received_count = 0 OR duplicate_count < received_count),
  CONSTRAINT runs_fail_run_no_conflicts CHECK (status <> 'COMPLETED' OR conflict_policy = 'KEEP_FIRST' OR conflict_count = 0),
  CONSTRAINT runs_errors_only_failed CHECK (status = 'FAILED' OR error_count = 0),
  -- Q2 / D6: outcome codes per status (documented meanings, docs/b002-m2-plan.md section 3.3)
  CONSTRAINT runs_rejected_codes CHECK (status <> 'REJECTED' OR outcome_code IN (
             'NO_RIGHTS','RIGHTS_EXPIRED','RIGHTS_EXPIRING','EVALUATION_NOT_ALLOWED','RETAIN_NOT_ALLOWED',
             'SOURCE_RETIRED','EVIDENCE_KIND_MISMATCH','NETWORK_SCOPE_MISMATCH','RIGHTS_TERMINATED')),
  CONSTRAINT runs_failed_codes CHECK (status <> 'FAILED' OR outcome_code IN (
             'SOURCE_ERROR','VALIDATION_FAILED','DUPLICATE_CONFLICT','LEASE_EXPIRED','RIGHTS_TERMINATED',
             'SOURCE_SUSPENDED','SOURCE_RETIRED','RIGHTS_CHANGED','RIGHTS_EXPIRING','LOCK_TIMEOUT',
             'PERSISTENCE_ERROR','INTERNAL')),
  -- Amendment C: control sequences
  CONSTRAINT runs_publish_seq_iff_completed CHECK ((status = 'COMPLETED') = (publish_control_seq IS NOT NULL)),
  CONSTRAINT runs_publish_seq_after_start CHECK (publish_control_seq IS NULL OR publish_control_seq >= start_control_seq),
  -- IA-1 nullability: only a NO_RIGHTS rejection has no rights version
  CONSTRAINT runs_version_required CHECK (rights_version_id IS NOT NULL OR (status = 'REJECTED' AND outcome_code = 'NO_RIGHTS'))
);
CREATE UNIQUE INDEX runs_one_completed ON si.collection_runs (source_id, request_key) WHERE status = 'COMPLETED';
CREATE UNIQUE INDEX runs_one_running   ON si.collection_runs (source_id, request_key) WHERE status = 'RUNNING';
CREATE INDEX runs_lease     ON si.collection_runs (lease_expires_at) WHERE status = 'RUNNING';
CREATE INDEX runs_retention ON si.collection_runs (retain_until) WHERE retention_state IN ('RETAINED','PARTIALLY_PURGED');
CREATE INDEX runs_by_rights_version ON si.collection_runs (rights_version_id, source_id);   -- IA-1 FK lookups

------------------------------------------------------------------------------------------
-- publication_receipts: one per COMPLETED run, with the same source/rights-version integrity
------------------------------------------------------------------------------------------
CREATE TABLE si.publication_receipts (
  run_id             uuid PRIMARY KEY,
  source_id          text NOT NULL,
  rights_version_id  bigint NOT NULL,
  receipt_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  commit_ts          timestamptz,                    -- filled by the 0004 monitor (D3)
  within_validity    boolean,                        -- ditto; NULL until verified
  -- the receipt names exactly its run's source and rights version
  CONSTRAINT receipts_match_run
    FOREIGN KEY (run_id, source_id, rights_version_id) REFERENCES si.collection_runs (run_id, source_id, rights_version_id),
  -- IA-1 equivalent: the version belongs to the source
  CONSTRAINT receipts_ia1_rights_version_source
    FOREIGN KEY (rights_version_id, source_id) REFERENCES si.rights_versions (rights_version_id, source_id),
  CONSTRAINT receipts_validity_needs_commit_ts CHECK (within_validity IS NULL OR commit_ts IS NOT NULL)
);
CREATE INDEX receipts_by_rights_version ON si.publication_receipts (rights_version_id, source_id);

------------------------------------------------------------------------------------------
-- run_errors: codes, row indices and field names only (no free text by construction)
------------------------------------------------------------------------------------------
CREATE TABLE si.run_errors (
  run_id             uuid NOT NULL REFERENCES si.collection_runs (run_id),
  seq                int  NOT NULL CHECK (seq BETWEEN 1 AND 100),
  code               text NOT NULL CHECK (code ~ '^[A-Z][A-Z_]{2,40}$'),
  row_index          int  CHECK (row_index >= 0),
  field              text CHECK (field IN ('network','nativeAdId','advertiserName','countries','seenAt',
                       'sourceUrl','title','destinationUrl','creativeUrl',
                       'sourceReportedFirstSeen','sourceReportedLastSeen')),
  correlation_id     uuid NOT NULL,
  PRIMARY KEY (run_id, seq)
);

------------------------------------------------------------------------------------------
-- Privileges (step 1: read only). Nothing is granted to PUBLIC.
------------------------------------------------------------------------------------------
REVOKE ALL ON si.collection_runs, si.publication_receipts, si.run_errors FROM PUBLIC;
GRANT SELECT ON si.collection_runs TO si_collector, si_rights_admin, si_retention;
GRANT SELECT ON si.publication_receipts TO si_collector, si_retention;
GRANT SELECT ON si.run_errors TO si_retention;
