# ADR-0007: Migrate attendance piece by piece behind its existing tests; Genie starts on the kit

- Status: Accepted (2026-10-13)
- Date: 2026-10-13

## Context

Attendance is in production on Unraid. Its `/data` holds:

- `app.db`, with v1 vault blobs:
  - refresh tokens sealed with AAD `pokemon_connection:<id>`;
  - possibly carried-over rows still sealed with the league id, which `resealCarriedOver` moves at boot;
  - TDF archive files sealed with `tdf_file:<league>:<sha256>`;
- `secrets/session-password`, `secrets/token-vault.key` and `secrets/tdf-vault.key`, or the matching env
  overrides in the Unraid template.

Its tests are extensive:

- ≈1,060 lines of unit tests for the candidate pieces;
- `test/server/{security,logging,boot}.test.ts` against the built server;
- `test/docker/{smoke,litestream,restore-drill}.sh` against the image.

Attendance has two vault files:

- `server/modules/vault/vault.ts`, the cipher, used directly by the TDF archive;
- `server/modules/pokemon/vault/vault.ts`, a `TokenVault` adapter (strings, `TokenVaultError`), used by
  `pokemon/connection.ts` at 5 call sites.

Merging them is in scope.

Genie has no code yet. Its M1 milestone is "Nuxt app, DB, vault, secret bootstrap, setup wizard, …,
image + CI + Unraid template".

## Options considered

1. **Big bang.** One attendance PR replaces every piece with the kit. It's fast, but a failure is hard to
   pin down, the diff is too large to review for security, and rolling back undoes everything.
2. **Piece by piece, lowest risk first, each piece gated by attendance's existing tests running unchanged
   against the kit.** (Chosen.)
3. **Leave attendance alone, and only Genie uses the kit.** This keeps two versions of the security code,
   so the finding stands.

## Decision

### The characterization gate (every step)

For each piece:

1. Attendance's local module becomes a **re-export shim** of the kit: same export names, with any
   configuration (secret specs, extra redaction keys, labels) applied inside the shim.
2. Attendance's **existing tests for that piece run unchanged** against the shim. If a test needs editing,
   the kit's behaviour differs, and that is a kit bug or a deliberate change named in the PR.
3. Call sites switch from the shim to the kit, the shim is deleted, and duplicated unit tests are deleted
   ([ADR-0008](0008-testing-strategy.md) lists which). The app keeps its integration tests and adds the
   kit's contract suites with its own configuration.
4. The step ships as its own attendance release, so a revert is one PR.

### Steps

