# D5b production-hardening decision A — operator and engineering contract

**Founder decision (2026-10-26): A, mandatory and fail-closed.**
**State: design policy approved; implementation in acceptance CI, not production-approved.**
**No production deployment, no Step 3, no content serving (D8).**

## Security contract

D5b is database-local: PostgreSQL advisory-lock EXECUTE privileges must be
revoked from PUBLIC and all effective application roles in **every** Shop
Intelligence production database. Only the approved two-int transaction-lock
capability for `si_owner` and bigint transaction-lock capability for
`si_migrator` are granted by the hardening script. Superusers remain outside
this restriction.

D7 operational settings and D5b effective grants must both pass for the
specific connected database. The reusable entry-point contract is
`assertProductionReady(client)` in
`src/persistence/production-readiness.ts`. It throws on failed checks,
database errors, or malformed results. It does not repair grants.

Existing operator CLI calls the gate when `SI_PRODUCTION=1`. An explicit
`preflight --production` always calls it, even if the environment flag is
absent. **The CLI environment flag is not itself a trusted production
configuration system**: without a trusted deploy-time assertion that all
production processes set it, an operator could omit it. There is currently
no production API/worker/collector startup to enforce. Do not claim
end-to-end startup enforcement from these CLI tests.

## Host selection — mandatory prerequisites

1. PostgreSQL 16 with D7 settings: prepared transactions disabled, commit
   timestamps on, no synchronous standby names, READ COMMITTED default.
2. A privileged provisioning operator that actually owns the relevant
   `pg_catalog` functions and can change their database-local ACLs.
   A managed provider that refuses this is **incompatible**, not
   best-effort compatible.
3. Restricted production roles, dedicated migration privileges, a documented
   credential/secrets manager, and auditable provisioning access.
4. Deployment orchestrator with trusted immutable production configuration
   and a mandatory readiness/startup step for **every** process that can
   start a collection, mutate source rights, perform retention, or serve
   content. Any failed or skipped gate must prevent process startup.
5. An incident/restore procedure that reruns D5b and D7 against each
   restored database, including new databases created from template0.

## Planned provisioning sequence — NOT authorized to execute on production

1. Choose and document compatible hosting. Verify catalog-function ownership
   on an isolated disposable replica/test database first.
2. Back up roles, schema, data and ACLs. Confirm restore procedure (DR-1
   proved one disposable independent PostgreSQL 16.15 recovery).
3. During an isolated maintenance/provisioning phase, run
   `db/bootstrap/optional/advisory-lock-hardening.sql` using the actual
   function owner in **each** database. Script is transactional and verifies
   no PUBLIC/effective application-role advisory access remains.
4. Run `node dist/persistence/cli.js preflight --production` with the
   intended database credentials and require exit 0. Capture sanitized
   results; never log secrets or dump contents.
5. Add trusted deployment startup enforcement and negative tests **before**
   any production API/worker/collector is introduced. Refuse startup if
   credentials/DB unavailable, D7/D5b fail, or preflight was skipped.
6. Keep D8's no-serving prohibition in force until separately resolved and
   independently tested.

## Failure response and rollback

- A failed or unverifiable hardening step means **do not start** any production
  process. Do not bypass the preflight or add PUBLIC EXECUTE grants.
- If the host cannot meet the contract, switch to a compatible host or
  formally design and verify a different isolation mechanism under a new
  decision; never silently weaken D5b.
- If a deployment or recovery changes database-local grants, recheck all
  databases before allowing startup. Rollback means restoring a previously
  verified hardened state from a controlled backup, not re-enabling PUBLIC.
- Audit future grants and role memberships because they can re-expose access.

## Verification and outstanding release gates

The test suite exercises a hardened disposable database (positive), an
unhardened database (negative), and error paths. DR-1 CI #78 previously
demonstrated a disposable clean-cluster restore. The new D5b implementation
requires its own final-commit CI adjudication before being called verified.

**Still open:** named production hosting capability; actual startup
orchestrator and trusted flag enforcement; future service entry-point
negative tests; final Step 2 acceptance; D8. **No deploy.**
