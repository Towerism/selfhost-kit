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

> **Status: K0 (repo foundation) delivered. No API yet.** The package, its toolchain, CI and the release
> pipeline are in place, and the entry points are empty until milestone K1 (core) and K2 (Nitro adapters).

## Install

```sh
pnpm add --save-exact @towerism/selfhost-kit
```

Requires Node 24.11 or later. The package is ESM only. `h3` (for `/nitro`) and `vitest` (for `/testing`)
are optional peer dependencies. While the kit is in `0.x`, pin an exact version: a minor release may break.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md). Don't open a public issue.

## Read first

- [Architecture](docs/architecture/README.md): context, goals, the package layout, API sketches, the
  `/data` contract, how fixes reach both apps, the migration plan, risks and milestones.
- [Architecture Decision Records](docs/architecture/README.md#13-architecture-decision-records)
- [Follow-up issues for the apps](docs/architecture/follow-up-issues.md) (drafts)
- [Releasing](docs/releasing.md): how versions are published, the credentials involved (none stored),
  rollback, and what to do when a release fails

## Development

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test   # test includes the coverage gate
pnpm build && pnpm check:package && pnpm test:package
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): they decide the next version.

## Scope

This package serves the two apps above. It is public, but its API follows their needs, and semver
promises cover only the documented API. It contains no secrets or deployment-specific values. Every key,
token or address in its tests is synthetic.

## License

[MIT](LICENSE)
