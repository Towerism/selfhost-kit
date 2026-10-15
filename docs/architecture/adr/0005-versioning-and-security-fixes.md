# ADR-0005: Semver, compatibility rules and the security-fix path

- Status: Accepted (2026-10-13); amended 2026-10-13 (the `v0.0.0` bootstrap tag, below) and 2026-10-14 (1.0, below)
- Date: 2026-10-13

## Context

The point of the kit is that a fix reaches both apps quickly ([ADR-0001](0001-share-as-a-package.md)). So
this ADR decides how versions are numbered, what counts as breaking, and how a security fix travels from
a commit here to a released image of each app.

Both apps release automatically: semantic-release on every green push to `main`, tagging the tested
image. The owner's *Update* click on Unraid is the final manual step. Attendance's architecture lists
Renovate under supply chain, but it has no Renovate config yet (a follow-up issue).

The kit's data-at-rest promises are special. An app that upgrades the kit and then rolls back must still
read what the newer version wrote: vault blobs and secret files.

## Options considered

1. **Semver + semantic-release from Conventional Commits, Renovate with automerge for patch and minor,
   security advisories for security fixes.** (Chosen.) This is the same release machinery both apps
   already use.
2. **Calendar versions, with apps always taking the latest.** Simpler numbering, but no signal about
   breaking changes. An app couldn't safely automerge.
3. **Manual releases.** A human picks the version and writes the notes. This slows fixes and depends on
   one person's attention, and that's the failure mode we're removing.
4. **Each app vendors a pinned git SHA and updates it by hand.** No automation, so fixes stall.

## Decision

### Numbering

- **semantic-release** on `main`, from Conventional Commits:
  - `fix:` and `perf:` → patch;
  - `feat:` → minor;
  - `!` or `BREAKING CHANGE:` → major;
  - `docs`, `test`, `chore`, `ci`, `refactor` and `build` release nothing.

  A `v*` tag is never pushed by hand (one exception, recorded in the amendment below).
- **`0.x` until attendance's migration is complete (K4).** In 0.x a minor may break. Consumers pin an
  **exact** version, and Renovate still proposes every bump. `1.0.0` is cut once both apps run on the kit
  and the API has survived a real migration (K5).

### What is the public API (and so what "breaking" means)

- every export of `.`, `./nitro`, `./testing` and `./release-config`, including error class names and the
  meaning of option fields;
