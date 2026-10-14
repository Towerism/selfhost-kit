# Releasing

Releases are automatic. Every push to `main` whose CI passes may publish a new version of
`@towerism/selfhost-kit` to npm, with provenance, and create the matching `vX.Y.Z` tag and GitHub
Release. Nobody runs `npm publish` or pushes a `v*` tag by hand. The one exception was the bootstrap below.

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

   | Commit                                                             | Release                                 |
   | ------------------------------------------------------------------ | --------------------------------------- |
   | `fix:`, `perf:`                                                    | patch                                   |
   | `feat:`                                                            | minor                                   |
   | breaking (`!` or `BREAKING CHANGE:`)                               | **minor** while in 0.x (major from 1.0) |
   | `docs:`, `test:`, `chore:`, `ci:`, `refactor:`, `build:`, `style:` | none                                    |

5. Before semantic-release runs, [`check-npm-trusted-publishing.mjs`](../scripts/check-npm-trusted-publishing.mjs)
   checks that npm is at least 11.5.1, the first npm that does the trusted-publishing OIDC exchange itself.
   An older npm fails the job there, before anything is tagged.
6. semantic-release verifies the OIDC exchange, **pushes the `vX.Y.Z` tag**, publishes the downloaded
   `dist/` to npm with npm trusted publishing, and then creates the GitHub Release. The tag goes out before
   the publish, so a failed publish leaves a tag behind (see below). `fix(security): …` commits are listed
   first, under **Security**, with their `Advisory: GHSA-…` linked.

## Credentials and permissions

There is no npm token anywhere: not in repository, environment or organisation secrets, not in any
workflow, and not on a maintainer's machine.

| What           | Where it comes from                           | Used for                                                                                |
| -------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| OIDC token     | `id-token: write` on the `release` job only   | npm trusted publishing and provenance                                                   |
| `GITHUB_TOKEN` | automatic, scoped by each job's `permissions` | the tag and GitHub Release (`contents: write`), the artifact download (`actions: read`) |

The `release` job runs in the `npm` environment, which only `main` may deploy to. There are no required
reviewers. That is deliberate ([ADR-0004](architecture/adr/0004-sharing-docker-and-ci.md)): a published
version reaches no user by itself, and the manual gates are each app's Renovate merge and the Unraid
_Update_ click.

npm side, for package `@towerism/selfhost-kit`:

- trusted publisher: GitHub Actions, repository `Towerism/selfhost-kit`, workflow `release.yml`,
  environment `npm` (check with `npm trust list @towerism/selfhost-kit`);
- publishing access: _Require two-factor authentication and disallow tokens_;
- the owner's npm account has 2FA for authorization and writes.

Renaming `release.yml`, the `npm` environment or the repository breaks publishing until the trusted
publisher is recreated.

## Rollback

npm never lets a version be published twice, and unpublishing is limited, so a bad release is rolled
forward:

1. Deprecate it: `npm deprecate @towerism/selfhost-kit@X.Y.Z "<what is wrong; use X.Y.Z+1>"`.
2. Merge the fix as a `fix:` commit. The pipeline publishes the next patch.
3. In each app, revert the Renovate PR that took the bad version if the fix isn't out yet.

## When a release fails

| Symptom                                                           | Cause                                                                                                                          | Recovery                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `release` job was skipped                                     | CI didn't succeed, the run wasn't a push, or it came from a fork                                                               | Nothing to do; fix CI and push again                                                                                                                                                                                                               |
| "main is at …, not …: the newer commit's run will release"        | A newer commit landed                                                                                                          | Nothing to do; that commit's run releases                                                                                                                                                                                                          |
| npm auth error (E401/E403/E404, "OIDC") before any tag is pushed  | Trusted publisher missing, expired (npm voids an unused new configuration after 2 days) or misnamed                            | `npm trust list @towerism/selfhost-kit`; if wrong, `npm trust revoke` it and recreate it as below, then re-run the job                                                                                                                             |
| npm E422 about provenance                                         | `repository.url` in `package.json` doesn't match this repository                                                               | Fix it in a `fix:` commit                                                                                                                                                                                                                          |
| "can't publish with OIDC: trusted publishing needs npm >= 11.5.1" | The runner's Node bundles an npm older than 11.5.1                                                                             | Nothing was tagged or published. Make `.node-version` resolve to a Node 24 that bundles npm 11.5.1 or later, then re-run the job                                                                                                                   |
| OIDC verified, then `npm publish` fails with `ENEEDAUTH`          | An npm older than 11.5.1 ran the publish (the check above was skipped or removed). This is how `0.1.0` first failed (issue #9) | The tag was pushed. If `npm view @towerism/selfhost-kit@X.Y.Z version` returns 404, delete the `vX.Y.Z` tag, restore the check or fix npm, then re-run the job                                                                                     |
| `pnpm install` failed                                             | Registry or network outage                                                                                                     | Re-run the job. Nothing was published                                                                                                                                                                                                              |
| npm publish failed after the tag was pushed                       | Registry outage mid-release                                                                                                    | If `npm view @towerism/selfhost-kit@X.Y.Z version` returns 404, delete the `vX.Y.Z` tag (and its GitHub Release if one exists) and re-run the job. If the version is on npm, only the GitHub Release is missing: re-run, or create it from the tag |
| Nothing was released and the job succeeded                        | No releasable commit since the last tag                                                                                        | Expected                                                                                                                                                                                                                                           |

## Bootstrap (done once, in K0)

npm can only attach a trusted publisher to a package that already exists, so the first version was
published by hand as an empty placeholder, and CI published the first real version.

1. Confirm the `towerism` npm account or organisation exists and has 2FA for authorization and writes:
   `npm profile get` shows `two-factor auth: auth-and-writes`.
2. In an empty folder outside this repository, create the placeholder and publish it with an interactive
   login, then log out, which revokes the session token:

   ```sh
   cat > package.json <<'EOF'
   {
     "name": "@towerism/selfhost-kit",
     "version": "0.0.0",
     "description": "Placeholder that bootstraps npm trusted publishing. Use >=0.1.0.",
     "license": "MIT",
     "repository": { "type": "git", "url": "git+https://github.com/Towerism/selfhost-kit.git" }
   }
   EOF
   echo "Placeholder that bootstraps npm trusted publishing. Use @towerism/selfhost-kit >=0.1.0." > README.md
   npm login
   npm publish --access public
   npm logout
   npm token list   # expect no token left from this
   ```

3. No more than 2 days before step 5, attach the trusted publisher (npm 11.15 or later):

   ```sh
   npm trust github @towerism/selfhost-kit --repo Towerism/selfhost-kit --file release.yml --env npm --allow-publish
   npm trust list @towerism/selfhost-kit
   ```

4. Tag the last commit on `main` before the K0 merge as `v0.0.0`, so semantic-release's first release is
   `0.1.0` and not `1.0.0`. This is the single hand-pushed `v*` tag the project allows
   ([ADR-0005 amendment](architecture/adr/0005-versioning-and-security-fixes.md#amendment-2026-10-13-the-v000-bootstrap-tag)).

   ```sh
   git tag v0.0.0 <last main commit before K0> && git push origin v0.0.0
   ```

5. Merge the K0 pull request. `release.yml` publishes `0.1.0` with provenance.
6. Lock it down: set the package's publishing access to _Require two-factor authentication and disallow
   tokens_, and deprecate the placeholder:

   ```sh
   npm deprecate @towerism/selfhost-kit@0.0.0 "Bootstrap placeholder for trusted publishing; use >=0.1.0"
   ```
