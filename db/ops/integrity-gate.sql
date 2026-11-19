-- B-002 M4-P3.0.1-CLOSE-01: catalog integrity gate for the evidence references the readers rely on (docs §14.9).
-- M4-P3.1-CLOSE-01 (condition C4, docs §15.9): also the 0020/0021 summary storage — its foreign keys, keys and CHECKs,
-- triggers (presence, enabled state, exact definition), the exact bodies and attributes of the security-critical
-- trigger functions, of the eligibility function and of what verification relies on, ownership and privileges, and
-- the SECURITY DEFINER contract. Definitions are pinned as SHA-256 digests: of prosrc (the body text, as written in the
-- migration; stable across dump/restore and versions) for functions, and of pg_get_constraintdef / pg_get_triggerdef
-- (PostgreSQL 16 deparse) for constraints and triggers. A migration that changes one of them must update its pin here
-- (IG-0 recomputes the function pins from the migration files; IG-1 requires a clean gate on a fresh database).
-- Not a migration; changes nothing. Run as si_owner (or any role that can read the catalog) at deployment
-- verification, in DR-1 and before re-enabling readers after any privileged operation:
--   psql -X -v ON_ERROR_STOP=1 -At -f db/ops/integrity-gate.sql
-- PASS = zero rows. Each row names one failed check. A PASS says the CONSTRAINTS and DEFINITIONS are in force now; it
-- does NOT say that rows written while they were not (dropped, NOT VALID, triggers disabled, replica mode) are
-- consistent, nor that summary rows or drift events were not changed by the (trusted) owner: for evidence run
-- db/ops/fk-audit.sql, for summaries db/ops/verify-summaries.sql (docs §15.8).
WITH expected(relname, conname, def, referenced_key) AS (VALUES
  ('observations', 'observations_ad',
   'FOREIGN KEY (ad_id, source_id, network, native_ad_id) REFERENCES si.ads(ad_id, source_id, network, native_ad_id) ON DELETE RESTRICT',
   'UNIQUE (ad_id, source_id, network, native_ad_id)'),
  ('observations', 'observations_run',
   'FOREIGN KEY (run_id, source_id, rights_version_id) REFERENCES si.collection_runs(run_id, source_id, rights_version_id)',
   'UNIQUE (run_id, source_id, rights_version_id)'),
  -- 0020
  ('run_advertiser_summaries', 'run_advertiser_summaries_run',
   'FOREIGN KEY (run_id, source_id) REFERENCES si.collection_runs(run_id, source_id)', 'UNIQUE (run_id, source_id)'),
  ('run_advertiser_summaries', 'run_advertiser_summaries_identity',
   'FOREIGN KEY (identity_id, source_id) REFERENCES si.advertiser_identities(identity_id, source_id)', 'UNIQUE (identity_id, source_id)'),
  ('run_summary_status', 'run_summary_status_run',
   'FOREIGN KEY (run_id, source_id) REFERENCES si.collection_runs(run_id, source_id)', 'UNIQUE (run_id, source_id)'),
  ('advertiser_identities', 'advertiser_identities_source_id_fkey', 'FOREIGN KEY (source_id) REFERENCES si.sources(source_id)', 'PRIMARY KEY (source_id)'),
  ('summary_events', 'summary_events_source_id_fkey', 'FOREIGN KEY (source_id) REFERENCES si.sources(source_id)', 'PRIMARY KEY (source_id)')),
fk AS (
  SELECT e.relname, e.conname, e.def, e.referenced_key, c.oid, c.contype, c.convalidated, c.conkey, c.conrelid, c.confrelid, c.conindid,
         regexp_replace(pg_get_constraintdef(c.oid), ' NOT VALID$', '') AS actual   -- validation: FK_NOT_VALIDATED
    FROM expected e
    LEFT JOIN pg_constraint c ON c.conname = e.conname AND c.conrelid = to_regclass('si.' || e.relname)),
