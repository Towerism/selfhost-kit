# ADR-0003: One package with subpath exports, published to public npm with provenance

- Status: Proposed
- Date: 2026-10-13

## Context

[ADR-0002](0002-scope.md) puts the core (plain TS), the Nitro adapters (needs h3), the test helpers (needs
Vitest), Docker assets and CI workflows in one repository. This ADR decides:

- whether that is one package or several;
- where it is published.

Constraints:

- The question every security release must answer is **"is this app patched?"** It should be one version
  number per app.
- Installs happen in CI, in local dev, and inside `docker build` (the app's `app-build` stage runs
  `pnpm install --frozen-lockfile`). Anything that needs a token to install has to be wired into all three.
- The repository is public, and so is the code.
- One developer maintains it.

## Options considered

### Package shape

1. **One package, subpath exports.** `@towerism/selfhost-kit` (core), `/nitro`, `/testing`, plus files
   (`docker/`, `release-config/`, `bin/`). h3 and Vitest are *optional* peer dependencies, needed only by
   the entry points that use them.
2. **A monorepo of packages** (`@towerism/selfhost-vault`, `-logging`, `-nitro`, …) with Changesets.
   Each app installs only what it uses, and versions move independently. But "is this app patched?" becomes
   a question about five versions, a vault fix might need coordinated bumps, and Changesets, workspace
   tooling and N release lines are overhead for one developer and two consumers. Both apps use every piece
   anyway.

### Registry

1. **Public npm, published from CI with trusted publishing (OIDC) and provenance.** Installs need no
   token anywhere. `npm publish --provenance` records which commit and workflow built each version, and
   trusted publishing means no long-lived npm token exists to steal. Renovate supports it natively.
2. **GitHub Packages (npm registry).** It requires a token to install, even public packages, so every app's
   CI, every `docker build` and every dev machine would need an `.npmrc` with a PAT or `GITHUB_TOKEN`
   plumbing. That's friction and another secret to handle in Docker builds.
3. **Git dependency** (`github:Towerism/selfhost-kit#v1.2.3`). No registry and no token. But there are no
   semver ranges; pnpm has to build the package on install (a `prepare` script in every `docker build`);
   there is no provenance; and Renovate's handling of git tags is weaker than for registry versions.

## Decision

- **One package**, `@towerism/selfhost-kit`, ESM only, Node ≥ 22.12 (both apps' `engines`), with these
  `exports`:

  | Subpath | Contents | Peer dependencies |
  | ------- | -------- | ----------------- |
  | `.` | Core ([ADR-0006](0006-api-boundaries.md)) | none (depends on `pino`, `pino-pretty`) |
  | `./nitro` | h3/Nitro adapters | `h3` `^1.15` (optional peer) |
  | `./testing` | Contract suites, KATs, fakes | `vitest` (optional peer) |
  | `./release-config` | Shareable semantic-release config | the semantic-release plugins (optional peers) |
  | `./docker/*` | Raw assets | — |

  It has `"sideEffects": false` and ships compiled JS plus `.d.ts` files. The build tool (tsdown or `tsc`)
  is chosen in the K0 spec. Sources are not shipped as `.ts`, so consumers don't need a TS loader in
  production.
- **Public npm.** Published by `semantic-release` from `main` with **trusted publishing** (GitHub OIDC,
  `id-token: write`) and **`--provenance`**. No `NPM_TOKEN` secret exists. The npm account has 2FA on.
- **Prerequisite (owner action):** the `towerism` npm organisation or user scope must exist, and the
  package must have this repository's `release.yml` workflow registered as its trusted publisher. The first
  `0.1.0` may need a one-time manual publish to create the package before a trusted publisher can be
  attached. If so, the K0 spec says how, and that token is revoked straight after.

## Consequences

- (+) One version per app answers "is it patched?".
- (+) Nothing secret is needed to install the kit, in CI, in Docker builds or in dev.
- (+) Provenance ties each published version to a commit and workflow run in this public repo.
- (−) An app that someday needs only the vault still installs the whole kit. It's small (pino is already in
  both apps), and `sideEffects: false` keeps bundles lean.
- (−) An optional peer dependency that's missing (h3 when importing `/nitro`) only fails at import time.
  Both apps always have h3 through Nitro, and the `/nitro` contract tests run in each app.
- (−) A public package invites outside users. The README states the scope (these two apps), and semver
  promises are made only for the documented API.
