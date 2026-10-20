-- B-002 migration 0001: sources, versioned rights, evidence.
-- Spec: B-002 design revision 2.1 + Amendment A + Amendment B + IA-1 (frozen 2026-10-20).
-- Runs as si_owner with search_path = pg_catalog, pg_temp (set by the runner), so
-- every object below is schema-qualified.
--
-- Deferred to later migrations because they depend on tables that do not exist yet:
--   trg_rights_revocation, trg_deletion_source_guard          -> 0004 (deletion_requests)
--   si_read_observations, si_resolve_identities, etc.         -> 0003/0004
--   IA-1 composite foreign key on collection_runs             -> 0002 (the unique key it needs is created here)

------------------------------------------------------------------------------------------
-- sources
------------------------------------------------------------------------------------------
CREATE TABLE si.sources (
  source_id          text PRIMARY KEY CHECK (source_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name       text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  evidence_kind      text NOT NULL CHECK (evidence_kind IN ('SYNTHETIC')),            -- B-002 guard: synthetic only
  supported_networks text[] NOT NULL CHECK (
                       cardinality(supported_networks) > 0
                       AND array_ndims(supported_networks) = 1
                       AND array_position(supported_networks, NULL) IS NULL      -- no NULL elements
                       AND supported_networks <@ ARRAY['META','TIKTOK','GOOGLE','PINTEREST','OTHER']::text[]),
  conflict_policy    text NOT NULL DEFAULT 'FAIL_RUN' CHECK (conflict_policy IN ('FAIL_RUN','KEEP_FIRST')),
  created_by         text NOT NULL DEFAULT session_user,                          -- A4.6 attribution
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at         timestamptz
);

-- Amendment B3.3: retirement is final once it has passed; a future retirement may move.
CREATE FUNCTION si.trg_sources_retire_final() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL AND OLD.retired_at <= clock_timestamp()
     AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'SI_RETIREMENT_FINAL: source % retired at %; retirement cannot be changed', OLD.source_id, OLD.retired_at
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_sources_retire_final BEFORE UPDATE OF retired_at ON si.sources
  FOR EACH ROW EXECUTE FUNCTION si.trg_sources_retire_final();

------------------------------------------------------------------------------------------
-- rights_versions (append-only, dense versions, no backdating)
------------------------------------------------------------------------------------------
CREATE TABLE si.rights_versions (
  rights_version_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id          text NOT NULL REFERENCES si.sources (source_id),
  version            int  NOT NULL CHECK (version >= 1),                -- assigned by trg_rights_insert
  evaluation         text NOT NULL CHECK (evaluation IN ('ALLOWED','DENIED','UNKNOWN')),
  retain             text NOT NULL CHECK (retain     IN ('ALLOWED','DENIED','UNKNOWN')),
  subscriber_display text NOT NULL CHECK (subscriber_display IN ('DENIED','UNKNOWN')),   -- B-002 guard
  media_mirror       text NOT NULL CHECK (media_mirror       IN ('DENIED','UNKNOWN')),   -- B-002 guard
  export             text NOT NULL CHECK (export             IN ('DENIED','UNKNOWN')),   -- B-002 guard
  retention_days     int  CHECK (retention_days BETWEEN 1 AND 3650),
  cleanup_within     interval NOT NULL DEFAULT interval '1 hour'       -- Amendment: cleanup TARGET, never a permission grace
                       CHECK (cleanup_within >= interval '0' AND cleanup_within <= interval '1 hour'),
  basis              text NOT NULL CHECK (length(btrim(basis)) BETWEEN 1 AND 2000),
  change_reason      text NOT NULL CHECK (length(btrim(change_reason)) > 0),
  effective_from     timestamptz NOT NULL,                             -- set/validated by trg_rights_insert
  expires_at         timestamptz,
  recorded_by        text NOT NULL DEFAULT session_user,
  recorded_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_id, version),
  UNIQUE (rights_version_id, source_id),                               -- IA-1: target of composite FKs from 0002 on
  CHECK (expires_at IS NULL OR expires_at > effective_from),
  CHECK (retain <> 'ALLOWED' OR retention_days IS NOT NULL)
);

-- 2.1 trg_rights_insert: lock the source row, then read the clock; dense versions;
-- effective_from never in the past and never earlier than the previous version's.
-- Attribution is overwritten from session_user so a caller cannot forge it.
CREATE FUNCTION si.trg_rights_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prev_version int;
  prev_effective timestamptz;
  now_ts timestamptz;
