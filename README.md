# selfhost-kit

Shared platform code for Towerism's self-hosted Nuxt 4 apps:
[play-pokemon-attendance-web](https://github.com/Towerism/play-pokemon-attendance-web) and Tournament Genie.

It holds the security-sensitive infrastructure both apps need, so that there is one copy of it and a fix
reaches both apps:

- an AES-256-GCM vault for secrets stored in SQLite;
- secret bootstrap (env first, else a file generated once under `/data/secrets/`) and the production
  launcher;
- a pino logger with redaction, and request ids;
- security headers and CSP, a rate limiter that knows about trusted proxies, and JSON-only and body-size
  guards;
- one-time setup codes;
- the container entrypoint (PUID/PGID, gosu, optional Litestream);
- reusable image and release workflows.

It ships as one npm package, `@towerism/selfhost-kit`, with a framework-free core and h3/Nitro adapters on
`@towerism/selfhost-kit/nitro`.

> **Status: architecture accepted (2026-10-13). No code yet.** Implementation starts with milestone K0.

## Read first

- [Architecture](docs/architecture/README.md): context, goals, the package layout, API sketches, the
  `/data` contract, how fixes reach both apps, the migration plan, risks and milestones.
- [Architecture Decision Records](docs/architecture/README.md#13-architecture-decision-records)
- [Follow-up issues for the apps](docs/architecture/follow-up-issues.md) (drafts)

## Scope

This package serves the two apps above. It is public, but its API follows their needs, and semver
promises cover only the documented API. It contains no secrets or deployment-specific values. Every key,
token or address in its tests is synthetic.

## License

[MIT](LICENSE)
