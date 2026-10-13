# ADR-0006: Framework-free core, thin Nitro adapters, and the `/data` contract

- Status: Proposed
- Date: 2026-10-13

## Context

Both apps have the rule "`server/modules/*` are plain TS: no h3 or Nuxt imports". Domain modules receive a
`Logger` port and never import pino. The kit's code runs in four places:

1. **the launcher**, bundled by esbuild and run before Nitro is imported;
2. **`nuxt.config.ts`** at build time (the CSP builder, the default trusted proxies);
3. **Nitro plugins and middleware** at runtime;
4. **Vitest**, without a Nuxt build.

Attendance already keeps secret files next to the database in `secrets/`, under the one `/data` volume.
Existing installs depend on those exact names.

## Options considered

1. **Framework-free core plus a thin `/nitro` entry point.** (Chosen.) The core imports only Node built-ins
   and pino. `/nitro` imports the core and `h3`, and takes all configuration as arguments.
2. **Nitro-aware throughout.** Kit functions call `useRuntimeConfig()` and `useEvent()` themselves. It's
   convenient, but it can't run in the launcher or `nuxt.config.ts`, it needs Nitro's virtual `#imports`
   (unavailable to a published package), and it can't be tested without a Nuxt build.
3. **Core only, no adapters.** Each app writes its own h3 glue. The glue (JSON-only, body size, the
   headers plugin, the rate-limit guard, the error handler) is itself the security behaviour, and it
   would be copied again.

## Decision

### Boundaries

- **`@towerism/selfhost-kit` (core)** imports only `node:*`, `pino` and `pino-pretty`. It doesn't read
  `process.env`, except for the documented logger defaults (`NUXT_LOG_LEVEL`, `NUXT_LOG_FORMAT`,
  `NO_COLOR`) and `prepareRuntimeEnv`, which receives `env` as an argument. Its time dependency is
  injected (`Clock`).
- **`@towerism/selfhost-kit/nitro`** imports the core and `h3` only:
  - never `nitropack/runtime`, `#imports` or `nuxt`;
  - plugins are plain `(nitroApp) => void` functions, which the app wraps in `defineNitroPlugin`;
  - handlers are built with `h3`'s `defineEventHandler`;
  - nothing calls `useRuntimeConfig`: the app passes values.
- **`@towerism/selfhost-kit/testing`** may import Vitest and both of the above. It is never imported by
  production code (an ESLint rule in each app).
- **Domain modules in the apps keep depending on ports** (`Logger`, `Vault`, `Clock`), injected from
  `server/utils`. A module may import *types* from the kit, and `createVault` and `stringVault` are
  constructed in `server/utils`, never in a module.
- **Enforcement in the kit:**
  - ESLint `no-restricted-imports` on `src/core/**` (no `h3`, `nitropack`, `nuxt`, `#imports`, `vitest`)
    and on `src/nitro/**` (no `nitropack`, `nuxt`, `#imports`);
  - a test that imports the built core entry point in plain Node with no h3 installed.

### Errors

Each area has one error class (`VaultError`, `InvalidSecretError`, `InvalidConfigError`,
`InvalidTrustedProxiesError`). Messages are written for the operator reading the Unraid log. They never
contain a secret value, a key or a token: tests check that the input value is absent from the message.

### The `/data` contract

As in [architecture §6.2](../README.md#62-data-layout):

- The secrets directory is `dirname(NUXT_DATABASE_PATH)/secrets`: `0700`, files `0600`, created with
  `O_EXCL`.
- Env wins over the file. Malformed values fail startup and are never regenerated.
- Each app declares its own secret file names through `aes256Key({ env, file, label })`. The kit owns
  only `session-password` (through `sessionPassword()`). That's why attendance keeps `token-vault.key` and
  `tdf-vault.key` and Genie uses `vault.key`, without the kit knowing about either.
- The kit never deletes, renames or rewrites a secret file, and Litestream's config replicates only the
  database.

### AAD guidance (documented, not enforced beyond non-empty)

Bind each ciphertext to its row with `<table>:<row id>` (attendance: `pokemon_connection:<id>`,
`tdf_file:<league>:<sha256>`). Use one key per *recovery domain*: separate keys when losing one should not
lose the other. Attendance's token and TDF keys are such a pair (ADR-0012 there). One key with distinct
AAD prefixes is fine when the secrets share a fate, as Genie's three do.

## Consequences

- (+) Every piece runs in all four places, and the core's tests need no Nuxt.
- (+) Each app's security configuration is explicit in its own `server/` files and reviewable there.
- (+) The kit can't break an install's file layout, because it never chooses an app's file names.
- (−) A little wiring in each app: one-line middleware files and a `server/utils` factory. That is
  accepted, because the wiring is where the app shows its choices.
- (−) A Nitro 3 / h3 v2 upgrade needs a new `/nitro` (possibly `/nitro3` side by side for one major). The
  core is unaffected.