BEGIN
  PERFORM 1 FROM si.sources s WHERE s.source_id = NEW.source_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SI_UNKNOWN_SOURCE: %', NEW.source_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- New statement after the lock: under READ COMMITTED it sees versions committed by
  -- any transaction that held the lock before us.
  SELECT v.version, v.effective_from INTO prev_version, prev_effective
    FROM si.rights_versions v WHERE v.source_id = NEW.source_id
    ORDER BY v.version DESC LIMIT 1;
  IF NEW.version IS NULL THEN
    NEW.version := coalesce(prev_version, 0) + 1;
  ELSIF NEW.version <> coalesce(prev_version, 0) + 1 THEN
    RAISE EXCEPTION 'SI_VERSION_SEQUENCE: next version for % must be %, got %', NEW.source_id, coalesce(prev_version, 0) + 1, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  now_ts := clock_timestamp();                          -- read AFTER acquiring the source lock
  NEW.effective_from := coalesce(NEW.effective_from, now_ts);
  IF NEW.effective_from < now_ts THEN
    RAISE EXCEPTION 'SI_BACKDATED_EFFECTIVE_FROM: effective_from % is before now (%)', NEW.effective_from, now_ts
      USING ERRCODE = 'check_violation';
  END IF;
  IF prev_effective IS NOT NULL AND NEW.effective_from < prev_effective THEN
    RAISE EXCEPTION 'SI_EFFECTIVE_FROM_ORDER: effective_from % is before version %''s %', NEW.effective_from, prev_version, prev_effective
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.recorded_by := session_user;
  NEW.recorded_at := now_ts;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_rights_insert BEFORE INSERT ON si.rights_versions
  FOR EACH ROW EXECUTE FUNCTION si.trg_rights_insert();

-- Shared append-only guard (2.1 change 17: also blocks TRUNCATE).
CREATE FUNCTION si.trg_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'SI_APPEND_ONLY: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER trg_rights_append_only BEFORE UPDATE OR DELETE ON si.rights_versions
  FOR EACH ROW EXECUTE FUNCTION si.trg_append_only();
CREATE TRIGGER trg_rights_append_only_truncate BEFORE TRUNCATE ON si.rights_versions
  FOR EACH STATEMENT EXECUTE FUNCTION si.trg_append_only();

