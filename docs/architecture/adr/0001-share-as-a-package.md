# ADR-0001: Share the infrastructure as a package, not a layer, template or copy

- Status: Proposed
- Date: 2026-10-13

## Context

An adversarial review of Tournament Genie's architecture (Warning #5) found that Genie plans to copy
attendance's infrastructure: the vault, the secret bootstrap and launcher, log redaction, the security
middleware, the entrypoint, CI and the release flow. Copying creates two versions of security-sensitive
code, so a fix in one never reaches the other.

Evidence from the code ([architecture §1.1](../README.md#11-what-the-study-of-the-code-found)):

- About 1,060 lines of production code and 1,060 lines of unit tests would be copied, and the only thing
  that differs between the two copies is **configuration**: the list of secret specs, the extra redaction
  keys, the exempt paths, extra CSP sources, the image name. None of the logic would differ.
- The code is three days old and has had no fixes yet. Nothing has drifted so far. Without sharing, drift
  would start with the first fix that lands in only one app.
- The parts that differ a lot (the Unraid template, the job runner) are exactly the parts that should not
  be shared ([ADR-0002](0002-scope.md)).
- Some of this code runs before Nitro is loaded (the launcher), and some runs in `nuxt.config.ts` (the CSP
  builder). Both apps require "modules are plain TS".

The owner is one developer maintaining two apps on the same stack, on the same server.

## Options considered

### (a) A shared npm package (or packages)

Plain TypeScript, imported by both apps, versioned with semver, updated by Renovate.

- (+) One copy of each piece. A fix is a release, and each app gets a PR.
- (+) Works everywhere the code runs: the launcher before Nitro, `nuxt.config.ts`, Nitro plugins and
  middleware, Vitest.
- (+) Configuration is explicit at the call site, so each app's security setup can be reviewed in the
  app.
- (+) Testable on its own, with contract suites the apps can also run.
- (−) A third repository with its own CI and release flow to maintain.
- (−) A change needs a release before an app can use it (`pnpm link` covers development).

### (b) A Nuxt module or Nuxt layer

A layer contributes `server/` files (middleware, plugins, utils) that Nuxt merges into each app. A module
registers them programmatically.

- (+) Less wiring in each app: the middleware and plugins appear automatically.
- (−) The launcher runs before Nuxt or Nitro exist, and the CSP builder runs inside `nuxt.config.ts`. A
  layer can't provide either, so a plain package is needed anyway, and there would then be two shared
  artifacts.
- (−) Auto-registration hides security behaviour: an app's `server/middleware/` no longer shows which
  guards run. Overriding a layer file (Nuxt lets a same-named app file win) silently drops a guard, which
  is the opposite of what security code needs.
- (−) Layers are tied to Nuxt's merge rules and versions. Testing them needs a Nuxt build, which goes
  against "framework-free core".
- (−) It is still distributed as an npm package or a git reference, so it doesn't save any packaging work.

### (c) A template repository plus a documented sync process

Attendance's infrastructure is extracted into a template. Genie starts from it, and a checklist (or a sync
script) carries changes across.

- (+) No package to publish. Each app owns its files and can change them freely.
- (−) This is copying with paperwork. A fix reaches the other app only if someone remembers to run the
  sync, which is exactly the failure mode the finding describes.
- (−) Sync scripts that overwrite files conflict with local edits. Over time the copies diverge anyway.
- (−) There is no version number that answers "does this app have the fix?"

### (d) Keep copying, and write down that we accept the drift

- (+) Zero new infrastructure. Genie starts fastest.
- (−) The evidence doesn't support it. The copies would be identical apart from configuration, so
  sharing costs little, while the code is security-critical (vault, redaction), so drift is expensive.
  Accepting the drift would be reasonable if the copies would really differ, and they wouldn't.
- (−) Attendance's copy is the one in production with real refresh tokens and minors' birthdates. A
  redaction fix found while building Genie, which is the likely time to find one, would never reach
  attendance unless someone ports it by hand.

## Decision

**Option (a): one shared npm package, `@towerism/selfhost-kit`**, with a framework-free core and a thin
`/nitro` entry point for the h3/Nitro adapters ([ADR-0006](0006-api-boundaries.md)). Docker and CI pieces
are shared from the same repository: package assets, reusable workflows and a shareable release config
([ADR-0004](0004-sharing-docker-and-ci.md)).

The kit takes **configuration, never forks**. When one app needs different behaviour, the kit gains a
parameter, or the behaviour stays in the app. An app never patches or vendors the kit's code.

A Nuxt module (option b) may be added later as a convenience on top of the package, if wiring turns out to
be a real cost. It would wrap the package, never replace it, and would need its own ADR.

## Consequences

- (+) Each security-sensitive piece exists once. "Does attendance have the fix?" is answered by its
  lockfile.
- (+) Genie never copies. Its M1 imports the kit.
- (+) Attendance's two vault files become one call into the kit ([ADR-0007](0007-migration.md)).
- (−) A third repo, CI pipeline and release to maintain. This is mitigated by reusing attendance's own
  pipeline patterns and semantic-release.
- (−) A kit change that one app needs waits for a release. `pnpm link` or a `0.x` pre-release covers
  development. Releases are automatic once CI is green.
- (−) Shared blast radius: a kit bug reaches both apps. This is mitigated by contract tests that each app
  runs against its own configuration, by both apps' full CI on every kit bump, and by the rollback rules in
  [ADR-0005](0005-versioning-and-security-fixes.md).