-- 0020 keys and CHECKs (primary, unique, check), pinned by name and definition.
keys(relname, conname, sha) AS (VALUES
  ('advertiser_identities', 'advertiser_identities_advertiser_key_check', 'c70e6657b13a9a9452bfb505f61acb5ddc0ed9d34515452343cd3a46931a6674'),
  ('advertiser_identities', 'advertiser_identities_digest', '81e122562cc12ba104bfe6e4d2f553d567dee3ae81ac36b69bfc1627bdb4e351'),
  ('advertiser_identities', 'advertiser_identities_identity_id_source_id_key', '0fb6a21e8a5ae5b313c91c983b252d82b30b30fcd73f2138c3d3d37181227a3d'),
  ('advertiser_identities', 'advertiser_identities_key', 'd9e4626f5f0b274e1b2d7d74a51a2e1ec45af434d2da82e0d9ee48fbeb3aa063'),
  ('advertiser_identities', 'advertiser_identities_normalized_name_check', '135352e137115988337245f1d63d9cd7cbf56ac6f53ea1dad58a5d66d3627f03'),
  ('advertiser_identities', 'advertiser_identities_normalizer_check', '8971489828edff61b81676c416866ef06fe790f19a6b5d4e55eb3dd108b1eafb'),
  ('advertiser_identities', 'advertiser_identities_pkey', '701f954067de82294d3af515394c1d9cbd6cc7a0dd8e2f9bcb9cd348fd876194'),
  ('run_advertiser_summaries', 'run_advertiser_summaries_check', '8212e4ec707de58afb6f213a9fda093b6cd326830755de2b1e13d919ba829a0f'),
  ('run_advertiser_summaries', 'run_advertiser_summaries_names_check', '087a06500356a14e2e85456d60c3f0a343cc316639877b19abae5124c46904be'),
  ('run_advertiser_summaries', 'run_advertiser_summaries_observations_check', 'a72ed6ced3935ae34bf3b939f41e2a03997bdbc8374aad5e3fe3503e45fa8efe'),
  ('run_advertiser_summaries', 'run_advertiser_summaries_pkey', '8b2cc105d308ff39fec6895880379d4d402e6159f7af51114117ba64bb15dc7d'),
  ('run_summary_status', 'run_summary_status_content_digest_check', 'd75af8f442ceae7dafc128b83ef2f8617fd1a23bd5051ead6444bf8a7c91ed1f'),
  ('run_summary_status', 'run_summary_status_identities_check', '0de5c559dc0a2bdd27026428f47367e27972a9e480bff6c5822a5e3f59dc8d9b'),
  ('run_summary_status', 'run_summary_status_method_check', 'a8c64746c800424c296008308025341178454f06ca68e8a07e8ce2b04c568340'),
  ('run_summary_status', 'run_summary_status_normalizer_check', '8971489828edff61b81676c416866ef06fe790f19a6b5d4e55eb3dd108b1eafb'),
  ('run_summary_status', 'run_summary_status_observation_count_check', '7e331882d019b8fb1bb4c085c7ae4dd8616d5f9a2c57c15ccb3fda4063bb3e7f'),
  ('run_summary_status', 'run_summary_status_pkey', '360aa242ca7cb29e3ed1f7cfdf9a909994fcd221747b071666ad75c853c14c7f'),
  ('run_summary_status', 'run_summary_status_summary_rows_check', '4bf846ac1f7b1ea0e432998b86e12be45d479b944eb3658636782c718bc056ce'),
  ('summary_events', 'summary_events_check', 'da0176b87f50fc00cedf400c5c4f43d3ba2cedf2ff0f87206f8ab6f1cc772905'),
  ('summary_events', 'summary_events_finding_check', '92d37acc70d23cc5e8a1fec43dc4f875b28d570b6f852e9614d7e8e81906dfbb'),
  ('summary_events', 'summary_events_kind_check', 'a1abc654176caa3c5a16315d9af66208a6a3e7c8510a13b01789399bd1fa2d3a'),
  ('summary_events', 'summary_events_pkey', '1f4ed29be0083602fe11fcd0173f48645b9bffe33c848538dc9ed4ee221a417b')),
