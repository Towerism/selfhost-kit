# Adopting `@towerism/selfhost-kit`

How a self-hosted Nuxt 4 app takes the kit on, piece by piece, and how an app on 0.4.x upgrades to 1.0.
Every snippet uses the exports listed in [`api/`](../api), which is the authoritative signature list. The
examples follow Tournament Genie, which used the kit from its first commit. Attendance migrated onto it
step by step ([ADR-0007](architecture/adr/0007-migration.md)).

## Requirements

- Node 24.11 or later, ESM only ([ADR-0003](architecture/adr/0003-single-package-on-npm.md)).
- pnpm with its default isolated `node_modules`. pnpm's global virtual store (`enable-global-virtual-store`)
  and Yarn PnP can't resolve `/testing`'s and `/release-config`'s tools from the kit (see
  [Install and pin](#install-and-pin)).
- Nuxt 4 on Nitro 2, which brings h3 1.x. `@towerism/selfhost-kit/nitro` targets h3 `^1.15`.
- The app's data in one volume: the database at `NUXT_DATABASE_PATH` (`/data/app.db` in the image), and the
  kit keeps its secrets next to it in `secrets/` ([ADR-0006](architecture/adr/0006-api-boundaries.md)).

## Install and pin

```sh
pnpm add --save-exact @towerism/selfhost-kit
```

What each entry point needs in the app:

| Entry point                             | Needs                                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@towerism/selfhost-kit`                | nothing (it depends on `pino` and `pino-pretty` itself)                                                          |
| `@towerism/selfhost-kit/nitro`          | `h3`, which Nitro brings                                                                                         |
| `@towerism/selfhost-kit/testing`        | `vitest` and `h3` in devDependencies                                                                             |
| `@towerism/selfhost-kit/release-config` | `semantic-release`, `@semantic-release/exec` and `conventional-changelog-conventionalcommits` in devDependencies |

Pin an exact version and let Renovate propose every bump. Group the package with the reusable workflows'
commit SHA, as in [docs/ops-assets.md](ops-assets.md#renovate-in-each-app), so the npm version and the
workflow pin move together. Patches and minors can automerge once the app's CI is green. **Majors are
never automerged**: they come with an _Upgrading_ section like the one below.

## Secrets and the launcher

Declare the app's secrets once. The kit owns only `session-password`. Every other file name is the app's,
and it's part of the install contract, so never rename one.

```ts
// server/bootstrap/secrets.ts
import { aes256Key, sessionPassword } from '@towerism/selfhost-kit';

export const SECRETS = [
  sessionPassword(),
  aes256Key({ env: 'NUXT_VAULT_KEY', file: 'vault.key', label: 'Vault key' }),
] as const;
```

The launcher works out the env before Nitro loads, because Nitro reads its runtime config once, at import.
Pass it the app's own logger: it never builds one itself, since that logger would hide only the base keys.

```ts
// server/bootstrap/launcher.ts, bundled to .output/launcher.mjs
import { type Env, prepareRuntimeEnv, runLauncher } from '@towerism/selfhost-kit';
import { createAppLogger } from '../utils/logger';
import { SECRETS } from './secrets';

const RATE_LIMIT_VARS = ['NUXT_AUTH_RATE_LIMIT_LOGIN_MAX', 'NUXT_AUTH_RATE_LIMIT_LOGIN_WINDOW_MS'];

await runLauncher({
  prepare: (env: Env) => prepareRuntimeEnv(env, { secrets: SECRETS, positiveIntegerVars: RATE_LIMIT_VARS }),
  server: new URL('./server/index.mjs', import.meta.url),
  logger: createAppLogger('startup'),
});
```

- Env wins over the file.
- A missing file is generated once (`0600`, in a `0700` directory).
- A malformed value stops startup with a message naming where it came from, and it is never regenerated.
- `positiveIntegerVars` must be whole numbers from 1 to 9007199254740991. Blank ones are removed.
- `validate(env)` runs the app's own checks; throw `InvalidConfigError` from it.

## Logging

Build one redactor with the app's extra keys, and pass it to every logger. `createLogger` refuses to build
without one.

```ts
// server/utils/logger.ts
import { type Logger, createLogger, createRedactor, secretKeyNames } from '@towerism/selfhost-kit';
import { SECRETS } from '../bootstrap/secrets';

export const redactor = createRedactor({
  extraKeys: ['content', 'notes', 'botToken', ...secretKeyNames(SECRETS)],
});

export function createAppLogger(scope: string): Logger {
  return createLogger({ scope, redactor });
}
```

The format comes from `NUXT_LOG_FORMAT` (`pretty` by default, or `json`), and the level from
`NUXT_LOG_LEVEL`. The pretty line, the request line and the setup-code line are public API
([ADR-0005](architecture/adr/0005-versioning-and-security-fixes.md)). Base keys can only be added to, never
removed.

## Security headers and CSP

nuxt-security nonces the HTML shell. Give it the kit's CSP, plus the app's additions, and the kit's
`Permissions-Policy`, so the shell carries the same policy as every other response (those get theirs from
`securityHeadersPlugin`, below):

```ts
// shared/csp.ts: the app's CSP additions, given to both nuxt-security and the kit's plugin
export const EXTRA_CSP = { 'img-src': ['https://cdn.discordapp.com'] };
```

```ts
// nuxt.config.ts
import { contentSecurityPolicy, securityHeaders } from '@towerism/selfhost-kit';
import { EXTRA_CSP } from './shared/csp';

const permissions = securityHeaders({ httpsSite: false })['Permissions-Policy']!;

export default defineNuxtConfig({
  modules: ['nuxt-security'],
  security: {
    nonce: true,
    headers: {
      contentSecurityPolicy: contentSecurityPolicy({ httpsSite: false, nonce: true, extra: EXTRA_CSP }),
      strictTransportSecurity: false, // the kit's plugin turns HSTS on for an https site
      permissionsPolicy: Object.fromEntries(permissions.split(', ').map((p) => [p.split('=')[0]!, []])),
    },
    // The kit's guards replace these.
    rateLimiter: false,
    requestSizeLimiter: false,
  },
});
```

`extra` adds sources to a directive. It can never remove one of the base policy's. `DEFAULT_TRUSTED_PROXIES`
(loopback and Docker's default bridge pool) is the default for `NUXT_TRUSTED_PROXIES`.

## Nitro middleware, plugins and error handler

Each piece is one line in its own file. The adapters take configuration as arguments and never call
`useRuntimeConfig` themselves.

```ts
// server/middleware/01.json-only.ts: 415 for a non-JSON body on a state-changing /api request
import { jsonOnly } from '@towerism/selfhost-kit/nitro';
export default jsonOnly();
```

```ts
// server/middleware/02.body-size.ts: 413 over the limit; `exempt` takes path regexes
import { bodySizeLimit } from '@towerism/selfhost-kit/nitro';
export const MAX_BODY_BYTES = 1_048_576;
export default bodySizeLimit({ maxBytes: MAX_BODY_BYTES });
```

```ts
// server/plugins/00.security-headers.ts: the kit's headers on every response; HSTS only for an https site
import { securityHeadersPlugin } from '@towerism/selfhost-kit/nitro';
import { EXTRA_CSP } from '../../shared/csp';
export default defineNitroPlugin(
  securityHeadersPlugin({ siteUrl: useRuntimeConfig().public.siteUrl, extraCsp: EXTRA_CSP }),
);
```

Pass the same `EXTRA_CSP` here as in `nuxt.config.ts`. The plugin also sets the HTML shell's CSP through
nuxt-security, so additions missing here are missing everywhere.

```ts
// server/plugins/00.logging.ts: request ids and one log line per request (createAppLogger from server/utils)
import { requestLogPlugin } from '@towerism/selfhost-kit/nitro';
export default defineNitroPlugin(requestLogPlugin({ logger: createAppLogger('http') }));
```

```ts
// server/error.ts: JSON errors keep the app's security headers
import { jsonErrorHandler } from '@towerism/selfhost-kit/nitro';
export default defineNitroErrorHandler(jsonErrorHandler());
```

Rate limiting is a guard the route calls. It needs a limiter built once and the trusted proxies, so that
the client address it counts is the real one:

```ts
// server/utils/rate-limit.ts
import { createFixedWindowLimiter, parseTrustedProxies, systemClock } from '@towerism/selfhost-kit';
import { enforceRateLimit } from '@towerism/selfhost-kit/nitro';
import type { H3Event } from 'h3';

const limiter = createFixedWindowLimiter({ max: 5, windowMs: 60_000, clock: systemClock });
const trusted = parseTrustedProxies(useRuntimeConfig().trustedProxies);

export const limitLogin = (event: H3Event) => enforceRateLimit(event, { limiter, trusted }); // 429 + Retry-After
```

## The vault

Construct vaults in `server/utils`, never in a domain module. Modules depend on the `Vault` or
`StringVault` port.

```ts
// server/utils/vault.ts
import { type StringVault, createVault, stringVault } from '@towerism/selfhost-kit';

export const useVault = (): StringVault =>
  stringVault(createVault({ key: useRuntimeConfig().vaultKey, label: 'vault' }));
```

- Bind every ciphertext to its row with a non-empty AAD such as `<table>:<row id>`
  (`setting:discord_bot_token`). An empty AAD is refused.
- Use one key per _recovery domain_: separate keys when losing one must not lose the other
  ([ADR-0006](architecture/adr/0006-api-boundaries.md#aad-guidance-documented-not-enforced-beyond-non-empty)).
- A wrong key, a wrong AAD or a tampered blob throws `VaultError`, and its message never contains the key.

## Contract suites

The app runs the kit's suites against its own configuration, instead of repeating the kit's unit tests:

```ts
// test/unit/kit-contracts.test.ts
import { createVault } from '@towerism/selfhost-kit';
import {
  describeBodySize,
  describeJsonOnly,
  describeRedactionContract,
  describeVaultContract,
} from '@towerism/selfhost-kit/testing';
import jsonOnlyMiddleware from '../../server/middleware/01.json-only';
import bodySizeMiddleware, { MAX_BODY_BYTES } from '../../server/middleware/02.body-size';
import { redactor } from '../../server/utils/logger';

describeJsonOnly(jsonOnlyMiddleware);
describeBodySize(bodySizeMiddleware, { maxBytes: MAX_BODY_BYTES });
describeVaultContract('vault', () =>
  createVault({ key: Buffer.alloc(32, 7).toString('base64'), label: 'vault' }),
);
describeRedactionContract(redactor, { mustHide: ['botToken', 'NUXT_VAULT_KEY'], mustShow: ['userId'] });
```

- `exemptPaths` in `describeJsonOnly` and `describeBodySize` are concrete request paths the suite sends. Each
  must be matched by the middleware's `exempt` regexes.
- `describeSecurityHeaders` checks the headers plugin.
- `tempSecretsDir()` and `existingInstallSecrets()` build a `/data` with or without secret files.
- `fakeClock()` drives the limiter and the request log, and `h3TestApp()` is an in-memory Nitro-like app.

Never import `/testing` from production code.

## Docker assets, workflows and releases

These are in [docs/ops-assets.md](ops-assets.md):

- the Dockerfile lines that copy the entrypoint and Litestream assets with `selfhost-kit docker-assets`;
- the CI jobs that call the reusable `app-image.yml` and `app-release.yml`, pinned by commit SHA;
- the `.releaserc.json` that extends `@towerism/selfhost-kit/release-config`;
- the Renovate group.

The image's tags (`edge`, `sha-…`, `X.Y.Z`, `X.Y`, `latest`) all name the digest the smoke tests ran on.

## Upgrading from 0.4.x

1.0 freezes the API that both apps migrated onto. These are its breaking changes; each is one edit:

1. **Positive-integer env vars:** `prepareRuntimeEnv` refuses a `positiveIntegerVars` value above
   9007199254740991, which the rate limiter couldn't use anyway. Its message for any refused value is now
   `NAME must be a whole number from 1 to 9007199254740991 (got "…").`, so update tests that match the old
   `… of at least 1 …`. A value of 2^53 or more used to pass startup and fail later, when the limiter was
   built; it now fails at startup with this message, so a test that pinned the later failure (attendance's
   `test/server/request-limits.test.ts`) expects this message instead. Accepted values are passed on trimmed.
2. **Peer dependencies:** `vitest`, `semantic-release`, `@semantic-release/exec` and
   `conventional-changelog-conventionalcommits` are no longer peer dependencies; only `h3` is. Keep them
   in the app's devDependencies (see [Install and pin](#install-and-pin)). Remove the `pnpm.auditConfig`
   `ignoreGhsas` entries added for vitest's tinypool advisories.
3. **Required redactor and logger:** `createLogger` requires `redactor`. Pass the app's
   `createRedactor({ extraKeys })`, or `createRedactor()` for the base keys only. `runLauncher` requires
   `logger`, the app's own: Genie's launcher passed none, and attendance already passed `createAppLogger`.
4. **Logger option types:** `createLogger`'s `level` is a `LogLevel` and `format` a `LogFormat`. A raw
   string from config needs validating or casting first.
5. **Nitro type names:** `@towerism/selfhost-kit/nitro` no longer exports `NitroAppLike`,
   `DefaultErrorResponse` or `DefaultErrorHandler`. Use `NitroAppPlugin` and `JsonErrorHandler`, or
   Nitro's own types.

Then bump the reusable workflows' SHA pin to the 1.0.0 commit in the same Renovate PR.

## What the public API is

[ADR-0005](architecture/adr/0005-versioning-and-security-fixes.md) defines it:

- every export of `.`, `./nitro`, `./testing` and `./release-config`;
- the vault blob format and AAD rules;
- the secret file conventions;
- the env names the kit reads;
- the entrypoint's behaviour;
- the reusable workflows' inputs and outputs;
- the three log line formats.

[`api/`](../api) lists the exports and the workflows' interface. CI fails when it doesn't match the
build, so any change to it shows in a pull request's diff. From 1.0, removing or changing any of it is a
major release.
