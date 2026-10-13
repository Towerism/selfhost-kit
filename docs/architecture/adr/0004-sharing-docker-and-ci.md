# ADR-0004: Share Docker pieces as package assets and CI as reusable workflows

- Status: Proposed
- Date: 2026-10-13

## Context

Besides TypeScript, both apps would copy:

- **`docker/entrypoint.sh`** (73 lines). It:
  - fixes `/data` ownership for PUID/PGID;
  - applies UMASK;
  - drops root with gosu;
  - optionally restores from Litestream, then runs the app under `litestream replicate -exec`;
  - redacts the replica URL when it logs it.

  It is security-relevant: privilege drop and credential redaction.
- **`docker/litestream.yml`** (replicate the database only, never `secrets/`), and the Litestream binary
  download (version and per-arch sha256 pinned in the Dockerfile).
- **The image and release jobs of `ci.yml`:**
  - build, then run the container smoke test, the Litestream test and the restore drill;
  - publish `edge`, `sha-…` and `pr-N` to GHCR;
  - semantic-release dry run, then tag *the tested digest* `X.Y.Z` / `X.Y` / `latest`, then the git tag and
    the GitHub Release.

  `ci.yml` is the most-changed candidate file in attendance (9 commits in 3 days).
- **`.releaserc.json`.**

The Dockerfile itself differs between the apps:

- attendance has a `spikes` stage and copies `server/db/migrations`;
- Genie needs `exports/` and a different port.

CI's `check` (lint, typecheck, test, audit) and `e2e` jobs are short and app-specific.

The pipeline design here was made with the ci-cd-pipeline-builder skill's references in mind (gate order,
cache keys, secrets, environments, rollback, its pitfall list). Its stack detector on attendance found
`node` + `docker`, `pnpm`, and the commands `npm run lint`, `npm test`, `npm run build`, `docker build`. It
also suggested `hadolint`, which attendance doesn't run yet. Each workflow's exact steps are planned in its
own issue spec, with the skill applied again there.

## Options considered

### Docker pieces

1. **Ship the assets in the npm package** (`docker/entrypoint.sh`, `docker/litestream.yml`,
   `docker/fetch-litestream.sh` holding the one version + sha256 pin). Each app's build copies them out
   of `node_modules` with `selfhost-kit docker-assets .output/selfhost-kit`. Real files, not pnpm symlinks,
   so `COPY` works. They are versioned with the code, so one Renovate PR updates TS and shell together.
2. **A base image** (`ghcr.io/towerism/selfhost-node:22`) with tini, gosu, Litestream and the entrypoint.
   It is a clean `FROM`. But it's a third artifact with its own build, tags and digest bumps: every Node
   patch release needs a base-image release, and then a Renovate bump in both apps. Fixes would travel two
   channels (npm for TS, the image for shell), so "is it patched?" has two answers. Native modules
   (`better-sqlite3`) still build in the app's stage.
3. **Copy the files** (the status quo). Rejected for the reasons in ADR-0001.

### CI

1. **Reusable workflows in this repo**, called with `uses: Towerism/selfhost-kit/.github/workflows/app-image.yml@<sha>`:
   - `app-image.yml`: inputs `image-name`, `target`, `smoke-scripts`; output `digest`;
   - `app-release.yml`: inputs `image-name`, `digest`.

   Each app keeps its own `check` and `e2e` jobs and wires `needs:` the same way attendance does today:
   the release waits for check, e2e and image. Renovate updates the pinned SHA (with a `# vX.Y.Z` comment).
2. **A composite action** for the image steps. It can't hold whole jobs, `permissions` or job outputs as
   neatly, and the release job's ordering (image tag before git tag) is a job-level concern.
3. **Copy `ci.yml`** and keep it in step by hand. Rejected: it's the file that changes most.
4. **Share `check`/`e2e` too.** Rejected: they're short, and app-specific (Playwright setup, audit
   ignores, test commands).

## Decision

- **Docker: option 1 (package assets).**
  - Each app's Dockerfile:
    - copies `.output/selfhost-kit/entrypoint.sh` and `litestream.yml` into the runtime stage;
    - runs `fetch-litestream.sh` in its Litestream stage, so the pinned version and checksum live only in
      the kit.
  - The entrypoint's behaviour and env names stay exactly as attendance has them.
  - The kit's CI builds a **fixture image** (a trivial Node server using the assets) and runs the
    entrypoint tests against it: ownership, privilege drop, Litestream restore and replicate, failing
    loudly, redaction of the replica URL.
  - `shellcheck` and `hadolint` run on the assets.
- **CI: option 1 (two reusable workflows)**, plus the **shareable semantic-release config**
  (`extends: "@towerism/selfhost-kit/release-config"`).
  - Callers pin workflows by full commit SHA, never a moving tag. A moving tag in a security-relevant
    pipeline is a supply-chain risk.
  - Callers grant `packages: write` and `contents: write` only to the jobs that call the workflows.
  - No secrets are passed beyond `GITHUB_TOKEN`.
- **The kit's own pipeline** (planned in detail in the K0/K3 specs):
  - **Gates:** `lint → typecheck → test (+coverage gate) → shellcheck/hadolint → entrypoint image test`,
    and only then `release`.
  - **Release:** runs only on `main`, only after every gate is green, with `id-token: write` for npm
    trusted publishing.
  - **Cache:** pnpm store, keyed on `pnpm-lock.yaml`.
  - **Matrix:** none. Both consumers are on Node 22. Add Node 24 only when an app moves to it.
  - **Secrets:** none stored (OIDC for npm, `GITHUB_TOKEN` for the GitHub Release).
  - **Environments:** the `release` job runs in a protected `npm` environment limited to `main`. There is
    **no manual approval** in the kit's own pipeline. This is a deliberate departure from a "manual gate
    for production" policy:
    - a published version reaches no user by itself;
    - the manual gates are each app's Renovate PR merge (automated only when the app's CI is green) and
      the owner's *Update* click on Unraid;
    - adding a third gate would only slow security fixes.
  - **Rollback:**
    - for a bad kit version: `npm deprecate @towerism/selfhost-kit@X.Y.Z "<reason>"` and release a fix
      (npm doesn't allow re-publishing a version, and unpublishing is limited, so we roll forward);
    - in each app: revert the Renovate PR, which releases the app's previous dependency set as a new
      patch;
    - on Unraid: pin the previous `X.Y.Z` image tag.
- Attendance's existing gates (the `pnpm audit` level, the PR images for forks, the amd64-only build) stay
  as they are: the reusable workflow keeps attendance's current behaviour.

## Consequences

- (+) The entrypoint, the Litestream pin and the release choreography exist once. A fix to any of them is
  a kit release, and Renovate delivers it like any other.
- (+) One update channel (the npm version), plus the workflow SHA that Renovate bumps alongside it.
- (−) Workflow callers pin a SHA, separate from the npm version. Renovate groups the two into one PR per
  kit release (a `packageRules` group), so they move together.
- (−) A reusable workflow is harder to debug than inline YAML. Mitigation: the kit's repo has a sample
  caller that runs on every kit PR, building and smoke-testing the fixture image with publishing turned off.
- (−) A change in `app-image.yml` can break both apps' publishing at once. It ships like any kit change: a
  version, a Renovate PR, and each app's CI must pass before merge.