------------------------------------------------------------------------------------------
-- rights_evidence (append-only)
------------------------------------------------------------------------------------------
CREATE TABLE si.rights_evidence (
  evidence_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rights_version_id  bigint NOT NULL REFERENCES si.rights_versions (rights_version_id),
  kind               text NOT NULL CHECK (kind IN ('SYNTHETIC_DECLARATION','AGREEMENT',
                       'TERMS_SNAPSHOT','CORRESPONDENCE','INTERNAL_NOTE')),
  reference          text NOT NULL CHECK (length(reference) BETWEEN 1 AND 500),   -- document-store id, never fetched
  content_sha256     text CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  description        text CHECK (length(description) <= 1000),
  recorded_by        text NOT NULL DEFAULT session_user,
  recorded_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX rights_evidence_by_version ON si.rights_evidence (rights_version_id);

CREATE FUNCTION si.trg_evidence_attribution() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.recorded_by := session_user;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_evidence_attribution BEFORE INSERT ON si.rights_evidence
  FOR EACH ROW EXECUTE FUNCTION si.trg_evidence_attribution();
CREATE TRIGGER trg_evidence_append_only BEFORE UPDATE OR DELETE ON si.rights_evidence
  FOR EACH ROW EXECUTE FUNCTION si.trg_append_only();
CREATE TRIGGER trg_evidence_append_only_truncate BEFORE TRUNCATE ON si.rights_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION si.trg_append_only();

-- 2.1 trg_rights_evidence_required: checked at COMMIT. Any ALLOWED needs evidence;
-- a SYNTHETIC source needs at least one SYNTHETIC_DECLARATION.
CREATE FUNCTION si.trg_rights_evidence_required() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE kind_of_source text;
BEGIN
  IF 'ALLOWED' IN (NEW.evaluation, NEW.retain, NEW.subscriber_display, NEW.media_mirror, NEW.export) THEN
    IF NOT EXISTS (SELECT 1 FROM si.rights_evidence e WHERE e.rights_version_id = NEW.rights_version_id) THEN
      RAISE EXCEPTION 'SI_EVIDENCE_REQUIRED: rights version % (source %) allows use but cites no evidence',
        NEW.version, NEW.source_id USING ERRCODE = 'check_violation';
    END IF;
    SELECT s.evidence_kind INTO kind_of_source FROM si.sources s WHERE s.source_id = NEW.source_id;
    IF kind_of_source = 'SYNTHETIC' AND NOT EXISTS (
         SELECT 1 FROM si.rights_evidence e
         WHERE e.rights_version_id = NEW.rights_version_id AND e.kind = 'SYNTHETIC_DECLARATION') THEN
      RAISE EXCEPTION 'SI_SYNTHETIC_DECLARATION_REQUIRED: synthetic source % needs a SYNTHETIC_DECLARATION', NEW.source_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_rights_evidence_required AFTER INSERT ON si.rights_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION si.trg_rights_evidence_required();

------------------------------------------------------------------------------------------
-- Rights validity functions (SECURITY INVOKER)
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_publish_margin() RETURNS interval
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $$ SELECT interval '60 seconds' $$;

-- End of a version's validity window: the earlier of its expires_at and the next
-- version's effective_from (including a scheduled one). 'infinity' if neither; NULL
-- for an unknown version (callers then fail closed).
CREATE FUNCTION si.si_window_end(p_version bigint) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT least(
           coalesce(v.expires_at, 'infinity'::timestamptz),
           coalesce((SELECT n.effective_from FROM si.rights_versions n
                      WHERE n.source_id = v.source_id AND n.version = v.version + 1),
                    'infinity'::timestamptz))
  FROM si.rights_versions v
  WHERE v.rights_version_id = p_version
$$;

-- 2.1 section A: pure in p_at (the caller passes clock_timestamp()), strict margin.
CREATE FUNCTION si.rights_valid_for_publish(p_version bigint, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((
    SELECT v.effective_from <= p_at
       AND p_at + si.si_publish_margin() < si.si_window_end(v.rights_version_id)
       AND v.evaluation = 'ALLOWED'
       AND v.retain = 'ALLOWED'
       AND (s.retired_at IS NULL OR p_at < s.retired_at)
    FROM si.rights_versions v
    JOIN si.sources s ON s.source_id = v.source_id
    WHERE v.rights_version_id = p_version), false)
$$;

-- Amendment B: end of the retention lifetime of data collected under version
-- p_collected_version of p_source_id, from rights events alone. NULL = no end yet.
CREATE FUNCTION si.si_retention_end(p_source_id text, p_collected_version int)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT min(e.x)
  FROM (
      -- retain revocation by version n: ends data collected under versions < n
      SELECT v.effective_from AS x, v.version AS n, v.version - 1 AS k
      FROM si.rights_versions v
      WHERE v.source_id = p_source_id AND v.retain <> 'ALLOWED'
    UNION ALL
      -- expiry of allow-version n: ends data collected under versions <= n
      SELECT v.expires_at, v.version, v.version
      FROM si.rights_versions v
      WHERE v.source_id = p_source_id AND v.retain = 'ALLOWED' AND v.expires_at IS NOT NULL
  ) e
  WHERE e.k >= p_collected_version
    AND NOT EXISTS (                                   -- took effect (same test as A3)
          SELECT 1 FROM si.rights_versions m
          WHERE m.source_id = p_source_id AND m.version > e.n AND m.effective_from <= e.x)
$$;

------------------------------------------------------------------------------------------
-- Amendment A4: the only write path for rights (SECURITY DEFINER contract)
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_record_rights_version(
  p_source_id            text,
  p_evaluation           text,
  p_retain               text,
  p_subscriber_display   text,
  p_media_mirror         text,
  p_export               text,
  p_retention_days       int,
  p_cleanup_within       interval,
  p_basis                text,
  p_change_reason        text,
  p_effective_from       timestamptz,
  p_expires_at           timestamptz,
  p_evidence_kinds       text[],
  p_evidence_refs        text[],
  p_evidence_sha256      text[],
  p_evidence_descriptions text[]
)
RETURNS TABLE (rights_version_id bigint, version int, effective_from timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  n int := coalesce(cardinality(p_evidence_kinds), 0);
  rv si.rights_versions%ROWTYPE;
BEGIN
  -- Argument validation (column CHECKs validate values; this validates shape).
  IF coalesce(cardinality(p_evidence_refs), 0) <> n
     OR (p_evidence_sha256 IS NOT NULL AND cardinality(p_evidence_sha256) <> n)
     OR (p_evidence_descriptions IS NOT NULL AND cardinality(p_evidence_descriptions) <> n) THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: evidence arrays must have equal length' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_evidence_kinds IS NOT NULL AND array_ndims(p_evidence_kinds) > 1)
     OR (p_evidence_refs IS NOT NULL AND array_ndims(p_evidence_refs) > 1) THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: evidence arrays must be one-dimensional' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO si.rights_versions (source_id, evaluation, retain, subscriber_display, media_mirror, export,
                                  retention_days, cleanup_within, basis, change_reason, effective_from, expires_at)
  VALUES (p_source_id, p_evaluation, p_retain, p_subscriber_display, p_media_mirror, p_export,
          p_retention_days, coalesce(p_cleanup_within, interval '1 hour'), p_basis, p_change_reason,
          p_effective_from, p_expires_at)
  RETURNING * INTO rv;

  FOR i IN 1..n LOOP
    INSERT INTO si.rights_evidence (rights_version_id, kind, reference, content_sha256, description)
    VALUES (rv.rights_version_id, p_evidence_kinds[i], p_evidence_refs[i], p_evidence_sha256[i], p_evidence_descriptions[i]);
  END LOOP;

  rights_version_id := rv.rights_version_id;
  version := rv.version;
  effective_from := rv.effective_from;
  RETURN NEXT;
END $$;

------------------------------------------------------------------------------------------
-- Privileges (Amendment A4 + 2.1 roles table). Nothing is granted to PUBLIC.
------------------------------------------------------------------------------------------
REVOKE ALL ON si.sources, si.rights_versions, si.rights_evidence FROM PUBLIC;
GRANT SELECT ON si.sources, si.rights_versions, si.rights_evidence TO si_collector, si_rights_admin, si_retention;
GRANT UPDATE (retired_at, conflict_policy) ON si.sources TO si_rights_admin;
-- No INSERT on rights tables for any role: rights are written only through si_record_rights_version().

REVOKE ALL ON FUNCTION
  si.trg_sources_retire_final(), si.trg_rights_insert(), si.trg_append_only(), si.trg_evidence_attribution(),
  si.trg_rights_evidence_required(), si.si_publish_margin(), si.si_window_end(bigint),
  si.rights_valid_for_publish(bigint, timestamptz), si.si_retention_end(text, int),
  si.si_record_rights_version(text, text, text, text, text, text, int, interval, text, text,
                              timestamptz, timestamptz, text[], text[], text[], text[])
FROM PUBLIC;
-- rights_valid_for_publish is SECURITY INVOKER and calls the two helpers, so the
-- collector needs EXECUTE on all three.
GRANT EXECUTE ON FUNCTION si.rights_valid_for_publish(bigint, timestamptz), si.si_window_end(bigint),
  si.si_publish_margin() TO si_collector;
GRANT EXECUTE ON FUNCTION si.si_record_rights_version(text, text, text, text, text, text, int, interval, text, text,
  timestamptz, timestamptz, text[], text[], text[], text[]) TO si_rights_admin;

------------------------------------------------------------------------------------------
-- Seed: one fictional synthetic source (frozen decision 4: 30-day retention).
------------------------------------------------------------------------------------------
INSERT INTO si.sources (source_id, display_name, evidence_kind, supported_networks)
VALUES ('synthetic-fixture', 'Synthetic fixture (fictional, author-created)', 'SYNTHETIC', ARRAY['META','TIKTOK']);

SELECT * FROM si.si_record_rights_version(
  'synthetic-fixture',
  'ALLOWED', 'ALLOWED', 'DENIED', 'DENIED', 'DENIED',
  30, interval '1 hour',
  'Author-created fictional sample data for offline evaluation and tests only. No third-party content and no third-party rights are involved.',
  'Initial B-002 seed (migration 0001)',
  NULL, NULL,
  ARRAY['SYNTHETIC_DECLARATION'],
  ARRAY['repo:fixtures/synthetic-ads.json'],
  NULL,
  ARRAY['Every fixture row is invented by the project author; all URLs use example.org and are never fetched.']
);