-- Immutability and lifecycle triggers: present, enabled, and exactly as created (WHEN clause, timing, deferral, function).
immutability(tgname, relname, sha) AS (VALUES
  ('trg_observations_append_only', 'observations', '4e128d70a723893d8ac290ee0ac67bc21433aa7aee257d5cc78ece1122ec33bf'),
  ('trg_observations_no_truncate', 'observations', '79dbe3697f0abee1103defb10014c092d7b5b0f7f431d1205cce36f154d79792'),
  ('trg_observation_run_completed', 'observations', '448cc5d08b335ae8f86bfc070db5e147d2d1fc10feb8eb9fc60054ea94c727aa'),
  ('trg_observation_purge_check', 'observations', 'd4b7b672eee9c49b2d212b689d42af2001bded17cb6bfb06be9c0273590ac528'),
  ('trg_ads_append_only', 'ads', 'b5dd64dd427441f8369c34db114c123f4e6f4e8cec7d98a4e9c7db4693b50523'),
  ('trg_ads_no_truncate', 'ads', '3a340e6699a3745a0cecbc3e9234d068abfee4a90b00590f86e1fde1bf70812d'),
  ('trg_ad_has_observation', 'ads', 'a1feda50d08d24a315bcf6ed5e572ab0e1a4fe6aaec276533b7e6031f1c30b6a'),
  ('trg_observation_open_run', 'observations', '33a20007a28af7a9eeec719f438fa9623abbf2e1bfa80827ffedd7b755f2eb75'),                   -- 0020
  ('trg_summaries_append_only', 'run_advertiser_summaries', '662ffc277ba5d12dc53181bbca2b23eee431a1d126bdcc42090e746e7296a0ba'),
  ('trg_summaries_no_truncate', 'run_advertiser_summaries', '8897e7a9f86934b277d433a8954fb2bdb916edb754a7fc8c6289cf42333d996f'),
  ('trg_summary_status_append_only', 'run_summary_status', '2e481afd8164dead49aab6d8a2ed9cb76d49d1bc34cc7a4546f2141f34bfc2c1'),
  ('trg_summary_status_no_truncate', 'run_summary_status', 'f4faae35522d5739812af6a8c05d8e4d3a6371aec8f26cf808bf4101a68aeabc'),
  ('trg_identities_append_only', 'advertiser_identities', '833080bde31e29e5e527539cdafd953783586278851851461992086bf4d947a9'),
  ('trg_identities_no_truncate', 'advertiser_identities', 'f7a12a04b48fb5a5a6a54d516236f2e1d1658be8ca72614922baec0f78c1b2ae'),
  ('trg_summary_events_append_only', 'summary_events', '7dba6a962453dafc0dd7826ea7334561c6b3125dc8d3eb76bf220b6ece1afcf9'),
  ('trg_summary_events_no_truncate', 'summary_events', '065453bc510cd3b9cad6d6872bce46358d626f4d215150928e8a826c3edd6f41'),
  ('trg_runs_summary_check', 'collection_runs', 'd50cd0b75b4eb946de32b77584ea4c4d2ca3a5a0ea1d4adec0bdb1c0a6c65906'),
  ('trg_runs_purge_summaries', 'collection_runs', '1ded5ed27f3ee08e0abd2ffe5306482ee2b130750087889663eb5d98a302929d'),
  -- 0024: verification records are append-only; the sweep state machine
  ('trg_drift_clearances_append_only', 'summary_drift_clearances', '0714e616e5fd698d6fa6ac75430f43ffebe5379b7dc7bb8a301d63f7d3168126'),
  ('trg_drift_clearances_no_truncate', 'summary_drift_clearances', 'c2f2c7deb0c965a7155cc8791f6f712c1ff5f3643e3a8afa932ccffe8fbcf55e'),
  ('trg_summary_sweep_transition', 'summary_sweeps', '035820378a6db94d3f80d2a947204ba82c4419b6b0cf3b316ae773dc3eb96692'),
  ('trg_sweep_batches_append_only', 'summary_sweep_batches', '53f0ae3ff6978523b526e433e1ebd45d1e88f35f737dd7f0ea1b4ebf29f41ec0'),
  ('trg_sweep_batches_no_truncate', 'summary_sweep_batches', '839d8b2d1b1ecb19899453257ffb22cd5710fc49af9169c2baecab67d293dd76'),
  ('trg_sweep_failures_append_only', 'summary_sweep_failures', '81fa96b6e2a5cc49c1d551db2245d028a2718e37166213aaae3c8bb6896cd6fb'),
  ('trg_sweep_failures_no_truncate', 'summary_sweep_failures', 'f3e8a3d7aec6532a494048f24817efa786700146ee5670971117233527393ff3'),
  ('trg_sweep_identities_append_only', 'summary_sweep_identities', '76e8a11c8dfdd2ab9e37b25dabb1a0ae442e5d41e6ee832aac163c440da2fbd6'),
  ('trg_sweep_identities_no_truncate', 'summary_sweep_identities', '5ceda0cd80d126d91eb44ae59de6b818ce6a936726365bbf624c36212285eae5'),
  ('trg_sweep_runs_append_only', 'summary_sweep_runs', 'cc94467ea5e5cb0f3940b33f9b0f1ae488357ddedf4dfeef14c88d94472955d0'),
  ('trg_sweep_runs_no_truncate', 'summary_sweep_runs', 'c40eb06c4c6bd5d98ae1a68163b702c56cc50871a788f4938b52704a72b6748c'),
  ('trg_sweeps_no_truncate', 'summary_sweeps', '9168a1f2478bcc085d8eb0b670a8dc4233ae117bea9b263e65d8e5543b27f62e'),
  ('trg_control_timings_append_only', 'source_control_timings', '8377595ae56fb2860286653a6d5fa7d7b52605a94445ae65a2ea31cbfde9c9b6'),   -- 0026
  ('trg_control_timings_no_truncate', 'source_control_timings', '1dad624ce1e1ae4f48272f461dcfe8f737044039eb3689096b432b69323443db'),
  ('trg_read_failures_append_only', 'read_failures', '679c695ae144f094f0cffcc907e1cbe6f94a710f3cfaa199f05ea2265194effb'),
  ('trg_read_failures_no_truncate', 'read_failures', 'aa25c120600e37e7f2197a9c1986abf8fb438839318a42c6b5566e0e7a3d4bae'),
  ('trg_read_path_events_append_only', 'read_path_events', '5db3fb6108864810730d26733c49fb9777e9319ba878ef0b30054d4cff609a7c'),
  ('trg_read_path_events_no_truncate', 'read_path_events', 'f5a125884677b92265cb53a94c3a391cf79fc977c27b672ed9b714c1ca75d933'),
  ('trg_control_failures_append_only', 'source_control_failures', '385dae63e1164138616da59f2117181c83b9934ac417e366d73270445ec056cf'),
  ('trg_control_failures_no_truncate', 'source_control_failures', '922344d72c19dc233ab5e655b25619ea3840811ff182566ae4d0aef526bc7248'),
  ('trg_source_control_timing', 'source_controls', '7913d4fcd9511164fe980517278312c48fe69eac822b0d639879c803eb1c9535')),
