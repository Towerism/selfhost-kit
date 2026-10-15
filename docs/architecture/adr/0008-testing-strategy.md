# ADR-0008: Testing strategy — KATs, contract suites the apps run, fake clock

- Status: Accepted (2026-10-13); sketches corrected 2026-10-14 (K5, #31)
- Date: 2026-10-13

## Context

The kit's code is the most security-sensitive code in both apps, and a mistake reaches both
([ADR-0001](0001-share-as-a-package.md)). Attendance already has strong tests for these pieces
(≈1,060 lines of unit tests, server tests against the built app, container smoke tests). Some of them move
here, and some stay as integration evidence in the app.

This strategy applies the senior-qa references (testing strategies, QA best practices, automation
patterns) and the api-test-suite-builder matrices to the kit. Each issue's spec turns it into a concrete
test plan, with the same skills applied again there.

## Options considered

1. **Kit tests only.** The kit's own suite is the only proof. But an app's *configuration* (its redaction
   extras, its exempt paths, its secret specs) would go untested, and that is where an app can undo the
   kit's safety.
2. **App tests only.** Each app keeps its tests and the kit has few. This duplicates effort, and the kit
   has no proof of its own.
3. **Kit tests for behaviour, plus contract suites in `/testing` that each app runs against its own
   configuration, plus each app's existing integration tests.** (Chosen.)

## Decision

### Pyramid placement

| Area | Level | Why there |
| ---- | ----- | --------- |
| Vault, string vault | Unit (KATs, properties) | Pure function of key, AAD and blob |
| Secret resolution | Unit on a real temp filesystem | Behaviour *is* files and modes; no fs mocks |
| `prepareRuntimeEnv` | Unit (env in, env out) | Pure apart from secret files |
| `runLauncher` | Integration: a child process running a stub server entry | Exit codes and the order of env vs import can only be seen in a real process |
| Logger, redaction, request id | Unit, with an injected destination | Read the emitted lines |
| CSP/headers, limiter, client address, setup code | Unit | Pure; the limiter uses a fake clock |
| `/nitro` adapters | Integration through a **real in-memory h3 app** (`createApp` + `toWebHandler`, `fetch`-style requests) | Asserts status, headers and body, the way a browser sees them |
| Docker assets | Container tests on a fixture image in CI; non-root shell tests locally | Ownership and privilege drop need root in a container |
| Reusable workflows | A sample caller run on every kit PR (publishing off) | The only way to see a workflow run |
| Browser journeys | **None in the kit.** They stay in each app's Playwright suite | The kit has no UI; the critical journeys (setup, login) belong to the apps |

### Crypto known-answer tests

- **Fixed vectors** in `test/vectors/vault-v1.json`: synthetic key, IV, AAD, plaintext and the expected
  blob bytes. `open` must return the plaintext. The vectors are produced by an **independent reference**
  (WebCrypto `subtle.encrypt` AES-GCM framed into the v1 layout by a separate script), so the
  implementation is never its own oracle. A few NIST AES-256-GCM test cases are included in the v1
  framing, to pin the primitive itself.
- **Attendance's golden blob** (the all-7s key, `default` AAD) is a vector, so "unchanged on the wire"
  stays proven after attendance's test file is deleted.
- **`seal` is never given a fixed IV**, not even in tests. Nothing exported lets a caller choose an IV,
  because that would be a footgun. Instead, `seal` is checked by:
  - layout (version 1, 12 + 16 header, length);
  - freshness (two seals differ);
  - opening with the WebCrypto reference.
- **Refusals**, each must throw `VaultError`:
  - every single-bit flip in a sample blob, in the header, the tag and the ciphertext;
  - a truncated blob at every length up to the header size;
  - an unknown version, the wrong key, the wrong AAD, an empty AAD;
  - keys of 0, 16, 31 and 33 bytes, and non-base64 keys.

  Error messages never contain the key, AAD or plaintext (asserted).
- **Rollback compatibility** ([ADR-0005](0005-versioning-and-security-fixes.md) rule 2): CI installs the
  previous published version under an npm alias and checks that it opens blobs sealed by the current
  build, and the reverse.

### Contract suites the apps run (`@towerism/selfhost-kit/testing`)

- `describeVaultContract(name, makeVault)`: round trip, AAD binding, tamper refusal, against the vault exactly as
  the app constructs it.
- `describeRedactionContract(redactor, { mustHide, mustShow })`:
  - for each key in `mustHide`, at any depth, in any case and with `_`/`-` variants, in messages
    (`name=…`, `"name":"…"`, `Bearer …`), in error messages, stacks and causes, the value never appears;
  - for each key in `mustShow`, the value appears;
  - the base list is always included in `mustHide`.

  Attendance passes `mustShow: ['tokenCount']`, and so on.
- `describeJsonOnly(handler, { prefix, exemptPaths })`, `describeBodySize(handler, { maxBytes, prefix,
  exemptPaths })` and `describeSecurityHeaders(plugin, { httpsSite, extraCsp, errorHandler })`: the matrices
  below, run against the app's own wiring. `exemptPaths` are concrete request paths the suite sends, each
  matched by the middleware's `exempt` regexes. The exact signatures are in `api/testing.api.md`.
- *Planned (#19), not in 1.0:* `checkUnraidTemplate(xml, { image, secretTargets })`:
  - no required field;
  - every secret target masked and *Advanced*;
  - PUID/PGID default to 99/100;
  - the `/data` path exists;
  - the repository equals the CI image.

### Matrices for the `/nitro` adapters (api-test-suite-builder)

- **`jsonOnly`:**
  - POST, PUT, PATCH, DELETE × {`application/json`, `application/json; charset=utf-8`, `Application/JSON`}
    → passes;
  - × {`text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data`, `application/jsonx`}
    → 415 with the message body;
  - no `Content-Type` → passes;
  - GET or HEAD with any type → passes;
  - a non-prefix path → passes;
  - an exempt path → passes;
  - `application/json-patch+json` → behaviour pinned explicitly (passes today, through `\b`).
- **`bodySizeLimit`:**
  - Content-Length at the max → passes; max + 1 → 413, and the security headers are still present;
  - non-numeric or negative Content-Length → pinned;
  - a body-carrying method with `Transfer-Encoding: chunked` and no Content-Length: attendance's
    middleware lets this through today, and the K2 spec decides between 411 and a counted read (see the
    follow-up issue);
  - exempt paths are untouched.
- **Security headers:**
  - every header is present on HTML, JSON, 404, 4xx and 5xx responses;
  - HSTS and `upgrade-insecure-requests` are present if and only if the site is https;
  - an extra CSP source is added, and a base directive can never be removed or weakened through `extra`;
  - the JSON error handler keeps the app's CSP, not Nitro's.
- **`enforceRateLimit` + limiter + client address:**
  - `max` requests are allowed; request `max+1` → 429 with `Retry-After` ≥ 1 and
    `data.code = 'rate_limited'`;
  - refused hits are not counted;
  - the window resets on the **fake clock**;
  - capacity evicts the oldest window;
  - the key is the TCP peer, and `X-Forwarded-For` is ignored from an untrusted peer;
  - the rightmost untrusted entry is used behind a trusted proxy;
  - a malformed entry falls back to the peer;
  - IPv4-mapped IPv6, brackets, ports and zones are normalized;
  - `none` and blank `NUXT_TRUSTED_PROXIES` work, and an invalid entry fails startup.

### Coverage targets, set by risk (branch coverage, enforced per directory)

| Code | Target | Why |
| ---- | ------ | --- |
| `core/vault`, `core/logging/redact*` | 100% | A missed branch is a leaked secret or an undetected tamper |
| `core/secrets`, `core/runtime`, `core/security/client-address` | 95% | Startup safety and spoofing resistance |
| Rest of `core`, `nitro` | 90% | Security behaviour, all small |
| `testing` | Not measured | Exercised by the kit's own use of it and by the apps |

Coverage is a floor, not the goal. Tests aim at the riskiest behaviour above.

### Flake hazards and how each is made deterministic

- **Time** (limiter windows, Retry-After): an injected `Clock`, and `fakeClock()` in tests. Nothing waits
  for real time.
- **Log timestamps:** Vitest runs with `TZ=UTC`. Pretty-line tests match the timestamp's *shape*, never
  its value.
- **Randomness** (IV, setup code, generated secrets): assert properties (length, alphabet, freshness,
  round trip), never values. Setup-code distribution is checked over a fixed number of samples with a
  tolerance that can't fail by chance in practice.
- **Filesystem:** each test gets its own `mkdtemp` directory, removed in `afterEach`. Modes are asserted
  with the umask set explicitly. Tests never touch the repo's `.data/`.
- **Environment:** functions take `env` as an argument, so tests never mutate `process.env`. Launcher
  tests run in a child process with an explicit env.
- **Containers:** wait on the container's health status or log line with a bounded poll, never `sleep`.
  Each run uses unique container and volume names, and cleanup is in a trap.
- **h3 integration:** in-memory app, no ports and no network.

### Isolation, fixtures and factories

- `tempSecretsDir()`;
- `existingInstallSecrets({ files })`, which writes `value\n` files with today's modes;
- `h3TestApp(handlers…)`;
- `makeRedactor(extra)`;
- `fakeClock(start)`;
- versioned JSON vectors.

Every value in fixtures is synthetic and generated. No real token, key, IP, guild or player id appears
anywhere in this public repo. A gitleaks check runs in CI.

### Behaviour over mocks

- Middleware is asserted through responses, not "createError was called".
- Secrets are checked on a real filesystem, not a mocked `fs`.
- The logger is checked by reading the lines it wrote.
- The entrypoint is checked in a real container.
- The only test doubles are the clock and the log destination, both injected ports.

### Existing attendance tests: rewritten, deleted or kept (applied during [ADR-0007](0007-migration.md))

| Attendance test | Fate |
| --------------- | ---- |
| `server/modules/vault/vault.test.ts`, `pokemon/vault/vault.test.ts` | Deleted after A4. Replaced by the kit's KATs (which include the golden blob) and `describeVaultContract` in attendance |
| `server/logging/redact.test.ts` | Deleted after A2. Replaced by the kit's tests and `describeRedactionContract` with attendance's keys (birthdate etc. as `mustHide`, `tokenCount` as `mustShow`) |
| `server/logging/logger.test.ts`, `logger.perf.test.ts`, `request-id.test.ts` | Moved to the kit |
| `server/bootstrap/secrets.test.ts` | Moved to the kit. Attendance keeps one test that its three specs keep their env and file names |
| `server/bootstrap/runtime-env.test.ts` | Mostly moved. Attendance keeps its rate-limit variable checks |
| `server/modules/security/*.test.ts`, `accounts/setup-code.test.ts` | Moved to the kit |
| `test/server/{security,logging,boot}.test.ts` | **Kept unchanged**: the integration evidence for the migration |
| `test/unit/entrypoint.test.ts`, `litestream-image.test.ts` | Repointed at the copied assets. Entrypoint behaviour tests move to the kit |
| `test/unit/unraid-template.test.ts` | App-specific assertions kept; generic ones replaced by `checkUnraidTemplate` |
| `test/docker/*.sh` | Kept unchanged |

### Review checks, not tests

- Each ADR's status, and that `SECURITY.md` states the supported versions.
- Whether a PR is breaking ([ADR-0005](0005-versioning-and-security-fixes.md)); the API-surface report
  helps, but a human decides.
- The AAD and key-per-recovery-domain guidance in the docs.
- The npm account's 2FA and trusted-publisher settings, and branch protection on `main`.
- The README states the kit's scope.
- The workflows' permissions (least privilege per job).

## Consequences

- (+) Each app proves *its own configuration* of the kit is safe, not just the kit's defaults.
- (+) The vault's wire format is pinned by an independent oracle and by attendance's real golden blob.
- (+) No test depends on wall-clock time, real network, or shared state.
- (−) The kit's CI needs Docker for the entrypoint tests, which adds a minute or two. They run in parallel
  with the unit tests.
- (−) Contract suites in `/testing` are public API, so changing them follows semver too.