- the **vault blob format** and AAD semantics;
- the **secret file conventions** (the `secrets/` location, modes, "never regenerate", env wins);
- the **env variable names** the kit reads ([architecture §6.3](../README.md#63-environment-variables-the-kit-reads));
- the **entrypoint's** env names and behaviour, and the reusable workflows' inputs and outputs;
- the **log line formats** apps depend on (the pretty line, the request line, the setup-code line).

### Compatibility rules (these override the commit type)

1. **Redaction only grows.** A key may be added to `BASE_SENSITIVE_KEYS` in a patch (it's a fix). Removing
   one is a major release and needs an ADR.
2. **Vault formats: read first, write later.** Reading a new blob version ships in a minor. Writing it by
   default needs a major, and only after the reader has been released for at least one minor. A version
   must never write data that an earlier release *in the same major* can't read, so rolling back a
   Renovate PR is always safe.
3. **Secret files are never renamed, moved or regenerated** by the kit. A new secret spec builder is a
   minor change. Changing the default file name of an existing builder is major.
4. **Security defaults only get stricter in minors when the stricter behaviour can't lock an install
   out.** For example, refusing an empty AAD is fine because no caller passes one. A tightening that could
   fail an existing install's startup, such as rejecting a secret that today's validation accepts, is
   major and needs a migration note.
5. **Deprecate before removing.** A deprecated export keeps working, logs a one-time warning, and is
   removed in the next major. Each major's release notes include a migration section.

### Security fixes

1. A vulnerability is reported privately (`SECURITY.md` → GitHub private vulnerability reporting). The fix
   is prepared in a **private security advisory** fork, so the public repo doesn't show it before
   release.
2. The commit type is `fix(security): …`, with an `Advisory: GHSA-…` footer. The release-notes config puts
   `security`-scoped commits under a **Security** heading at the top of the notes.
3. On merge, the patch is published within the same CI run. The advisory is then published with the
   patched version range, so GitHub (and Renovate's `vulnerabilityAlerts`) flags vulnerable lockfiles.
4. **Each app's Renovate config** (follow-up issues):
   - `@towerism/selfhost-kit` and the kit's workflow SHAs are in one group;
   - `minimumReleaseAge: 0` for this package only, because it's our own code and waiting delays fixes;
   - schedule "at any time";
   - `automerge: true` for patch and minor once required checks pass (exact pins in 0.x);
   - `vulnerabilityAlerts` with the `security` label;
   - majors are never automerged.
5. The app's semantic-release treats the dependency bump (`fix(deps): …`) as a patch. The app image is
   tagged and Unraid shows "update ready". The owner updates both containers.
6. **Target time:** under an hour from the kit merge to a released image in both apps, without manual
   editing. The advisory says which app versions contain the fix.

### Supported versions

Only the latest minor of the current major gets fixes. When a new major ships, the previous major gets
security fixes for 90 days. `SECURITY.md` records this.

## Consequences

- (+) The same release machinery as both apps. Nothing new to learn.
- (+) A fix needs no hand-editing in either app. The owner's only step is the existing Unraid *Update*.
- (+) Rollbacks are safe by rule 2, which is checked in CI by a "previous version reads new blobs" test
  ([ADR-0008](0008-testing-strategy.md)).
- (−) Automerge means a kit regression that both apps' CI misses reaches the release tags of both apps.
  The Unraid *Update* click and the rollback path (revert the PR, or pin the previous image tag) are the
  backstops.
- (−) Commit discipline matters: a breaking change mislabelled `fix:` would be automerged. Mitigations:
  - the `/testing` contract suites run in each app's CI;
  - an API-surface check (an `api-extractor`-style report diffed in PRs) flags export changes;
  - the review checklist asks "is this breaking?" for every PR.

## Amendment (2026-10-13): the `v0.0.0` bootstrap tag

Approved by the owner with the K0 spec (issue #6).

- **Context.** semantic-release's first release is `1.0.0` when no earlier `v*` tag exists, but the
  numbering above starts the kit at `0.1.0` and keeps it in `0.x` until K5. npm also needed a hand-published
  `0.0.0` placeholder before a trusted publisher could be attached ([ADR-0003](0003-single-package-on-npm.md)).
- **Decision.** Exactly once, during K0, a `v0.0.0` tag was pushed by hand on the last commit of `main`
  before the K0 merge. It marks the placeholder and gives semantic-release a starting point, so the first
  automated release is `0.1.0`. No other `v*` tag is ever pushed by hand.
- **Also implemented in K0.** While in `0.x`, the release rules map a breaking change to a **minor**, as
  the numbering above already says. The rule is removed when `1.0.0` is cut (K5).
- **Consequence.** The tag history starts at `v0.0.0`, which has no automated release or provenance
  behind it. `0.0.0` is deprecated on npm. The procedure is in [docs/releasing.md](../../releasing.md).

## Amendment (2026-10-14): 1.0

Approved by the owner with the K5 spec (issue #31).

- **Context.** Both apps run on the kit: attendance after steps A1–A7 (K4), Genie from its M1. The API has
  survived a real migration, which is this ADR's condition for `1.0.0`.
- **Decision.**
  - The release rule now maps a breaking change to **major**. It replaces the 0.x rule (breaking → minor)
    rather than being dropped, and stays first in `releaseRules`: commit-analyzer uses the preset's own
    breaking → major only when none of the custom rules match, so without it `feat!:` would still release a
    minor and `refactor!:` nothing.
  - The K5 pull request carries one `BREAKING CHANGE:` footer per break, written as a migration step, and
    is merged with a merge commit. Its release, `1.0.0`, has them under *BREAKING CHANGES* (rule 5's
    migration section), and `docs/adopting.md` repeats them.
  - The API-surface report this ADR calls for exists: `api/*.api.md`, generated by `pnpm api:report` and
    checked by `pnpm api:check` in CI.
- **Rule 5 at the cut.** The 0.x → 1.0 cut removes the type exports `NitroAppLike`, `DefaultErrorResponse`
  and `DefaultErrorHandler` from `./nitro` without a deprecation cycle. They are type-only, so no runtime
  warning was possible, and 0.x allowed breaking changes in minors. Rule 5 applies from 1.0 on.
- **Rollback promise.** Rule 2 holds for 1.x. The CI check that the previous version opens the current
  version's blobs is still to come (#12); until then it rests on the unchanged v1 format and the KATs.
