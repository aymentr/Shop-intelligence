-- B-002 migration 0007 down: remove receipt verification and restore the 0002 receipt guard and the
-- 0006 purge-reason function byte for byte (CREATE OR REPLACE keeps their owners and ACLs).

DROP FUNCTION si.si_evidence_readable(uuid);
DROP FUNCTION si.si_verification_failures(int);
DROP FUNCTION si.si_verification_status();
DROP FUNCTION si.si_record_verification_failure(text, text);
DROP FUNCTION si.si_verify_receipts(int);
DROP INDEX si.runs_verification_pending;
DROP TABLE si.verification_failures;
DROP TABLE si.receipt_verifications;
DROP FUNCTION si.trg_verification_records_append_only();
DROP FUNCTION si.trg_verification_insert();
DROP FUNCTION si.si_receipt_verdict(uuid);
DROP FUNCTION si.si_commit_ts(xid);
DROP FUNCTION si.si_verification_lag_target();
DROP FUNCTION si.si_verification_max_xid_age();

CREATE OR REPLACE FUNCTION si.si_retention_end_reason(p_source_id text, p_version int, p_retain_until timestamptz)
RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
           WHEN t.at IS NOT NULL AND t.at <= least(p_retain_until, e.at) THEN 'TERMINATED'
           WHEN e.at IS NOT NULL AND e.at < p_retain_until THEN 'RIGHTS_ENDED'
           ELSE 'RETENTION_PERIOD'
         END
    FROM (SELECT si.si_retention_end(p_source_id, p_version) AS at) e,
         (SELECT min(c.occurred_at) AS at FROM si.source_controls c
           WHERE c.source_id = p_source_id AND c.kind = 'TERMINATE_RETENTION' AND c.through_version >= p_version) t
$$;

CREATE OR REPLACE FUNCTION si.trg_receipts_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $receipt_guard$
BEGIN
  IF TG_OP <> 'UPDATE'
     OR ROW(NEW.run_id, NEW.source_id, NEW.rights_version_id, NEW.receipt_at)
        IS DISTINCT FROM ROW(OLD.run_id, OLD.source_id, OLD.rights_version_id, OLD.receipt_at)
     OR (OLD.commit_ts IS NOT NULL AND NEW.commit_ts IS DISTINCT FROM OLD.commit_ts)
     OR (OLD.within_validity IS NOT NULL AND NEW.within_validity IS DISTINCT FROM OLD.within_validity) THEN
    RAISE EXCEPTION 'SI_RECEIPT_IMMUTABLE: publication receipts cannot be changed or removed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $receipt_guard$;

ALTER TABLE si.publication_receipts DROP CONSTRAINT receipts_legacy_columns_unused;
