# Security policy

`@towerism/selfhost-kit` holds the security-sensitive code of two self-hosted apps: the secret vault, the
secret bootstrap, log redaction and the security middleware. A flaw here affects both apps at once, so
reports are welcome and treated as a priority.

## Reporting a vulnerability

**Please don't open a public issue, pull request or discussion for a vulnerability.**

Report it privately through GitHub's private vulnerability reporting:
[open a draft security advisory](https://github.com/Towerism/selfhost-kit/security/advisories/new).

Include what you can: the affected version, the entry point or file, a description of the impact, and
steps or a test that reproduces it. Use synthetic values only: never send a real key, token or personal
data.

## What to expect

- An acknowledgement within **3 days**.
- An assessment (confirmed, needs more information, or not a vulnerability) within **7 days**.
- For a confirmed issue, a fix released within **14 days** for high or critical severity, and with the next
  release otherwise. We keep you updated in the advisory and credit you in it unless you'd rather not be
  named.

This is a one-maintainer project, so these are targets rather than guarantees.

## Supported versions

| Version                           | Supported                                                         |
| --------------------------------- | ----------------------------------------------------------------- |
| Latest minor of the current major | Yes                                                               |
| Previous major                    | Security fixes only, for 90 days after the next major is released |
| Anything older                    | No                                                                |

Consumers pin an exact version, and Renovate proposes each bump: patches and minors can automerge, majors
never do.

## How a fix is released

1. The fix is prepared in a private fork of the advisory, so it isn't public before it ships.
2. It's committed as `fix(security): …` with an `Advisory: GHSA-…` footer.
3. Merging it publishes a patch release to the Gitea npm registry from CI. Its release notes list it first,
   under **Security**.
4. The advisory is then published with the patched version range, so GitHub and Renovate flag vulnerable
   lockfiles in the apps.

The full policy is in [ADR-0005](docs/architecture/adr/0005-versioning-and-security-fixes.md).