-- Exact bodies (SHA-256 of prosrc) and attributes of the security-critical functions: every immutability/lifecycle
-- trigger function, the eligibility function and everything it and verification evaluate. Owner-only (no grant).
functions(fn, sha, secdef, volatility, config) AS (VALUES
  ('si.trg_evidence_append_only()', '1edb9ac019c78505dcfacf031543705909abbb8d52db48b615d84f89752732c5', false, 'v', 'search_path=pg_catalog, pg_temp'),
  ('si.trg_observation_run_completed()', '2018c77c1daff476fbbade1d89a972eb73cf2da608266f1e41e7961339ef6914', true, 'v', 'search_path=pg_catalog, pg_temp'),
  ('si.trg_observation_purge_check()', '35221fd76a57663e34a9a865ed978a40496a95a502b0bf3e2c4c1dba26179d6f', true, 'v', 'search_path=pg_catalog, pg_temp'),
  ('si.trg_ad_has_observation()', 'f80a9cfab732f17779e26820c87b2f162ce7b3da5fd9118eb51217d4174f4eb7', true, 'v', 'search_path=pg_catalog, pg_temp'),
  ('si.trg_observation_open_run()', '43012a46b3775d0b65d3aa93c6d35d2c8711b4647afa8edc7f2a20b0f6e27385', true, 'v', 'search_path=pg_catalog, pg_temp'),
  ('si.trg_summary_guard()', '9e14b254d1863b9bb6d07eacd928b2a5df9c6ed577395f5f114a611f3edae022', false, 'v', 'search_path=pg_catalog, pg_temp'),
  ('si.trg_runs_summary_check()', 'ed6fa376fe49a09677c2b857fa2070f9574821555486ddbdec0d3efcac8e6ae2', true, 'v', 'search_path=pg_catalog, pg_temp'),
  ('si.trg_runs_purge_summaries()', '80f283c757820f62717398f9fdedaf4481bf5526cbabe919c413d468e93a6136', true, 'v', 'search_path=pg_catalog, pg_temp'),
  ('si.si_summary_coverage(text)', '0a86caf504869d5eeb4ad7351328bdf1f241227e947dd7301e54a78f0bbd114f', false, 's',
   'search_path=pg_catalog, pg_temp;enable_hashjoin=off;enable_nestloop=off;enable_sort=off'),                                          -- 0021
  ('si.si_summary_drift_open(text)', '247cf7e4cc1be0b5be8a0a109c8d87a13c503127ca6e7612a031b681035c7473', false, 's', 'search_path=pg_catalog, pg_temp'),
  ('si.si_normalizer_fingerprint()', 'd80912d37b80b501729c99117493cfd6c7a3b63f92de2e64773f963eacf30ec5', false, 's', 'search_path=pg_catalog, pg_temp'),
  ('si.si_verify_summaries(text)', 'bbc8646946925ccc64b0c5ddccbea64613a3720642091b09e6854073591a0449', false, 'v', 'search_path=pg_catalog, pg_temp'),  -- 0025
  ('si.si_summary_content(uuid)', 'c29b9fedffaab13c00e8fccdab61a2e87d553e755ef6237e2a4ee407e8a4f262', false, 's', 'search_path=pg_catalog, pg_temp'),
  ('si.si_summary_stored(uuid)', 'e78650cd7781dbf418186968abe2c55b1a8b983259872e119d401f4ae83e80bd', false, 's', 'search_path=pg_catalog, pg_temp'),
  ('si.si_summary_digest(bytea[],text[],integer[],text[],text[])', 'b87304c62f00fca03f90de8911f10cf8ce28a95ee030e5bb2b404845cc66aea6', false, 'i', 'search_path=pg_catalog, pg_temp'),
  ('si.si_rebuild_run_summaries(uuid)', 'd12ac437a39183bf35d56edc718a1288da8d81cf66ac4f3b07f3c90e213e5690', false, 'v', 'search_path=pg_catalog, pg_temp'),
  -- 0024 (owner-only): the per-run verification, the state machine, the append-only guard and the drift clearance
  ('si.si_summary_clear_drift(text,bigint)', 'b4c3601ea8c49b86af1544e8eb17b08b3682c5cb8e9c3bef343ff2e640b7f228', false, 'v', 'search_path=pg_catalog, pg_temp'),  -- 0025
  ('si.si_sweep_verify_run(uuid,text,integer)', 'b8c9f5150281f04269528a0c7dfb6c6a63b0c6358fc214e08945aa9cc4c8b49a', false, 'v', 'search_path=pg_catalog, pg_temp'),
  ('si.trg_summary_sweep_transition()', '34db09c595569823f306efae89442c03e9737623f43cbab3c65e27ac600d8f5d', false, 'v', 'search_path=pg_catalog, pg_temp'),
  ('si.trg_sweep_records_append_only()', 'b882ecd81310163e794ff5a9f87302c2eb906b96f283bfee530d9e50811dc241', false, 'v', 'search_path=pg_catalog, pg_temp'),
  ('si.si_record_read_path(text,text,text,uuid,text,text,timestamp with time zone)', '5fd3ea9013c9892ef0505b04d828578e89e86f420c608c876a582415d71861a2', false, 'v', 'search_path=pg_catalog, pg_temp'),  -- 0026
  ('si.trg_source_control_timing()', '21c1b7630552ddce13fc76bd20cc69057374523cf626149d889c56250a587ea8', true, 'v', 'search_path=pg_catalog, pg_temp'),
  ('si.trg_telemetry_append_only()', '7ff1fb4550f76b09ee452685b16fad4457c61abed8666ac764846f6f0335978a', false, 'v', 'search_path=pg_catalog, pg_temp')),
