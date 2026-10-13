# ADR-0005: Semver, compatibility rules and the security-fix path

- Status: Proposed
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

  A `v*` tag is never pushed by hand.
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
