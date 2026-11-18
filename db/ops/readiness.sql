-- B-002 M4-P3.3 Phase 1 (R-45, docs §17): SCHEMA READINESS of the index created by migration 0022.
--
-- This is a deployment check of one physical structure, not an evidence-integrity check. It says nothing about the
-- correctness of observations, summaries, keys or privileges: for those run db/ops/integrity-gate.sql, db/ops/fk-audit.sql
-- and db/ops/verify-summaries.sql. Read-only (catalog only); any role can run it:
--   psql -X -v ON_ERROR_STOP=1 -At -f db/ops/readiness.sql
-- PASS = zero rows. Each row is one failure: code | object.
--
-- The required index (migration 0022; the RT-13 emergency-purge bound depends on it, docs §15C):
--   CREATE INDEX observations_by_ad_fk ON si.observations USING btree (ad_id, source_id, network, native_ad_id)
-- i.e. a live, valid, ready, non-partial btree on si.observations whose key is exactly those four columns in that order,
-- each with the column's collation, the type's default btree operator class and ascending order (NULLS LAST), with no
-- expression and no INCLUDE column. In addition, no index anywhere in schema si may be invalid, not ready or not live: a
-- failed CREATE INDEX CONCURRENTLY or REINDEX CONCURRENTLY leaves such an artifact, which the planner ignores.
--
-- Codes:
--   NOT_AN_INDEX             a relation named si.observations_by_ad_fk exists but is not an index
--   INDEX_MISSING            no relation named si.observations_by_ad_fk
--   INDEX_WRONG_TABLE        the index is not on si.observations
--   INDEX_NOT_VALID          pg_index.indisvalid is false (e.g. a cancelled or failed concurrent build)
--   INDEX_NOT_READY          pg_index.indisready is false
--   INDEX_NOT_LIVE           pg_index.indislive is false (being dropped concurrently)
--   INDEX_WRONG_ACCESS_METHOD the access method is not btree
--   INDEX_PARTIAL            the index has a predicate (WHERE ...)
--   INDEX_EXPRESSION         the index has an expression key
--   INDEX_INCLUDED_COLUMNS   the index has INCLUDE columns
--   INDEX_WRONG_KEY          the key columns are not exactly (ad_id, source_id, network, native_ad_id), in that order
--   INDEX_WRONG_COLLATION    a key column does not use the column's own collation
--   INDEX_WRONG_OPCLASS      a key column does not use the default btree operator class of its type
--   INDEX_WRONG_DIRECTION    a key column is DESC or NULLS FIRST
--   INDEX_WRONG_DEFINITION   pg_get_indexdef differs from the required text (catch-all: also UNIQUE, NULLS NOT DISTINCT)
--   INVALID_INDEX_ARTIFACT   another index in schema si is invalid, not ready or not live (object = its name)
WITH target AS (
  SELECT c.oid, c.relkind FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'si'::regnamespace AND c.relname = 'observations_by_ad_fk'),
ix AS (
  SELECT i.indexrelid, i.indrelid, i.indisvalid, i.indisready, i.indislive, i.indnatts, i.indnkeyatts, i.indpred, i.indexprs,
         i.indkey, i.indcollation, i.indclass, i.indoption, c.relam
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
   WHERE i.indexrelid IN (SELECT t.oid FROM target t)),
expected(pos, attname) AS (VALUES (1, 'ad_id'), (2, 'source_id'), (3, 'network'), (4, 'native_ad_id')),
keycols AS (                                                           -- the index's key columns, 1-based, as resolved
  SELECT k.pos, a.attname, a.atttypid, a.attcollation,
         ix.indcollation[k.pos - 1] AS coll, ix.indclass[k.pos - 1] AS opclass, ix.indoption[k.pos - 1] AS opt
    FROM ix CROSS JOIN LATERAL pg_catalog.generate_series(1, ix.indnkeyatts) AS k(pos)
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ix.indkey[k.pos - 1] AND ix.indkey[k.pos - 1] <> 0),
failures(code, object) AS (
  SELECT 'NOT_AN_INDEX', 'si.observations_by_ad_fk' FROM target t WHERE t.relkind <> 'i'
  UNION ALL SELECT 'INDEX_MISSING', 'si.observations_by_ad_fk' WHERE NOT EXISTS (SELECT 1 FROM target)
  UNION ALL SELECT 'INDEX_WRONG_TABLE', ix.indrelid::regclass::text FROM ix WHERE ix.indrelid IS DISTINCT FROM pg_catalog.to_regclass('si.observations')
  UNION ALL SELECT 'INDEX_NOT_VALID', 'si.observations_by_ad_fk' FROM ix WHERE NOT ix.indisvalid
  UNION ALL SELECT 'INDEX_NOT_READY', 'si.observations_by_ad_fk' FROM ix WHERE NOT ix.indisready
  UNION ALL SELECT 'INDEX_NOT_LIVE', 'si.observations_by_ad_fk' FROM ix WHERE NOT ix.indislive
  UNION ALL SELECT 'INDEX_WRONG_ACCESS_METHOD', am.amname::text FROM ix JOIN pg_catalog.pg_am am ON am.oid = ix.relam WHERE am.amname <> 'btree'
  UNION ALL SELECT 'INDEX_PARTIAL', 'si.observations_by_ad_fk' FROM ix WHERE ix.indpred IS NOT NULL
  UNION ALL SELECT 'INDEX_EXPRESSION', 'si.observations_by_ad_fk' FROM ix WHERE ix.indexprs IS NOT NULL
  UNION ALL SELECT 'INDEX_INCLUDED_COLUMNS', 'si.observations_by_ad_fk' FROM ix WHERE ix.indnatts <> ix.indnkeyatts
  UNION ALL SELECT 'INDEX_WRONG_KEY', 'si.observations_by_ad_fk' FROM ix
   WHERE ix.indnkeyatts <> 4
      OR EXISTS (SELECT 1 FROM expected e LEFT JOIN keycols k ON k.pos = e.pos WHERE k.attname IS DISTINCT FROM e.attname)
  UNION ALL SELECT 'INDEX_WRONG_COLLATION', k.attname::text FROM keycols k WHERE k.attname IS NOT NULL AND k.coll IS DISTINCT FROM k.attcollation
  UNION ALL SELECT 'INDEX_WRONG_OPCLASS', k.attname::text FROM keycols k JOIN ix ON true
   WHERE k.attname IS NOT NULL
     AND k.opclass IS DISTINCT FROM (SELECT oc.oid FROM pg_catalog.pg_opclass oc JOIN pg_catalog.pg_am am ON am.oid = oc.opcmethod
                                      WHERE am.amname = 'btree' AND oc.opcdefault AND oc.opcintype = k.atttypid)
  UNION ALL SELECT 'INDEX_WRONG_DIRECTION', k.attname::text FROM keycols k WHERE k.attname IS NOT NULL AND k.opt <> 0
  UNION ALL SELECT 'INDEX_WRONG_DEFINITION', 'si.observations_by_ad_fk' FROM ix
   WHERE pg_catalog.pg_get_indexdef(ix.indexrelid)
         IS DISTINCT FROM 'CREATE INDEX observations_by_ad_fk ON si.observations USING btree (ad_id, source_id, network, native_ad_id)'
  UNION ALL SELECT 'INVALID_INDEX_ARTIFACT', c.relname::text
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
   WHERE c.relnamespace = 'si'::regnamespace AND c.relname <> 'observations_by_ad_fk'
     AND NOT (i.indisvalid AND i.indisready AND i.indislive))
SELECT f.code, f.object FROM failures f ORDER BY f.code, f.object;