fn AS (
  SELECT f.*, p.oid, p.prosecdef, p.provolatile::text AS provolatile, array_to_string(p.proconfig, ';') AS proconfig,
         encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS actual_sha, pg_get_userbyid(p.proowner) AS owner,
         coalesce(p.proacl, acldefault('f', p.proowner))::text AS acl                 -- effective ACL (NULL = the default)
    FROM functions f
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.fn)),
-- Ownership and exact EFFECTIVE privileges of the evidence and summary tables (pg_dump/pg_restore leaves relacl NULL
-- when it equals the owner default; NULL is compared as acldefault(), which is what PostgreSQL enforces).
tables(relname, acl) AS (VALUES
  ('observations', '{si_owner=arwdDxt/si_owner}'), ('ads', '{si_owner=arwdDxt/si_owner}'),
  ('collection_runs', '{si_owner=arwdDxt/si_owner,si_collector=r/si_owner,si_rights_admin=r/si_owner,si_retention=r/si_owner}'),
  ('advertiser_identities', '{si_owner=arwdDxt/si_owner}'), ('run_advertiser_summaries', '{si_owner=arwdDxt/si_owner}'),
  ('run_summary_status', '{si_owner=arwdDxt/si_owner}'), ('summary_events', '{si_owner=arwdDxt/si_owner}'),
  ('summary_sweeps', '{si_owner=arwdDxt/si_owner}'), ('summary_sweep_batches', '{si_owner=arwdDxt/si_owner}'),            -- 0024
  ('summary_sweep_runs', '{si_owner=arwdDxt/si_owner}'), ('summary_sweep_identities', '{si_owner=arwdDxt/si_owner}'),
  ('summary_sweep_failures', '{si_owner=arwdDxt/si_owner}'), ('summary_drift_clearances', '{si_owner=arwdDxt/si_owner}'),
  ('read_path_events', '{si_owner=arwdDxt/si_owner}'), ('read_failures', '{si_owner=arwdDxt/si_owner}'),                  -- 0026
  ('source_control_timings', '{si_owner=arwdDxt/si_owner}'), ('source_control_failures', '{si_owner=arwdDxt/si_owner}'))
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
  FROM fk JOIN pg_attribute a ON a.attrelid = fk.conrelid AND a.attnum = ANY (fk.conkey)
 WHERE fk.oid IS NOT NULL AND NOT a.attnotnull
