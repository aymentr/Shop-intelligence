-- B-002 M4-P3.0.1-CLOSE-01: catalog integrity gate for the evidence references the readers rely on (docs §14.9).
-- Not a migration; changes nothing. Run as si_owner (or any role that can read the catalog) at deployment
-- verification, in DR-1 and before re-enabling readers after any privileged operation:
--   psql -X -v ON_ERROR_STOP=1 -At -f db/ops/integrity-gate.sql
-- PASS = zero rows. Each row names one failed check. A PASS says the CONSTRAINTS are in force now; it does NOT say that
-- rows written while they were not (dropped, NOT VALID, triggers disabled, replica mode) are consistent: for that, run
-- db/ops/fk-audit.sql.
WITH expected(conname, def, referenced_key) AS (VALUES
  ('observations_ad',
   'FOREIGN KEY (ad_id, source_id, network, native_ad_id) REFERENCES si.ads(ad_id, source_id, network, native_ad_id) ON DELETE RESTRICT',
   'UNIQUE (ad_id, source_id, network, native_ad_id)'),
  ('observations_run',
   'FOREIGN KEY (run_id, source_id, rights_version_id) REFERENCES si.collection_runs(run_id, source_id, rights_version_id)',
   'UNIQUE (run_id, source_id, rights_version_id)')),
fk AS (
  SELECT e.conname, e.def, e.referenced_key, c.oid, c.contype, c.convalidated, c.conkey, c.confrelid, c.conindid,
         regexp_replace(pg_get_constraintdef(c.oid), ' NOT VALID$', '') AS actual   -- validation: FK_NOT_VALIDATED
    FROM expected e
    LEFT JOIN pg_constraint c ON c.conname = e.conname AND c.conrelid = 'si.observations'::regclass),
immutability(tgname, relname) AS (VALUES
  ('trg_observations_append_only', 'observations'), ('trg_observations_no_truncate', 'observations'),
  ('trg_observation_run_completed', 'observations'), ('trg_observation_purge_check', 'observations'),
  ('trg_ads_append_only', 'ads'), ('trg_ads_no_truncate', 'ads'), ('trg_ad_has_observation', 'ads'))
SELECT 'FK_MISSING' AS check, conname AS detail FROM fk WHERE oid IS NULL
UNION ALL
SELECT 'FK_NOT_FOREIGN_KEY', conname FROM fk WHERE oid IS NOT NULL AND contype <> 'f'
UNION ALL
SELECT 'FK_DEFINITION', conname || ': ' || actual FROM fk WHERE oid IS NOT NULL AND actual IS DISTINCT FROM def
UNION ALL
SELECT 'FK_NOT_VALIDATED', conname FROM fk WHERE oid IS NOT NULL AND NOT convalidated
UNION ALL
SELECT 'FK_TRIGGERS', conname || ': ' || (SELECT count(*) FROM pg_trigger t WHERE t.tgconstraint = fk.oid AND t.tgenabled IN ('O', 'A'))
                       || ' of 4 enforcement triggers enabled'
  FROM fk WHERE oid IS NOT NULL
   AND (SELECT count(*) FROM pg_trigger t WHERE t.tgconstraint = fk.oid AND t.tgenabled IN ('O', 'A')) <> 4
UNION ALL
SELECT 'FK_COLUMN_NULLABLE', fk.conname || ': ' || a.attname
  FROM fk JOIN pg_attribute a ON a.attrelid = 'si.observations'::regclass AND a.attnum = ANY (fk.conkey)
 WHERE fk.oid IS NOT NULL AND NOT a.attnotnull
UNION ALL
SELECT 'FK_REFERENCED_KEY', fk.conname
  FROM fk WHERE fk.oid IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM pg_constraint u JOIN pg_index i ON i.indexrelid = u.conindid
                    WHERE u.conrelid = fk.confrelid AND u.contype IN ('u', 'p') AND u.conindid = fk.conindid
                      AND pg_get_constraintdef(u.oid) = fk.referenced_key AND i.indisvalid AND i.indisunique)
UNION ALL
SELECT 'IMMUTABILITY_TRIGGER', m.tgname
  FROM immutability m
 WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = ('si.' || m.relname)::regclass AND t.tgname = m.tgname
                     AND t.tgenabled IN ('O', 'A'))
UNION ALL
SELECT 'REPLICA_DEFAULT', coalesce(d.datname, '*') || '/' || coalesce(r.rolname, '*')
  FROM pg_db_role_setting s
  LEFT JOIN pg_database d ON d.oid = s.setdatabase
  LEFT JOIN pg_roles r ON r.oid = s.setrole
 WHERE EXISTS (SELECT 1 FROM unnest(s.setconfig) c WHERE c ILIKE 'session_replication_role=%' AND c NOT ILIKE '%=origin')
ORDER BY 1, 2;
