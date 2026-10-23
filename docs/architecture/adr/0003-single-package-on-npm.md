# ADR-0003: One package with subpath exports, published to public npm with provenance

- Status: Accepted (2026-10-13); amended 2026-10-13 (Node 24, below) and 2026-10-14 (dev-tool peers, below).
  The registry decision (public npm, trusted publishing, provenance) is superseded by
  [ADR-0009](0009-gitea-npm-registry.md) (2026-10-22). The single-package shape and the subpath exports stand.
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

- **One package**, `@towerism/selfhost-kit`, ESM only, Node ≥ 24.11 (both apps' `engines`; was 22.12, see the
  [Node 24 amendment](#amendment-2026-10-13-node-24)), with these
  `exports`:

  | Subpath | Contents | Peer dependencies |
  | ------- | -------- | ----------------- |
  | `.` | Core ([ADR-0006](0006-api-boundaries.md)) | none (depends on `pino`, `pino-pretty`) |
  | `./nitro` | h3/Nitro adapters | `h3` `^1.15` (optional peer) |
  | `./testing` | Contract suites, KATs, fakes | `vitest` (optional peer; since 1.0 the app's devDependency, not a peer: see the [dev-tool peers amendment](#amendment-2026-10-14-dev-tool-peers-removed)) |
  | `./release-config` | Shareable semantic-release config | the semantic-release plugins (optional peers; since 1.0 the app's devDependencies, not peers) |
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

## Amendment (2026-10-13): Node 24

Approved by the owner with the spec on issue #9.

- **Context.** The first automated release (`0.1.0`) failed at `npm publish` with `ENEEDAUTH`. The release
  job ran Node 22, whose bundled npm (10.9.9) can't do the trusted-publishing OIDC exchange; npm does it
  from 11.5.1, which every Node 24 release from 24.5.0 bundles.
- **Decision.** The kit, its CI and its release job move to **Node 24**: `.node-version` is `24` and
  `engines` is `>=24.11`, the first Node 24 LTS. Both apps are required to upgrade to Node 24 to adopt the kit.
- **Also implemented.** The release job checks that npm is at least 11.5.1 before semantic-release runs, so
  an npm that can't publish stops the job before any tag is pushed ([docs/releasing.md](../../releasing.md)).
- **Consequence.** An app still on Node 22 gets an `engines` warning from npm or pnpm and is unsupported.

## Amendment (2026-10-14): dev-tool peers removed

Approved by the owner with the K5 spec (issue #31, fixing #24).

- **Context.** pnpm 10 records every peer the kit declares as the kit's `optionalDependencies` in the app's
  lockfile, even optional ones the app only has as devDependencies. `pnpm audit --prod` then treated
  `vitest` and `semantic-release` as production dependencies of the app. Attendance had to ignore vitest's
  tinypool advisories (GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr) to keep its audit green.
- **Decision.** `h3` (`^1.15`, optional) is the only peer dependency. `vitest`, `semantic-release`,
  `@semantic-release/exec` and `conventional-changelog-conventionalcommits` are no longer declared.
  `/testing` and `/release-config` import them from the app, which has them as devDependencies. The table
  above now reads: `./testing` needs `vitest` and `h3` in the app; `./release-config` needs the
  semantic-release plugins in the app. It is still one package; splitting it was considered and isn't needed.
- **Evidence.** A local-registry reproduction: 5 prod advisories through `.>@towerism/selfhost-kit>vitest`
  before, 0 after. `/testing` ran under Vitest and `/release-config` loaded from the consumer, and
  `publint --strict` and `attw` were clean. pnpm 11 doesn't count optional peers as prod at all.
- **Consequences.**
  - (−) Nothing checks the app's Vitest version against a range any more; the kit's CI tests `/testing`
    with the Vitest major in its own lockfile, and the README says so.
  - (−) pnpm's global virtual store and Yarn PnP can't resolve those tools from the kit, so they are
    unsupported for `/testing` and `/release-config`. Neither app uses them.