UNION ALL
SELECT 'FK_REFERENCED_KEY', fk.conname
  FROM fk WHERE fk.oid IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM pg_constraint u JOIN pg_index i ON i.indexrelid = u.conindid
                    WHERE u.conrelid = fk.confrelid AND u.contype IN ('u', 'p') AND u.conindid = fk.conindid
                      AND pg_get_constraintdef(u.oid) = fk.referenced_key AND i.indisvalid AND i.indisunique)
UNION ALL
SELECT 'KEY_MISSING', k.conname FROM keys k
 WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('si.' || k.relname) AND c.conname = k.conname)
UNION ALL
SELECT 'KEY_DEFINITION', k.conname FROM keys k JOIN pg_constraint c ON c.conrelid = to_regclass('si.' || k.relname) AND c.conname = k.conname
 WHERE encode(sha256(convert_to(regexp_replace(pg_get_constraintdef(c.oid), ' NOT VALID$', ''), 'UTF8')), 'hex') <> k.sha   -- validation: KEY_NOT_VALIDATED
UNION ALL
SELECT 'KEY_NOT_VALIDATED', k.conname FROM keys k JOIN pg_constraint c ON c.conrelid = to_regclass('si.' || k.relname) AND c.conname = k.conname
 WHERE NOT c.convalidated