| Step | Piece | Specific safety check |
| ---- | ----- | --------------------- |
| A1 | Setup code; rate limiter; client address and trusted proxies; request id; CSP/headers (including `nuxt.config.ts` imports) | `test/server/security.test.ts` unchanged |
| A2 | Logger + redaction, with attendance's extra keys (`birthdate`, `dateOfBirth`, `dob`, `content`, `payload`, its secret env names) | `redact.test.ts`, `logger.test.ts`, `test/server/logging.test.ts` unchanged; the setup-code line is byte-identical (the container smoke test greps it) |
| A3 | Secrets, runtime env, launcher | A synthetic **existing install** fixture (`secrets/` with three files in today's format, `value\n`, 0600) loads with the same values, `source: 'file'`, no file written or modified (mtime and directory listing unchanged); env overrides still win; a malformed file still fails startup with the same message; `test/docker/smoke.sh` and `restore-drill.sh` pass |
| A4 | Vault, merging the two vault files | See below |
| A5 | `jsonOnly`, `bodySizeLimit` (TDF preview exempt), security-headers plugin, request-log plugin, rate-limit guard, error handler | All `test/server/*` unchanged |
| A6 | Docker assets (entrypoint, `litestream.yml`, `fetch-litestream.sh`) | `smoke.sh`, `litestream.sh`, `restore-drill.sh` unchanged; `test/unit/entrypoint.test.ts` and `litestream-image.test.ts` repointed at the copied assets |
| A7 | Reusable image and release workflows, shareable release config | A `:pr-N` image publishes from the PR; the next release tags the tested digest; tag names unchanged |

### A4 in detail: the vault merge

- `server/utils/pokemon.ts`:
  `vault: stringVault(createVault({ key: config.tokenVaultKey, label: 'token' }))`.
- `server/utils/tdf-archive.ts`: `createVault({ key: config.tdfVaultKey, label: 'TDF' })`.
- `pokemon/connection.ts`: the `TokenVault` type becomes the kit's string vault type, and its 5
  `TokenVaultError` catches become `VaultError`. What each catch does (mark `needs_reconnect`, revoke
  quietly, reseal carried-over rows) is unchanged.
- Delete `server/modules/vault/` and `server/modules/pokemon/vault/`. The module-boundary ESLint rule allows
  type imports of `Vault` from the kit in modules.
- **Compatibility evidence before merge:**
  - attendance's existing golden blob (`token` vault, the all-7s test key, `default` AAD) opens with the
    kit;
  - a corpus of blobs sealed by *today's* attendance code opens with the kit, and kit-sealed blobs open
    with today's code. The corpus covers each AAD shape, including the carried-over league-id form, and
    empty, binary and 2 MB plaintexts. It is generated in the A4 PR from the pre-migration commit;
  - error messages keep their wording ("The token vault key must be…", "The stored TDF data could not be
    decrypted…"), because operators see them in the log.
- The kit refuses an empty AAD. Every attendance call site passes a non-empty one, and the A4 tests assert
  this for each.

### Install compatibility, stated once

After A1–A7, an existing install updates with **no action**:

- the same env names, secret file names and modes;
- the same blob format;
- the same log lines;
- the same entrypoint behaviour, port, volume and template.

The deploy guide doesn't change, except for one sentence noting that the infrastructure comes from the
kit.

### Genie

- Genie's M1 imports the kit from the first commit:
  - `sessionPassword()` and `aes256Key({ env: 'NUXT_VAULT_KEY', file: 'vault.key', label: 'Vault key' })`;
  - `stringVault` for the bot token, OAuth client secret and attendance token, with AADs such as
    `setting:discord_bot_token`;
  - the redactor with `['content', 'notes', 'botToken', …secretKeyNames(SECRETS)]`;
  - the `/nitro` middleware and plugins;
  - the Docker assets and the reusable workflows.
- It pins an **exact** `0.x` version until 1.0.
- **If the kit isn't ready when Genie needs a piece, Genie waits for it or contributes it to the kit. It
  never copies "for now".** Genie's M0 spikes and its domain work (the Discord port, blueprints,
  `canSee()`) don't depend on the kit, so there is plenty to do while the kit is built.
- Genie's docs are amended (follow-up issue):
  - §3 *Tech stack* (Crypto row), §10 and ADR-0001's consequences say the pieces are shared through
    `@towerism/selfhost-kit`, not carried over;
  - ADR-0009's decision list points at the kit's assets and workflows;
  - the `jobs` module is noted as kit-ready per [ADR-0002](0002-scope.md): plain TS, a storage port, an
    injected `Clock`.

### Order

K1 and K2 (kit 0.x) → A1–A2 and Genie M1 in parallel → A3–A5 → K3 → A6–A7 and Genie's image CI → K5
(1.0). Genie never ships an image built from copied workflows.

## Consequences

- (+) Every step has a narrow diff, a specific safety check and a one-PR rollback.
- (+) The existing tests prove the kit matches attendance's behaviour before attendance's code is
  deleted, so the kit is characterized by a real consumer, not only by its own tests.
- (+) The vault merge leaves one cipher and no adapter in attendance.
- (−) About seven attendance releases with no user-visible change. That is accepted: each is a patch with
  a `refactor`/`fix(deps)` commit, and some (pure refactors) release nothing.
- (−) For a short time the kit and some not-yet-migrated attendance code coexist. That's harmless:
  they're byte-compatible, and the shims make it explicit.
- (−) Genie's M1 depends on kit K1 and K2. If those slip, Genie's skeleton slips. Copying is not the
  fallback.
