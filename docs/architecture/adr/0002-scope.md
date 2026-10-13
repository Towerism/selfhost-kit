# ADR-0002: Scope — what the kit holds, and why the job runner stays out

- Status: Proposed
- Date: 2026-10-13

## Context

[ADR-0001](0001-share-as-a-package.md) decided to share through a package. This ADR decides *what* goes
in. The candidates are the vault, the secret bootstrap and launcher, the setup code, the logger and
redaction, the security headers, rate limit and JSON-only middleware, the job runner with leases and a
persisted timer, the Docker entrypoint and Litestream, and the CI and release workflows.

The test for each piece: **would the two apps' copies differ only in data?** If so, the logic goes in the
kit and the data stays in the app. If the logic itself differs, the piece stays in the app.

### The job runner, in detail

- **Attendance** has no general job runner. Its "jobs" are submission runs inside
  `server/modules/submission/service.ts` (2,084 lines):
  - The lease is the `submission_lock` table: per league, renewed before each bulk call, expiring after 2
    minutes.
  - It is taken, handed over and released by about 40 lines of service-private functions.
  - A staff batch holds the lease under *minus the batch id* between its jobs.
  - Boot recovery (`recoverInterrupted`) marks submissions and staff batches `interrupted` and clears the
    locks. Resuming them is a user action from History, by design (ADR-0004 there, #101).
  - Scheduled work (hourly keep-alive, TDF expiry) uses Nitro's experimental `scheduledTasks`, not a
    persisted timer.
- **Genie** plans a general `jobs` module (its ADR-0001):
  - it owns the `job` and `job_event` tables;
  - it holds per-day leases;
  - it keeps due times persisted in `job.due_at`, checks every 60 s, and runs anything overdue at boot;
  - `provisioning` and `closeout` register handlers with it.

The two have different shapes: different lease keys (league or day), different recovery semantics (mark
interrupted vs. retry automatically), and timers on one side only. Nothing in attendance could be
extracted that Genie would use. Putting Genie's planned module in the kit would give it exactly one
consumer. It would also need the kit to own Drizzle table definitions and migrations, which would tie the
kit to each app's database.

## Options considered

1. **Everything listed, including a general job runner.** Genie builds its jobs module inside the kit, and
   attendance adopts it later. The kit would own DB tables and migrations, which is a large coupling.
   Attendance would only benefit after rewriting a 2,084-line service, and nothing plans that. It would also
   make the kit's riskiest code its least-proven code.
2. **Only the crypto (vault + secrets).** The smallest kit. Redaction, the middleware and the entrypoint
   would still be copied, and redaction is named in the finding.
3. **Everything whose copies would differ only in data. The job runner stays in Genie, with a rule for
   when it moves.** (Chosen.)

## Decision

Option 3.

| Piece | In the kit? | What stays in each app |
| ----- | ----------- | ---------------------- |
| AES-256-GCM vault + string helper | **Yes** (core) | Which values are sealed, their AAD strings, key names |
| Secret specs, `resolveSecret`, `prepareRuntimeEnv`, `runLauncher` | **Yes** (core) | The list of specs; extra config checks; the server entry URL |
| Setup code generation + constant-time match | **Yes** (core) | When it's printed, what it unlocks, when it stops working (attendance: once an account exists; Genie: when the wizard finishes) |
| Logger, `Logger` port, redaction, request id | **Yes** (core) | Extra redaction keys; `useLogger` and the async-context lookup |
| Request-log + error-log Nitro plugin | **Yes** (`/nitro`) | Which paths are quiet |
| CSP / security headers builder | **Yes** (core) and the plugin (`/nitro`) | Extra CSP sources; per-route policies such as Genie's sandboxed transcript view |
| Fixed-window limiter, client address, trusted proxies | **Yes** (core) and `enforceRateLimit` (`/nitro`) | Which routes are limited, the limits, and their env tuning names |
| JSON-only and body-size middleware | **Yes** (`/nitro`) | Exempt paths and the size limit |
| JSON error handler that keeps the app's CSP | **Yes** (`/nitro`) | — |
| Entrypoint (PUID/PGID/UMASK, gosu, Litestream supervision), `litestream.yml`, Litestream version + checksum pin | **Yes** (assets, [ADR-0004](0004-sharing-docker-and-ci.md)) | The Dockerfile: stages, paths, `HEALTHCHECK`, the app's env defaults |
| Image build/smoke/publish and release jobs; semantic-release config | **Yes** (reusable workflows + shareable config) | `check` and `e2e` jobs, smoke-test scripts, image name |
| Unraid template | **No**: almost every line differs. The kit ships *checks* for it in `/testing` (no required field, secrets masked, image matches CI) | The template and icon |
| Job runner, leases, persisted timer, boot recovery | **No** (see below) | Attendance's submission lock; Genie's `jobs` module |
| `/healthz`, `/readyz` routes | No: three lines each, and readiness is app-specific | — |
| DB client, migrations, auth, domain modules, integrations | No | — |

**The job runner rule.** Genie builds its `jobs` module in its own repo, as its architecture says. The
module should be written as if it were already in the kit, so that moving it later is cheap:

- plain TS;
- storage behind a small port, not direct table access from callers;
- an injected `Clock`.

It moves into the kit, through an amendment to this ADR, **when a second consumer needs it**. A likely
trigger is attendance replacing Nitro's experimental `scheduledTasks` with a persisted timer, or replacing
its submission lock. Until then it has one consumer, and sharing it would buy nothing. The `Clock` port is
in the kit from day one, because the limiter already needs it.

## Consequences

- (+) Everything named in the finding (vault, secret bootstrap, redaction) is shared, along with the rest
  of the security middleware and the ops assets.
- (+) The kit owns no database tables and no migrations, so it never needs to know an app's schema.
- (+) Genie's jobs module is designed to be extractable, so a later move is a relocation, not a rewrite.
- (−) The job runner is the one piece that could still be copied later. The re-entry rule and the review
  checklist in Genie's follow-up issue guard against that.
- (−) A few small Nitro pieces (`/healthz`) are still written twice. That is accepted: they are trivial
  and not security-sensitive.