UNION ALL
SELECT 'KEY_INDEX', k.conname FROM keys k JOIN pg_constraint c ON c.conrelid = to_regclass('si.' || k.relname) AND c.conname = k.conname
 WHERE c.contype IN ('p', 'u') AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = c.conindid AND i.indisvalid AND i.indisunique AND i.indisready)
UNION ALL
SELECT 'IMMUTABILITY_TRIGGER', m.tgname
  FROM immutability m
 WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('si.' || m.relname) AND t.tgname = m.tgname
                     AND t.tgenabled IN ('O', 'A'))
UNION ALL
SELECT 'TRIGGER_DEFINITION', m.tgname
  FROM immutability m JOIN pg_trigger t ON t.tgrelid = to_regclass('si.' || m.relname) AND t.tgname = m.tgname
 WHERE encode(sha256(convert_to(pg_get_triggerdef(t.oid), 'UTF8')), 'hex') <> m.sha
UNION ALL
SELECT 'FUNCTION_MISSING', f.fn FROM fn f WHERE f.oid IS NULL
UNION ALL
SELECT 'FUNCTION_DEFINITION', f.fn FROM fn f
 WHERE f.oid IS NOT NULL AND (f.actual_sha <> f.sha OR f.prosecdef <> f.secdef OR f.provolatile <> f.volatility
                              OR f.proconfig IS DISTINCT FROM f.config)
UNION ALL
SELECT 'FUNCTION_PRIVILEGES', f.fn || ': owner ' || f.owner || ', acl ' || f.acl FROM fn f
 WHERE f.oid IS NOT NULL AND (f.owner <> 'si_owner' OR f.acl IS DISTINCT FROM '{si_owner=X/si_owner}')
UNION ALL
SELECT 'TABLE_MISSING', t.relname FROM tables t WHERE to_regclass('si.' || t.relname) IS NULL
UNION ALL
SELECT 'TABLE_PRIVILEGES', t.relname || ': owner ' || pg_get_userbyid(c.relowner) || ', acl ' || coalesce(c.relacl, acldefault('r', c.relowner))::text
  FROM tables t JOIN pg_class c ON c.oid = to_regclass('si.' || t.relname)
 WHERE pg_get_userbyid(c.relowner) <> 'si_owner'
    OR coalesce(c.relacl, acldefault('r', c.relowner))::text IS DISTINCT FROM t.acl   -- effective ACL: a restore leaves NULL for owner-only
UNION ALL
SELECT 'SECDEF_OWNER', p.oid::regprocedure::text || ': ' || pg_get_userbyid(p.proowner)
  FROM pg_proc p WHERE p.pronamespace = 'si'::regnamespace AND p.prosecdef AND pg_get_userbyid(p.proowner) <> 'si_owner'
UNION ALL
SELECT 'SECDEF_SEARCH_PATH', p.oid::regprocedure::text
  FROM pg_proc p WHERE p.pronamespace = 'si'::regnamespace AND p.prosecdef
   AND NOT ('search_path=pg_catalog, pg_temp' = ANY (coalesce(p.proconfig, '{}')))
UNION ALL
SELECT 'PUBLIC_EXECUTE', p.oid::regprocedure::text
  FROM pg_proc p WHERE p.pronamespace = 'si'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE')
UNION ALL
SELECT 'REPLICA_DEFAULT', coalesce(d.datname, '*') || '/' || coalesce(r.rolname, '*')
  FROM pg_db_role_setting s
  LEFT JOIN pg_database d ON d.oid = s.setdatabase
  LEFT JOIN pg_roles r ON r.oid = s.setrole
 WHERE EXISTS (SELECT 1 FROM unnest(s.setconfig) c WHERE c ILIKE 'session_replication_role=%' AND c NOT ILIKE '%=origin')
ORDER BY 1, 2;
