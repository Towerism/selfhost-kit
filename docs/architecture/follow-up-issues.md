# Follow-up issues (drafts, not filed)

Draft text for issues in the two apps. None of these is filed yet. Each would be specced on its issue
before any work starts. Titles use the apps' Conventional Commit style.

---

## Attendance (Towerism/play-pokemon-attendance-web)

### 1. Adopt `@towerism/selfhost-kit` (tracking)

> **Why.** The secret bootstrap, vault, log redaction, security middleware, setup code, entrypoint and
> image/release CI move into the shared kit, so that Tournament Genie and attendance share one copy
> (selfhost-kit ADR-0001). Existing installs must not notice: the same env names, secret files, blob
> format, log lines and image behaviour (selfhost-kit ADR-0007).
>
> **Steps** (one PR and release each, gated by the existing tests running unchanged against the kit
> through a re-export shim):
> - [ ] A1 setup code, rate limiter, client address, request id, CSP/headers
> - [ ] A2 logger + redaction (extra keys: birthdate, dateOfBirth, dob, content, payload, secret env names)
> - [ ] A3 secrets, runtime env, launcher (existing-install fixture: same values, nothing regenerated)
> - [ ] A4 vault, merging `modules/vault` and `modules/pokemon/vault` (golden blob + corpus in both directions)
> - [ ] A5 Nitro middleware, plugins, rate-limit guard, error handler
> - [ ] A6 Docker assets (entrypoint, litestream.yml, Litestream pin)
> - [ ] A7 reusable image/release workflows + shareable release config
>
> **Done when** every box is ticked, `server/modules/vault/`, `server/modules/pokemon/vault/`,
> `server/logging/{logger,redact,request-id}.ts`, `server/bootstrap/{secrets,runtime-env}.ts` (beyond the
> app's spec list) and `docker/entrypoint.sh` are gone, and `test/server/*` and `test/docker/*` pass
> unchanged. Blocked by selfhost-kit K1/K2 (A1–A5), K3 (A6–A7).

Each step A1–A7 above becomes its own issue with the same text pattern: the piece, its safety check from
selfhost-kit ADR-0007, and which unit tests move or get deleted (ADR-0008 table).

### 2. `chore(deps): add a Renovate config`

> Architecture §9 lists "Lockfile, Renovate, `pnpm audit` in CI" under supply chain, but the repo has no
> Renovate config (`renovate.json` or `.github/renovate.json`). The shared kit's security-fix path
> (selfhost-kit ADR-0005) depends on Renovate opening a PR within minutes of a kit release.
>
> Proposed config:
> - `config:recommended`, `:semanticCommits` (so dependency fixes release as `fix(deps)`);
> - a group for `@towerism/selfhost-kit` plus the `Towerism/selfhost-kit` workflow SHAs;
> - for that group: `minimumReleaseAge: 0`, schedule at any time, `automerge: true` for patch/minor once
>   required checks pass (exact pins while the kit is 0.x);
> - `vulnerabilityAlerts` labelled `security`;
> - GitHub Actions pinned by digest.
>
> Also: turn on branch protection with required checks if it isn't on, since automerge relies on it.

### 3. `fix(security): bound /api bodies sent without Content-Length` (found along the way; verify first)

> `server/middleware/body-size.ts` refuses an `/api` body over 2 MiB by its `Content-Length` only. A
> POST with `Transfer-Encoding: chunked` and no `Content-Length` appears to pass the middleware, and
> h3's body reader doesn't seem to apply a limit of its own, so the body would be read unbounded
> (memory). The TDF preview route already answers 411 for a missing length; the general middleware
> does not.
>
> **First** confirm with a server test (a chunked 3 MiB JSON POST to an authenticated `/api` route). If
> confirmed, either refuse body-carrying requests without a `Content-Length` (411) or count bytes while
> reading. The shared kit's `bodySizeLimit` will make the same decision (selfhost-kit ADR-0008 matrix), so
> fixing it there and adopting it in step A5 may be the simplest route.

---

## Genie (discord-pokemon-tournament-genie)

### 4. `docs(architecture): share infrastructure through @towerism/selfhost-kit`

> Addresses review Warning #5 (copied infrastructure). Amend:
> - §3 *Tech stack*: the Crypto row says the vault is `@towerism/selfhost-kit`'s (`createVault` +
>   `stringVault`), not "the same pattern as attendance's".
> - §3 opening paragraph ("reuse what attendance proved") and §10: these pieces are shared through the kit,
>   not carried over: the launcher, secret bootstrap, entrypoint, Litestream, image and release
>   workflows, security middleware and redaction.
> - ADR-0001 consequence "carry over almost as-is" → "shared through `@towerism/selfhost-kit`
>   (selfhost-kit ADR-0001)".
> - ADR-0009 decision list → the kit's Docker assets and reusable workflows.
> - §9 vault row and §10 logs: the key is `NUXT_VAULT_KEY` / `secrets/vault.key` through the kit's
>   `aes256Key`; redaction is the kit's base list plus `content`, `notes`, `botToken` and the secret env
>   names.
> - The `jobs` module stays in Genie (selfhost-kit ADR-0002), but is written so it can be extracted: plain
>   TS, storage behind a port, an injected `Clock`. It moves into the kit when a second app needs it.
>
> These are ADR amendments, so they need the owner's approval like any architecture change.

### 5. M1 skeleton uses the kit from the first commit (add to the M1 issue's scope)

> Pin an exact `@towerism/selfhost-kit` 0.x version. Use:
> - `runLauncher` + `prepareRuntimeEnv` with `sessionPassword()` and the vault key spec;
> - the kit's logger and redactor;
> - `/nitro` `jsonOnly`, `bodySizeLimit`, `securityHeadersPlugin` (plus any extra CSP sources Genie needs),
>   `requestLogPlugin`, `enforceRateLimit` on login and setup, `jsonErrorHandler`;
> - `generateSetupCode` / `setupCodeMatches` in the setup wizard;
> - the kit's Docker assets;
> - the reusable image/release workflows.
>
> Run `describeVaultContract`, `describeRedactionContract` (mustHide: bot token, client secret, attendance
> token, message content, notes) and the middleware matrices in Genie's own suite.
>
> **Rule:** if a piece isn't in the kit yet, wait for it or add it to the kit. Never copy it from
> attendance "for now".

### 6. `chore(deps): add a Renovate config` (same as attendance #2)

> The same group and automerge rules for the kit, from the first commit.
