# Releasing

Releases are automatic. Every push to `main` whose CI passes may publish a new version of
`@towerism/selfhost-kit` to the Gitea npm registry ([ADR-0009](architecture/adr/0009-gitea-npm-registry.md)),
and create the matching `vX.Y.Z` tag and GitHub Release. Nobody runs `npm publish` or pushes a `v*` tag by hand.

## How a release happens

1. A pull request merges into `main`. The `main` ruleset requires the `check` and `secret-scan` jobs of
   [`ci.yml`](../.github/workflows/ci.yml) to pass first.
2. `ci.yml` runs again on the push and uploads the `dist/` it built and tested as the `dist` artifact.
3. When that whole run succeeds (including the `sample-caller` job, which builds the fixture image and
   runs the entrypoint's container tests), [`release.yml`](../.github/workflows/release.yml) starts. It runs only for a
   successful `push` run from this repository, and only if that commit is still the head of `main`. An
   older run steps aside, and the newer commit's run releases everything since the last tag.
4. semantic-release ([`release.config.mjs`](../release.config.mjs)) reads the Conventional Commits since
   the last tag and picks the version:

   | Commit                                                             | Release |
   | ------------------------------------------------------------------ | ------- |
   | `fix:`, `perf:`                                                    | patch   |
   | `feat:`                                                            | minor   |
   | breaking (`!` or `BREAKING CHANGE:`)                               | major   |
   | `docs:`, `test:`, `chore:`, `ci:`, `refactor:`, `build:`, `style:` | none    |

5. Before semantic-release runs, the job points npm at the Gitea registry with a userconfig outside the
   repository. The token line names `${GITEA_PACKAGE_TOKEN}` and holds no secret. Then the job makes one
   write request with the publish token and an empty body. The registry answers 400 for a write-scoped
   token. Any other answer stops the job there, before anything is tagged.
6. semantic-release **pushes the `vX.Y.Z` tag**, publishes the downloaded `dist/` to the Gitea registry,
   and then creates the GitHub Release. The tag goes out before the publish, so a failed publish leaves a
   tag behind (see the table below). `fix(security): …` commits are listed first, under **Security**, with
   their `Advisory: GHSA-…` linked.

## The API report

`api/*.api.md` lists every export and the reusable workflows' interface ([ADR-0005](architecture/adr/0005-versioning-and-security-fixes.md)).
CI's `pnpm api:check` fails when it doesn't match the build. After an API change, run
`pnpm build && pnpm api:report` and commit `api/`, so the change shows in the PR's diff. When the diff
removes or changes an existing entry, the commit is breaking and needs a `BREAKING CHANGE:` footer.

The report is printed by TypeScript, so a TypeScript update can change how a declaration is written
without changing the API. If `api:check` fails on a Renovate PR for `typescript`, regenerate `api/`, check
that the diff is only cosmetic, and commit it to that PR.

## Credentials and permissions

| What           | Where it is set                                                                   | Used for                                                                                |
| -------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Publish token  | GitHub repository secret `GITEA_PACKAGE_TOKEN` (Settings → Secrets and variables) | the write probe and `npm publish`, in `release.yml` only                                |
| Read token     | consumers' CI secret and Docker build secret `NPM_READ_TOKEN`                     | `pnpm install` of `@towerism/selfhost-kit` in each app                                  |
| `GITHUB_TOKEN` | automatic, scoped by each job's `permissions`                                     | the tag and GitHub Release (`contents: write`), the artifact download (`actions: read`) |

No npm token exists anywhere else: not in the repository, not in an organisation secret, not in a workflow
file, and not on a maintainer's machine. The `release` job has no OIDC permission, and nothing in the
repository holds a token value.

The `release` job runs in the `npm` environment, which only `main` may deploy to. The publish token is a
repository secret, so the environment doesn't gate it; the job's branch rule and `if` condition do. There are no required
reviewers. That is deliberate ([ADR-0004](architecture/adr/0004-sharing-docker-and-ci.md)): a published
version reaches no user by itself, and the manual gates are each app's Renovate merge and the Unraid
_Update_ click.

### Publish token: setup and checks

Verified over SSH on 2026-10-22 with a read-only query of the Gitea database (no token values read):

- The dedicated user is `ci-publisher`. It has one token, named `registry`, with scope `write:package`
  only. Its only team is `publishers` in `towerism`, which has package write. It owns no packages and
  has no collaborator rows, so the token can write packages only through `towerism`.
- The token was created on 2026-10-22. Its name suggests it may also serve container pushes. Confirm
  that before you reuse it; a new token for npm only is the cleaner choice.

Set it up:

1. In Gitea, sign in as `ci-publisher`, open **Settings → Applications**, and create a token with only the
   `write:package` scope. Copy it once.
2. In GitHub, open `Towerism/selfhost-kit` **Settings → Secrets and variables → Actions**, and set the
   repository secret `GITEA_PACKAGE_TOKEN` to that value.
3. Record the creation date in the table under [Rotation](#rotation).

### Check both tokens against the registry

After you create or rotate a token, run this from a machine that can SSH to the Gitea VM as root:

```sh
GITEA_SSH='ssh -p 2222 root@192.168.0.39' pnpm check:registry-tokens
```

Gitea keeps only hashes, and GitHub secrets can't be read back, so the script can't fetch the stored
tokens. It creates a short-lived one for each user on the VM instead: `write:package` for `ci-publisher` and
`read:package` for `pull`, with `gitea admin user generate-access-token`. That command ignores two-factor
authentication, which Gitea's token API does not (it refuses basic authentication for an account with a
WebAuthn key, and for any account without a one-time code).

For each token, the script sends an HTTP PUT request with an empty body to the package's route on the
Gitea registry, so no package is created. Then it deletes the token with one `DELETE` on the
`access_token` table of `/var/lib/gitea/data/gitea.db`, limited to the name it created, and checks that no
row with that name remains. It deletes even when the probe fails. If a delete fails, the script names the
token and you remove it under **Settings → Applications** for that user.

The publish token must get 400: it can write, and the empty body holds no package. The read token must get
401 or 403. The exit code is 0 only when both answers match. The script prints no token and follows no
redirect.

This proves the scopes and the route, not the values stored in GitHub or on Unraid. To test those values,
leave `GITEA_SSH` unset and set `GITEA_PACKAGE_TOKEN` and `NPM_READ_TOKEN` instead.

### Read token: consumers

Each app that installs `@towerism/selfhost-kit` needs a read token. The `pull` user's token named `read`
(scope `read:package`) is the one already in use for Unraid's registry login. Its owner and scope were checked
over SSH on 2026-10-22, and the Unraid use comes from [#41](https://github.com/Towerism/selfhost-kit/issues/41). Using it for npm means a
rotation of that token also affects Unraid. A separate npm read token avoids that coupling; the owner decides.

Consumer `.npmrc` (commit this; it holds no token):

```ini
@towerism:registry=https://vcs.martinfrackerjr.com/api/packages/towerism/npm/
//vcs.martinfrackerjr.com/api/packages/towerism/npm/:_authToken=${NPM_READ_TOKEN}
```

- CI: set `NPM_READ_TOKEN` as a repository secret of the app, and pass it to the install step as an
  environment variable.
- Docker build: pass it as a BuildKit secret, never as a build argument:

  ```dockerfile
  RUN --mount=type=secret,id=npm_read_token \
      NPM_READ_TOKEN="$(cat /run/secrets/npm_read_token)" pnpm install --frozen-lockfile
  ```

  and build with `docker build --secret id=npm_read_token,env=NPM_READ_TOKEN .`.

- Local: put `NPM_READ_TOKEN` in your shell environment. Never write it into `.npmrc`.

Without the token, `pnpm install` fails with a 401 for the `@towerism` scope. It does not fall back to
public npm.

### Rotation

Gitea access tokens do not expire on their own. The owner rotates both tokens within 365 days of creation.
Put the due date in the calendar when you create a token.

| Token                | Owner          | Scope           | Created    | Rotate by  |
| -------------------- | -------------- | --------------- | ---------- | ---------- |
| Publish (`registry`) | `ci-publisher` | `write:package` | 2026-10-22 | 2027-10-22 |
| Read (`read`)        | `pull`         | `read:package`  | 2026-10-22 | 2027-10-22 |

To rotate a token:

1. Create the new token as above, with the same owner and scope.
2. Update the GitHub secret (publish) or the consumers' secrets (read).
3. Run the release job or an install, and check it works.
4. Revoke the old token in Gitea, and update the table.

## Package name on public npm

`@towerism/selfhost-kit` is already published on public npm, with versions `0.0.0` through `1.0.0`. The
last one, `1.0.0`, was published by the release job before this change. The Gitea registry starts empty,
and consumers that still install from public npm stay on `1.0.0`. The owner decides what happens to the
public package; this change does not touch it.

The first Gitea release continues the git tag history. The next version after the `v1.0.0` tag is published
to the Gitea registry, not to public npm.

## Rollback

npm never lets a version be published twice, and unpublishing is limited, so a bad release is rolled
forward:

1. Deprecate it: `npm deprecate @towerism/selfhost-kit@X.Y.Z "<what is wrong; use X.Y.Z+1>"`, with the
   Gitea registry configured in `.npmrc`.
2. Merge the fix as a `fix:` commit. The pipeline publishes the next patch.
3. In each app, revert the Renovate PR that took the bad version if the fix isn't out yet.

## When a release fails

| Symptom                                                            | Cause                                                                       | Recovery                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `release` job was skipped                                      | CI didn't succeed, the run wasn't a push, or it came from a fork            | Nothing to do; fix CI and push again                                                                                                                                                                                                                        |
| "main is at …, not …: the newer commit's run will release"         | A newer commit landed                                                       | Nothing to do; that commit's run releases                                                                                                                                                                                                                   |
| "Publish token refused" from the write probe, before any tag       | `GITEA_PACKAGE_TOKEN` missing, revoked, expired or without `write:package`  | Check the secret, then the token in Gitea. Create a new one as in [Publish token](#publish-token-setup-and-checks) if needed, and re-run the job. Nothing was tagged or published                                                                           |
| npm refuses the publish after the tag was pushed (401, 403 or 404) | Registry outage, or the token was revoked between the probe and the publish | If `npm view @towerism/selfhost-kit@X.Y.Z version` (with the Gitea registry configured) returns 404, delete the `vX.Y.Z` tag and its GitHub Release, then re-run the job. Or publish the tagged commit by hand with the publish token                       |
| `pnpm install` failed                                              | Registry or network outage                                                  | Re-run the job. Nothing was published                                                                                                                                                                                                                       |
| npm publish failed after the tag was pushed                        | Registry outage mid-release                                                 | If `npm view @towerism/selfhost-kit@X.Y.Z version` returns 404, delete the `vX.Y.Z` tag (and its GitHub Release if one exists) and re-run the job. If the version is on the registry, only the GitHub Release is missing: re-run, or create it from the tag |
| Nothing was released and the job succeeded                         | No releasable commit since the last tag                                     | Expected                                                                                                                                                                                                                                                    |

The recovery steps need the publish token on the machine that does them, so keep the token in the password
manager and not only in the GitHub secret.

## Retiring the GitHub copy (at the CI move)

This section applies when the CI moves to Gitea ([#41](https://github.com/Towerism/selfhost-kit/issues/41), step 4).
Until then, the GitHub copy's `release.yml` is the release job, and it is the only one that releases.

1. Move the release job to Gitea Actions with the rest of CI. Its release plugin then reads `GITEA_TOKEN`,
   which it gets from the job's built-in Gitea Actions token.
2. Disable the GitHub copy's `release.yml` in the same change set. Two copies must not release.
3. Remove the npm trusted-publisher entry for `@towerism/selfhost-kit` on npmjs.com (`npm trust revoke`).
