# Ops assets: Docker, image CI and releases

The kit ships the parts of an app's image and release pipeline that would otherwise be copied
([ADR-0004](architecture/adr/0004-sharing-docker-and-ci.md)):

| Piece                                                         | What it does                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [`docker/entrypoint.sh`](../docker/entrypoint.sh)             | Fixes `/data` ownership for `PUID`/`PGID`, applies `UMASK`, drops root with gosu, optionally runs under Litestream        |
| [`docker/litestream.yml`](../docker/litestream.yml)           | Replicates the database only (`NUXT_DATABASE_PATH`), never `secrets/`                                                     |
| [`docker/fetch-litestream.sh`](../docker/fetch-litestream.sh) | Installs the one pinned Litestream release (linux/amd64), verified by sha256                                              |
| `selfhost-kit docker-assets <dir>`                            | Copies the three files above out of `node_modules` as real files                                                          |
| [`app-image.yml`](../.github/workflows/app-image.yml)         | Reusable: builds the image, runs the app's smoke scripts, publishes `edge` / `sha-…` / `pr-N` to GHCR, outputs the digest |
| [`app-release.yml`](../.github/workflows/app-release.yml)     | Reusable: semantic-release dry run, tags the tested digest `X.Y.Z` / `X.Y` / `latest`, then the git tag and Release       |
| `@towerism/selfhost-kit/release-config`                       | The shared semantic-release config                                                                                        |

The entrypoint's env names, defaults and log lines are attendance's, unchanged, and are public API
([ADR-0005](architecture/adr/0005-versioning-and-security-fixes.md)).

## Dockerfile

Copy the assets out in the build stage, install Litestream with the kit's script, and copy both into the
runtime stage:

```dockerfile
FROM node:24.21.0-slim AS app-build
# … install with pnpm and build the app …
RUN pnpm exec selfhost-kit docker-assets .output/selfhost-kit

FROM node:24.21.0-alpine3.23 AS litestream
ARG TARGETARCH
COPY --from=app-build /app/.output/selfhost-kit/fetch-litestream.sh /tmp/fetch-litestream.sh
RUN sh /tmp/fetch-litestream.sh /usr/local/bin

FROM node:24.21.0-slim AS app
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu tini \
 && rm -rf /var/lib/apt/lists/* \
 && gosu nobody true
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=app-build /app/.output/selfhost-kit/litestream.yml /etc/litestream.yml
COPY --from=app-build /app/.output/selfhost-kit/entrypoint.sh /usr/local/bin/entrypoint.sh
# … the app's files, ENV (PUID=99, PGID=100, UMASK=022, NUXT_DATABASE_PATH=/data/app.db), VOLUME, HEALTHCHECK …
ENTRYPOINT ["tini", "--", "entrypoint.sh"]
CMD ["node", ".output/launcher.mjs"]
```

[`test/entrypoint/Dockerfile`](../test/entrypoint/Dockerfile) is a complete, tested example.

## CI

Keep the app's own `check` and `e2e` jobs, and call the two workflows. Pin them by **full commit SHA** with
the version as a comment (Renovate keeps both current), and grant the write permissions only to the jobs
that call them. No secret other than `GITHUB_TOKEN` is used.

```yaml
permissions:
  contents: read

jobs:
  check: … # lint, typecheck, test, audit
  e2e: … # Playwright

  image:
    needs: check
    permissions:
      contents: read
      packages: write
    uses: Towerism/selfhost-kit/.github/workflows/app-image.yml@<sha> # vX.Y.Z
    with:
      image-name: ghcr.io/towerism/play-pokemon-attendance
      smoke-scripts: |
        test/docker/smoke.sh
        test/docker/litestream.sh
        test/docker/restore-drill.sh

  release:
    needs: [check, e2e, image]
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    permissions:
      contents: write
      packages: write
    uses: Towerism/selfhost-kit/.github/workflows/app-release.yml@<sha> # vX.Y.Z
    with:
      image-name: ghcr.io/towerism/play-pokemon-attendance
      digest: ${{ needs.image.outputs.digest }}
```

`app-image.yml` inputs: `image-name` (required), `target` (default `app`), `file` (default `Dockerfile`),
`context` (default `.`), `smoke-scripts` (one program per line; each gets the built image's local tag as its
only argument), `publish` (default `true`). Fork pull requests are built and smoke-tested but never
published. `app-release.yml` inputs: `image-name` and `digest`, both required; it refuses to release when the
digest is empty.

## Release config

`.releaserc.json`:

```json
{ "extends": "@towerism/selfhost-kit/release-config" }
```

Install its plugins as dev dependencies: `semantic-release`, `@semantic-release/exec` and
`conventional-changelog-conventionalcommits`. The config releases from `main` with `vX.Y.Z` tags: `feat` →
minor, `fix`/`perf` (including `fix(deps)`) → patch, breaking → major. `fix(security)` commits come first
in the notes, under **Security**, with their `Advisory: GHSA-…` linked. Nothing is published to npm.

## Renovate (in each app)

So a kit fix reaches the app as one pull request ([ADR-0005](architecture/adr/0005-versioning-and-security-fixes.md)):

```json
{
  "packageRules": [
    {
      "groupName": "selfhost-kit",
      "matchPackageNames": ["@towerism/selfhost-kit", "Towerism/selfhost-kit"],
      "minimumReleaseAge": "0 days",
      "schedule": ["at any time"]
    },
    {
      "matchPackageNames": ["@towerism/selfhost-kit", "Towerism/selfhost-kit"],
      "matchUpdateTypes": ["patch", "minor"],
      "automerge": true
    }
  ]
}
```

## Rollback

- **A bad image** (`edge`, `sha-…`): pin a previous `sha-…` or `X.Y.Z` tag on Unraid.
- **A bad release**: pin the previous `X.Y.Z` on Unraid, then revert the offending commit, which releases
  the previous state as a new patch. To move `latest` back by hand:
  `docker buildx imagetools create --tag ghcr.io/towerism/<app>:latest ghcr.io/towerism/<app>:<previous>`.
- **A bad kit version**: revert the Renovate pull request in the app; in the kit, `npm deprecate` the
  version and release a fix ([releasing.md](releasing.md#rollback)).

## Testing the assets

`pnpm test` runs the entrypoint's non-root logic and the Litestream installer's refusals on the host.
`pnpm test:entrypoint` builds the fixture image and runs the container tests
([`test/entrypoint/run.sh`](../test/entrypoint/run.sh)) against the local Docker daemon. CI runs the same
tests through `app-image.yml` (the `sample-caller` job), so every kit pull request exercises the reusable
workflow too.
