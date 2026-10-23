# ADR-0009: Publish to the Gitea npm registry, with a token, not trusted publishing

- Status: Accepted (2026-10-22). Supersedes the registry decision in [ADR-0003](0003-single-package-on-npm.md).
- Date: 2026-10-22

## Context

The kit moved from GitHub to Gitea on 2026-10-22, at `towerism/selfhost-kit` on vcs.martinfrackerjr.com
([#41](https://github.com/Towerism/selfhost-kit/issues/41) in the GitHub copy tracks the move). ADR-0003
published the package to public npm with trusted publishing: npm trusts one workflow in one GitHub
repository, and the release job proved its identity with an OIDC token. Trusted publishing can't publish
to any other registry, and Gitea Actions doesn't mint the token npm checks.

The owner decided that the package moves to the Gitea npm registry, at
`https://vcs.martinfrackerjr.com/api/packages/towerism/npm/`. That registry answers anonymous requests with
401, so every install needs a token. ADR-0003 rejected GitHub Packages for that reason, and the reason
still holds: installs in CI, in Docker builds and on developers' machines all need a token.

## Options considered

1. **Gitea npm registry, token-based publish and install.** (Chosen.) The owner's registry, next to the
   other Gitea services. Publishing needs one package-write token, and installs need one read token.
2. **GitHub Packages (npm registry).** Rejected. It requires a token to install, even for public packages,
   so it has the same cost as option 1, and it adds a second registry the owner doesn't otherwise use.
   It also doesn't match the move: the point is to leave GitHub.
3. **Public npm with trusted publishing, from the GitHub copy until it is archived.** Rejected. It keeps
   the GitHub copy alive as the release source, which the move is meant to end. It also needs no token,
   and that is the property this ADR gives up.

## Decision

- **Registry.** `@towerism/selfhost-kit` is published to the Gitea npm registry at
  `https://vcs.martinfrackerjr.com/api/packages/towerism/npm/`. `publishConfig.registry` names it, and
  consumers map the `@towerism` scope to it in `.npmrc`.
- **Publish credential.** A Gitea access token with scope `write:package`, owned by a dedicated user
  (`ci-publisher`) whose only team grants package write for `towerism`. It is the repository secret
  `GITEA_PACKAGE_TOKEN`, read by the release job's publish step only. The release job also probes the
  token with a write request before semantic-release tags, so a refused token stops the job first.
- **Install credential.** A read-only token, in `NPM_READ_TOKEN`, held by each consuming app's CI and
  its Docker build as a BuildKit secret. It is never written into a committed file or an image layer.
- **Provenance.** Dropped. npm's provenance needs the OIDC token from GitHub Actions or GitLab CI, so it
  can't be produced for a Gitea-published version.
- **Scope of the release plugin.** Unchanged until the CI move. Then the release plugin is
  `semantic-release-gitea`, and its token is the job's built-in Gitea Actions token (NFR-5 of the
  [#41 spec](https://github.com/Towerism/selfhost-kit/issues/41)).

## Security trade-off

ADR-0003 chose trusted publishing because no long-lived npm token would exist to steal: a publish needed
an OIDC token minted for one workflow run. This ADR gives that up. A publish token now exists as a
repository secret, and it lasts until it is revoked or rotated. The owner accepts that cost in exchange
for leaving GitHub.

What limits the damage:

- the publish token has `write:package` only, and its owner's only team grants package write, so it can't
  write repositories, issues or other owners' packages;
- it is read only in the release job's publish step and the write probe, in the `npm` environment, which
  only `main` may deploy to;
- the release job never prints it, and the job log is checked for the token value during review;
- rotation within 365 days is recorded in [docs/releasing.md](../../releasing.md#rotation). Gitea tokens
  don't expire on their own, so the reminder is manual.

## Consequences

- (+) The release and the packages stay on the owner's server, with no GitHub dependency once the CI moves.
- (+) Install-time auth is explicit: an install without the token fails with a 401 for `@towerism`, and it
  can't fall back to public npm.
- (+) The probe fails the release before any tag is pushed, when the publish token is refused.
- (−) A long-lived publish token exists. See the trade-off above.
- (−) Every consumer's CI and Docker build now needs a read token. [ADR-0007](0007-migration.md)'s
  promise that an existing install updates "with no action" no longer holds for those builds.
- (−) No provenance attestation for the published versions.
- (−) The name `@towerism/selfhost-kit` is also on public npm (1.0.0, published 2026-10-15). Consumers
  stay on whichever registry their `.npmrc` names, and the owner decides what happens to the public package.
