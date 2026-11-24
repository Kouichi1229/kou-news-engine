# Architecture

Kou News Engine is an AI-powered news intelligence service for Kou AI. It collects
global AI news, translates and summarizes articles into Traditional Chinese,
generates daily briefings, and delivers notifications through Kou AI and a
Telegram bot.

This document describes the architecture as it exists today and separates
clearly what is implemented from what is only planned. Implemented today: the
HTTP server with liveness and readiness endpoints, a one-shot, SQLite-backed
ingestion CLI, a one-shot article extraction CLI, and a provider-agnostic LLM
abstraction with a Gemini adapter (built, but not yet called by any production
path). Not implemented: translation, summarization, classification, importance
ranking, briefing generation, original-content retention, notification delivery,
the news API, and scheduling.

## Architectural style

The service is a **modular monolith**: a single deployable Node.js process whose
code is organized into independent, self-contained modules behind an explicit
internal structure. Modules communicate through narrow, well-defined entry points
rather than reaching into each other's internals. This keeps the option of
extracting a module into a separate service later without a rewrite, while
avoiding the operational cost of distributed systems at this stage.

## Runtime and language

- Node.js 24, ECMAScript modules (`"type": "module"`).
- TypeScript in strict mode, compiled with `tsc` to `dist/`.
- Express 5 as the HTTP framework.
- Zod for environment validation.

## Current project structure

```
src/
  index.ts          HTTP process entry point: starts the server, wires shutdown
  app.ts            Express application factory (middleware + route mounting)
  server.ts         HTTP server lifecycle (start, close)
  runtime.ts        Composition root: owns the database handle, repository,
                    lifecycle state and request tracker for one process
  cli/
    ingest.ts           One-shot ingestion entry point (separate process)
    ingestion.cli.ts    CLI orchestration: runtime + run + outcome -> exit code
    exit-codes.ts       Exit-code contract and run classifier
    signal-recorder.ts  Records which signal arrived, without a second listener
  config/
    constants.ts    Static application constants
    env.ts          Environment schema and validated `env` export
  core/
    logger.ts       Minimal structured JSON logger
    errors.ts       AppError base class and NotFoundError
    lifecycle/
      lifecycle-state.ts    One-way process lifecycle state (running → draining)
      request-tracker.ts    In-flight request accounting and idle waiting
      shutdown.ts           Shutdown orchestration for the HTTP server
      cancellation.ts       Per-run cancellation signal
      signal-coordinator.ts SIGINT/SIGTERM subscription and forced-terminate
      ingestion-lifecycle.ts Signal handling around one ingestion run
    http/
      not-found.ts      Catch-all handler that raises NotFoundError
      error-handler.ts  Central error middleware
      request-tracking.ts  Middleware feeding the request tracker
    persistence/
      sqlite.ts         SQLite handle, connection pragmas, transaction helper
      migrations.ts     Versioned schema migrations
    llm/            LLM provider abstraction (I7-1b)
      llm.types.ts      Request, response, usage and model-identity types
      llm.errors.ts     LlmError taxonomy and the retryability table
      llm.provider.ts   The LlmProvider interface
      fake.provider.ts  In-process fake provider; never reaches a network
      provider.factory.ts  createProvider(): selects an adapter, no model table
      providers/
        gemini.transport.ts  GeminiTransport interface + node:https implementation
  modules/
    health/         Health and readiness module
      health.routes.ts
      health.controller.ts
      health.service.ts
      readiness.ts      Readiness probe abstraction
      draining.probe.ts Readiness entry reporting the lifecycle state
      database.probe.ts Readiness entry reporting database usability
    ingestion/      News ingestion module
      ingestion.service.ts    One pass over the configured sources
      ingestion.types.ts      Run and per-source result types
      sources/                Source definitions and validation
      feed/                   HTTP feed client, parser and mapper
      dedupe/                 Canonical URL, content hash, title key, dedupe
      repository/             Article storage boundary + SQLite and in-memory
                              implementations
  routes/
    index.ts        Aggregates module routers under the /api base path
  types/
    api.ts          Shared API response types
    article.ts      Article domain type
```

### Implemented modules

- **health** — exposes `GET /api/health` (liveness) and `GET /api/ready`
  (readiness).
- **ingestion** — fetches the configured news feeds, parses and deduplicates the
  entries, and stores articles through an `ArticleRepository`. It is driven by a
  **one-shot CLI**, not by the HTTP server; see _Ingestion execution model_.

### Lifecycle state ownership

`src/core/lifecycle/lifecycle-state.ts` defines the process lifecycle: a single
one-way flag that flips from running to draining and never back. It knows nothing
about Express, HTTP, or `process` — it is a plain boolean behind two methods,
`isDraining()` and `beginDraining()`.

The state lives in `core`, not in a module, for two reasons:

1. **Dependency direction.** The producer of the transition is the shutdown
   orchestration, which is also in `core`. Putting the state in `modules/health`
   would force `core` to import a module, inverting the layering below.
2. **Meaning.** It describes the process lifetime, not the health module. Health
   is merely one consumer.

`src/runtime.ts` creates **exactly one** state per Runtime and does two things
with it:

- wraps it in a readiness probe (`createDrainingProbe`) and injects that probe
  into the app it builds, alongside the database probe described below, and
- exposes it as `Runtime.lifecycle`.

`src/index.ts` passes `runtime.lifecycle.beginDraining` to the shutdown handler.
Because the probe and the handler hold the same object, readiness cannot disagree
with the shutdown that is actually happening. Nothing else may create a lifecycle
state; a second instance would report ready while the real one drains.

The transition is one-way and permanent because nothing re-opens the listener and
the runtime may already be disposed. A state machine would add states with no
observable behaviour, so a boolean is the whole model.

### Shared foundations (not modules)

- **config** — validated, typed environment configuration.
- **core** — cross-cutting concerns: logging, error types, HTTP error handling.
- **types** — shared TypeScript types for API payloads.

### Liveness and readiness

The two endpoints answer different questions and are wired so they cannot
accidentally answer the same one.

| Endpoint          | Question                             | 200             | 503             |
| ----------------- | ------------------------------------ | --------------- | --------------- |
| `GET /api/health` | Is the process running?              | always          | never           |
| `GET /api/ready`  | Should this process receive traffic? | all checks pass | any check fails |

**Liveness never consults the database.** A SQLite outage is not a reason to
restart the process: the connection may recover, and a restart would not fix a
locked or corrupt file. `/api/health` therefore returns 200 while the database is
broken, while the process is draining, and even after the runtime is disposed.
Only readiness changes.

**Readiness fails closed.** `getReady` treats a throwing probe as `not_ready` with
the fixed reason code `probe_failed`, so a misbehaving dependency produces a 503
rather than a 500. Every probe runs on every request, and one failing probe does
not mask the others: each result appears under its own key in `checks`.

Two probes are wired by `src/runtime.ts`:

- `lifecycle` (`createDrainingProbe`) — reports `draining` once shutdown begins.
- `database` (`createDatabaseProbe`) — reports `database_unavailable` when the
  check returns `false`, and `probe_failed` when it throws.

The database probe runs one trivial statement (`SELECT 1`) through the handle the
Runtime already owns. It does not open a second connection: an extra connection
would be another resource to close and would report on a database the application
is not using. Because `SqliteDatabase.query()` rejects a closed handle, disposal
is observed without the probe tracking state of its own — after `dispose()` the
check throws and readiness reports 503.

Nothing about the probe reaches the response except `ready` and the reason code.
Exception messages are discarded, because they can carry SQL text, filesystem
paths, or a connection string, and the endpoint is unauthenticated.

**The container healthcheck probes liveness only.** The `HEALTHCHECK` in the
`Dockerfile` calls `/api/health`, so a passing healthcheck means the process is
alive — it does **not** prove the database is readable or that the service could
serve a request. To gate traffic on database availability, probe `/api/ready`
instead; the two endpoints are separate for exactly this reason.

## Module boundaries and dependency direction

Dependencies point **inward and downward only**:

```
routes  ─┐
modules ─┼─▶  core  ─▶  config
         └─▶  types
```

Rules that hold today:

- A module depends on shared foundations (`core`, `config`, `types`) and on
  Express. It does not depend on another module.
- `core` and `config` do not depend on modules, `routes`, or `app`.
- `core/lifecycle/lifecycle-state.ts` imports nothing: both the shutdown
  orchestration in `core` and the draining probe in `modules/health` depend on
  it, so it must stay below both. The probe is a module file; the state is not.
- `core/lifecycle/request-tracker.ts` also imports nothing, for the same reason:
  the middleware in `core/http` and the shutdown orchestration both depend on it.
  Only `core/http/request-tracking.ts` knows about Express.
- `routes/index.ts` is the single place that knows which module routers exist;
  modules do not register themselves onto the application.
- `app.ts` composes middleware and mounts `routes/index.ts`; it holds no business
  logic.
- `server.ts` knows only about an Express app and a port/host; it holds no
  business logic.

Keeping these directions intact is what allows a module to be extracted later
without untangling cross-module imports.

## HTTP request lifecycle

1. **Process start** — `src/index.ts` loads validated configuration from
   `src/config/env.ts`, sets the log level, builds the app with `createApp()`,
   and calls `startServer()`.
2. **Request arrives** — Express runs middleware in the order declared in
   `src/app.ts`:
   1. `app.disable('x-powered-by')`
   2. request tracking — counts the request in flight and releases it when the
      response finishes or the connection closes. Mounted before `express.json()`
      so a request rejected during body parsing is still counted.
   3. `express.json()` — parses JSON bodies; malformed JSON produces a body-parser
      error (`entity.parse.failed`).
   4. `apiRouter` mounted at `/api` — dispatches to module routers.
   5. `notFoundHandler` — reached only when no route matched; raises
      `NotFoundError`.
   6. `errorHandler` — the single terminal error middleware.
3. **Successful handling** — a controller calls its module service and serializes
   the result as JSON.
4. **Error handling** — any thrown or forwarded error reaches `errorHandler`,
   which maps it to a status code and the standard error envelope (see
   `docs/api-conventions.md`). Unexpected errors never leak stack traces to the
   client.
5. **Shutdown** — `src/index.ts` listens for `SIGTERM`/`SIGINT`. The shutdown
   handler marks the process draining **before** closing the listener, so
   readiness can answer `503` while the socket still accepts. It then closes the
   HTTP server, waits for tracked requests to drain, disposes the runtime, and
   exits with code 0 on success or 1 on failure.

   Ordering is deliberate. Draining first means a router polling `/api/ready` can
   learn to stop sending new traffic; closing the listener first would remove the
   only way to ask. The `503` is advice to a router, not a socket operation, and
   it does not by itself stop a load balancer from sending requests.

   The sequence has three branches, decided by whichever of `closeServer()` and
   the request drain settles first. Both start together after the first sweep.

   - **Close fails first** — the drain is never waited on, so a request that
     never finishes cannot turn a known close error into a deadline timeout. The
     runtime is disposed and the process exits `1`, re-throwing the original
     close error.
   - **Close succeeds first** — the drain is still outstanding, so the second
     `closeIdleConnections()` waits for it. Sweeping earlier would target
     sockets that are still mid-request, which is exactly what the second sweep
     exists to avoid. Once the drain finishes the process exits `0`.
   - **Drain settles first** — the second sweep runs immediately, then the
     remaining close is awaited. A close that fails at that point is still
     re-thrown, so a late failure is never reported as a clean exit.

   In every branch the whole draining sequence sits inside one deadline, so a
   drain that never settles exhausts `SHUTDOWN_TIMEOUT_MS` rather than holding
   the process open; that path forces sockets closed and exits `1` **without**
   disposing the runtime. The second sweep is skipped on that path, because the
   drain it waits for never finished.

   `closeIdleConnections()` appears twice on purpose. The first call reaches only
   sockets that are idle at that instant; a keep-alive socket still serving a
   request survives it, and since `closeServer()` waits for every connection that
   socket would otherwise hold the process open for its keep-alive timeout —
   about 6 seconds on Node 24 by default (`keepAliveTimeout` plus
   `keepAliveTimeoutBuffer`). The second call, after the drain wait, closes
   exactly those sockets so `closeServer()` settles promptly.

### In-flight request tracking

`createRuntime()` owns one `RequestTracker` and passes it, together with the
lifecycle state, to `createApp()`. The middleware increments it per request; the
shutdown handler waits on the same instance. Because both sides share one object,
readiness, tracking, and disposal cannot drift apart.

A request is released when its response emits `finish` **or** `close`, whichever
happens first. Both are observed because neither alone covers every outcome:
`finish` never fires when a client disconnects mid-response, and on a normal
response `close` arrives after `finish`. The release function is idempotent, so
attaching it to both events decrements the count at most once.

Requests that arrive while draining are still served — the connection was already
accepted, so refusing them would only cause a retry — and are counted separately
in `stats().draining` and logged. No response header is altered.

### What request tracking does not prove

Tracking is **HTTP-layer quiescence**, not application-handler completion:

- A handler that keeps awaiting after `res.json()` has already had its request
  released.
- A handler whose client disconnected has had its request released while the
  handler may still be running.

So a zero count means "every response finished or every connection closed", not
"all application work is done". The success path disposes SQLite once the count
reaches zero; a handler still running past that point can then observe
`DatabaseClosedError`. That is a specific, catchable error rather than database
corruption — the SQLite driver is synchronous, so a close can never land in the
middle of a statement — but it is a real residual limitation, and this design
does not eliminate it. Tracking full handler completion would require awaiting
each handler's promise, which is not implemented here.

### Streaming, SSE, and WebSocket

This service has no streaming, SSE, or WebSocket endpoints. That matters for
shutdown because `server.close()` only settles once every connection ends: a
long-lived streaming response would never end on its own, so shutdown would
always run out its deadline, force sockets closed, and exit `1`. Any future SSE
or WebSocket feature must implement its own draining hook — a signal to finish
the stream — rather than relying on this mechanism.

## Ingestion execution model

Ingestion is a **one-shot CLI process**, not a background task of the HTTP
server.

```
npm run ingest                 # dry-run preview (default)
npm run ingest -- --execute    # real ingestion
npm run ingest:prod            # production: node dist/cli/ingest.js (still a dry-run)
```

### Nothing runs unless asked

Both one-shot CLIs default to a **dry-run**. Only the literal `--execute` token
grants permission to write to the database or make a network request; every other
successful parse previews instead. The rule is enforced in `src/cli/args.ts`,
which the entry points consult before importing configuration or opening a
database, so:

- `--help` is answered and the process exits without evaluating `env.ts` and
  without opening a database. A help request therefore works with no `.env`, an
  invalid environment, and a database that does not exist — and does not create
  it.
- A misspelled or unknown argument exits `2` instead of being ignored. `--help`
  does not excuse an unknown argument, and `--help` combined with a mode flag is
  rejected rather than guessed at.

A dry-run opens the database **read-only**: `openReadOnlyDatabase()` neither
creates the file nor runs a migration, and pins the connection with
`PRAGMA query_only`. It reads the write-ahead log rather than opening the file
`immutable`, because an immutable connection silently ignores uncommitted WAL
content and would under-report. The one filesystem effect is that SQLite
maintains the `-shm` index while the connection is open; the database file and
its `-wal` are left byte-identical.

The process starts, runs exactly one pass over the configured sources, and exits.
There is **no built-in scheduler**: nothing in this repository wakes up on a
timer. An external scheduler — cron, a systemd timer, a container orchestrator's
job, or a CI schedule — is expected to invoke the CLI on whatever cadence is
wanted. `APP_TIMEZONE` exists for a future scheduler milestone but is not read by
this runtime today, and no job is currently scheduled at 08:00 or any other time.

The two entry points are deliberately separate processes:

- `src/index.ts` starts the HTTP server and **never imports the ingestion
  module**; a server start can therefore never trigger a fetch.
- `src/cli/ingest.ts` runs one ingestion pass and **never starts a server**.

Both share the composition root `createRuntime()` (`src/runtime.ts`), so the CLI
uses the same SQLite-backed `ArticleRepository` the server would.

`runIngestion` requires an explicit `repository`. There is **no implicit
in-memory fallback**: passing no repository throws a `TypeError` rather than
silently writing to a repository that disappears when the process exits. The
in-memory implementation exists for tests only. Because the CLI builds its
runtime through `createRuntime()`, a production run always writes to SQLite.

## Extraction execution model

Extraction is the same shape as ingestion: a **one-shot CLI process**, run by an
external scheduler, that never starts a server.

```
npm run extract                 # dry-run preview (default)
npm run extract -- --execute    # real extraction
npm run extract:prod            # production: node dist/cli/extract.js
```

It shares `src/cli/args.ts` and therefore the same safety rules: `--execute` is
the only way to run real work, `--help` exits without touching a database, and a
rejected command line exits `2`. The dry-run reports how many rows are currently
claimable.

That figure is an **estimate**, and the CLI labels it as one. It counts existing
`article_contents` rows using the same predicate `claim` uses — the rule lives in
one method, `eligibilitySql()`, so the preview cannot drift from the claim — but
it does not seed. On a database that has never been extracted there are no rows
yet, so the preview reports `0` while the next real run would first create a row
per article. State can also change between the preview and the run.

## CLI exit codes

The contract lives in `src/cli/exit-codes.ts` and is asserted in tests, not
inferred from log text. Extraction's codes live in
`src/cli/extraction-exit-codes.ts`; the two are separate modules because their
outcome types differ, but the numbers are shared conventions.

| Outcome                               | Exit code |
| ------------------------------------- | --------: |
| All attempted sources succeeded       |         0 |
| Partial success (some sources failed) |         0 |
| All attempted sources failed          |         1 |
| Persistence failure                   |         1 |
| Deadline left sources unstarted       |         1 |
| `SIGINT` cancellation                 |       130 |
| `SIGTERM` cancellation                |       143 |
| Runtime initialization failure        |         1 |
| Unexpected error                      |         1 |
| Rejected command line (usage)         |         2 |

A dry-run preview exits `0` in both CLIs: it reports what it found, and a
database that is missing or unreadable is reported as an unavailable count rather
than repaired. `2` is reserved for a command line the parser refused, so a
supervisor can distinguish "the invocation was wrong" from "the run failed".
Nothing is written and no request is sent when `2` is returned.

Two details that a supervisor script depends on:

- **`130` and `143` are `128 + signal number`**, the shell convention, and are
  distinguishable from the plain `1` failure.
- **A partial success exits `0`.** The articles that were fetched are real and
  already persisted, so a supervisor treating nonzero as "nothing usable
  happened" would be wrong.

`classifyRun` applies a fixed precedence: persistence failure first, then
cancellation, then a deadline that left sources unstarted, then the source
outcomes counted over **attempted** sources only. A `skipped` source was never
tried, so it counts as neither success nor failure — that is why a deadline
truncation is reported through `stoppedReason` rather than as a failed source.

A cancellation with no recorded signal identity is classified as
`unexpected-error` (exit `1`) rather than guessed into `130` or `143`: an invented
signal identity would be indistinguishable from a real one.

## SQLite persistence

The production CLI writes through `SqliteArticleRepository`, built by
`createRuntime()` over a handle from `openDatabase()`.

- **Driver.** `node:sqlite` (`DatabaseSync`), Node's built-in SQLite binding. No
  native add-on and no ORM is involved.
- **Connection setup order.** The very first statement on each newly opened
  connection is `PRAGMA busy_timeout = 5000`, before `foreign_keys`, before
  `journal_mode = WAL`, and before migrations. Setting it later would leave those
  statements able to fail with `SQLITE_BUSY`.
- **`busy_timeout` is connection-level configuration.** It is not stored in the
  database file and does not travel with it; every new connection must set it
  again. It makes a competing writer wait up to five seconds instead of failing
  immediately.
- **`busy_timeout` is not a lock.** It is a retry window, not mutual exclusion. It
  does not make concurrent writers safe. **Two ingestion processes must not run
  concurrently against the same database file**; use the external scheduler to
  serialize them (for example, a lock file or an orchestrator that never runs two
  jobs at once).
- **Persistence is not atomic per run.** `saveMany` performs sequential per-article
  upserts, each in its own transaction. If an article fails, earlier articles
  remain written. There is **no whole-run transaction and no rollback of a
  partial run** — a failed run can leave some articles stored.

## Docker persistence

Deployment configuration lives in `compose.yaml` (the Compose default filename;
there is no `docker-compose.yml`) and `Dockerfile`.

- **Named volume:** `kou-news-data`, declared at the Compose top level and mounted
  at `/app/data`.
- **Container database path:** `DATABASE_PATH=/app/data/kou-news.db`, set
  explicitly by Compose. This overrides the `.env` value; the local default
  `./data/kou-news.db` is a development path and is not the container path.
- **Runtime user:** the non-root `node` user (`USER node` in the runtime stage).
- **Directory ownership:** the Dockerfile creates `/app/data` and
  `chown node:node /app/data` **before** `USER node`, so the runtime user can
  write there. Docker seeds a fresh named volume with that directory's ownership,
  which is what makes the volume writable.
- **Lifetime:** the named volume survives ordinary container replacement and
  `docker compose down`. Only `docker compose down -v` deletes it — that flag
  removes the SQLite database with it.
- **Limitation:** an **existing** volume that was created with the wrong ownership
  is not repaired automatically. Changing the `chown` in the Dockerfile affects
  newly created volumes; a volume already populated keeps its ownership until it
  is removed and recreated (or corrected manually).

## Ingestion run control: deadline and cancellation

A run is bounded in time and can be asked to stop, but neither mechanism
interrupts work already in flight. Both are checked **at source boundaries
only**, by `runIngestion` in `src/modules/ingestion/ingestion.service.ts`.

### Deadline

`deadlineMs` defaults to `DEFAULT_INGESTION_DEADLINE_MS` (300 000 ms) and is
measured with a monotonic clock — `performance.now()` by default, injectable via
`clock` so tests never wait. Wall-clock time is deliberately not used: an NTP
correction or a VM resume would move a `Date.now()`-based deadline backwards or
forwards and silently change the run's budget.

Elapsed time is computed once at the start (`deadlineAt = clock() + deadlineMs`)
and compared with `clock() >= deadlineAt` before each source begins. An invalid
budget — zero, negative, `NaN`, or infinite — throws `RangeError` rather than
being coerced: treating `NaN` as "unlimited" would remove the guard the caller
asked for without saying so.

Because the check happens before a fetch starts, a run can overrun its deadline
by up to one source. That is the intended trade: aborting mid-request would
discard a nearly finished fetch and force a re-fetch of the same source later.

The 300-second budget covers the **whole run**, not each source. It is a ceiling
on total time, so it does not guarantee that all six configured sources will be
attempted: if their combined execution exceeds the budget, the remaining sources
are `skipped` and the run exits `1`. Raising throughput means shortening per-source
work or raising the budget — not expecting the deadline to make six fetches fit.

### Cancellation

`signal` accepts a `CancellationSignal` (`src/core/lifecycle/cancellation.ts`).
It is a plain object created per run, not module state, so two runs in one
process cannot cancel each other. A source already being fetched is always
awaited to completion and its articles are kept; only _starting_ a new source is
prevented.

The signal is checked before the deadline, so a run cancelled by an operator
reports `signal` even when the budget also expired. The two reasons are kept
distinct because they call for different responses: an exhausted budget means the
budget is wrong, a signal means someone asked for the stop.

### Reporting a run that stopped early

`SourceRunResult.status` is `'ok' | 'error' | 'skipped'`. A source that was never
attempted is `'skipped'` with a `skipReason` of `'deadline'` or `'signal'` — never
`'ok'`, which would claim coverage the run did not have, and never `'error'`,
because nothing failed. `IngestionRunResult.stoppedReason` carries the same reason
at run level and is **absent** when every enabled source was attempted, so an
existing consumer that checks only `status` keeps working unchanged.

Deduplication and `saveMany` still run over whatever was collected, and a
persistence failure still rejects the run regardless of why it stopped.

## Signal handling for ingestion

`createIngestionLifecycle` (`src/core/lifecycle/ingestion-lifecycle.ts`)
composes signal handling around one run. It is not a CLI entry point: it reads no
arguments, maps no exit code, and is not wired into `package.json` scripts.

### First and second signal

| Signal                    | Behaviour                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First `SIGINT`/`SIGTERM`  | Sets graceful cancellation. No new source starts. The current fetch finishes, its articles are saved, and the run returns normally. The runtime is then disposed. |
| Second `SIGINT`/`SIGTERM` | Terminates immediately via the injected `terminate` (default `process.exit(1)`). Requested exactly once.                                                          |
| Third and later           | Ignored. The termination request has already been made.                                                                                                           |

The counter is shared across both signals: `SIGINT` followed by `SIGTERM` is
still the second signal, not two independent sequences.

The second signal is a request to stop _now_, not a promise of a tidy end. Data
risk on that path:

- A fetch still running is abandoned; its result is discarded.
- Articles fetched but not yet passed to `saveMany` are lost.
- A `saveMany` batch already partially applied stays partially applied — that
  path is deliberately non-transactional, as documented on `ArticleRepository`.

SQLite keeps the database _consistent_ on the next open (the WAL is recovered),
but consistency is not completeness. Never describe a second-signal exit as a
clean or complete shutdown.

### Ordering around runtime initialization

Handlers are installed **before** `createRuntime()` is called. Installing them
afterwards leaves a window in which a signal during a slow database open
terminates the process with a connection already acquired and never closed.

Subscribing first has one consequence worth stating: initialization itself is not
interruptible. The signal is recorded instead, and then:

- If it arrived during `createRuntime()`, the runtime is still awaited to
  completion so whatever was opened is known, then disposed, and the
  run is **not** started — no source is fetched for a request nobody wants.
- If it arrived after the runtime exists but before the run begins, the same
  skip applies.
- If `createRuntime()` throws, no runtime exists, nothing is disposed, and no
  error is invented.

Disposal happens exactly once per invocation, guarded by a flag rather than by
the shape of a thrown value, so it runs on the clean path, on a run that throws,
and after a cancellation. A disposal that throws is never retried — the handle's
state is unknown afterwards and a retry could double-release — and it surfaces as
the invocation's error instead of hiding behind a successful run.

## Configuration

All runtime configuration comes from environment variables, validated at startup
by a Zod schema in `src/config/env.ts`. Invalid configuration fails fast: the
process throws during startup rather than running in a partially configured
state. The schema, defaults, and semantics are documented in `.env.example` and
the project `README.md`.

Supported variables, all with defaults so an empty environment is valid:

| Variable              | Default              | Meaning                                             |
| --------------------- | -------------------- | --------------------------------------------------- |
| `NODE_ENV`            | `development`        | `development` \| `test` \| `production`             |
| `PORT`                | `3000`               | HTTP listen port                                    |
| `HOST`                | `0.0.0.0`            | HTTP listen host                                    |
| `LOG_LEVEL`           | `info`               | `debug` \| `info` \| `warn` \| `error`              |
| `APP_TIMEZONE`        | `Asia/Taipei`        | Retained for a future scheduler; unused today       |
| `DATABASE_PATH`       | `./data/kou-news.db` | SQLite file path, relative to the working directory |
| `SHUTDOWN_TIMEOUT_MS` | `8000`               | HTTP drain budget, 1000–60000                       |

There is no separate variable for the ingestion CLI: it reads the same
`DATABASE_PATH`, so the CLI and the server always agree on which file they use.
Docker Compose overrides `DATABASE_PATH` with the in-container path; see _Docker
persistence_.

## Persistence boundary

SQLite is implemented, and the shape it was built into is:

- A dedicated persistence layer under `src/core/persistence/` that owns the client
  lifecycle (`sqlite.ts`, `migrations.ts`).
- Per-module **repositories** that encapsulate queries and are the only code that
  touches the persistence layer. Services depend on the `ArticleRepository`
  interface, not on a database client directly.
- Readiness reporting (`GET /api/ready`) includes a database connectivity check in
  its `checks` object — see _Liveness and readiness_.

`createRuntime()` is the only place a connection is opened and the only place it is
closed. The repository borrows the handle and never closes it. Readiness probes
borrow it too, so probing does not open a second connection.

**No ORM is in use.** The driver is `node:sqlite` behind the repository interface,
which keeps an ORM or a different provider replaceable later without reshaping
module code.

## Original-content retention (planned)

> **Status: requirement only. Nothing described in this section is implemented.**
> This section is the single authoritative statement of the retention
> requirements. Other documents should link here rather than restate the rules.

Kou News Engine is intended to keep the *body text of original articles* only
temporarily, while keeping the *derived* records long-term. The
requirements below are Owner-confirmed.

### Retention clock

- The clock starts at the **first successful download** of an article — that is,
  the moment the article body is fetched and stored.
- The period is **7 × 24 hours (168 hours)** from that instant. It is **not**
  seven calendar days ending at midnight, and it does not reset at a timezone
  boundary.
- **Rediscovery of the same article must not restart or extend the clock.** The
  first successful download timestamp remains the authoritative reference for
  the life of the record.

### Separate storage of original content and derived records

- Original article content and AI-generated summaries must be **stored
  separately**.
- Expiry of the original content must **not** delete its summary, index, or
  classification.
- Summaries, indexes, and classifications are retained **long-term** for
  historical search and trend analysis.

### No existing timestamp column is a suitable anchor

This is a schema finding, not a design preference. Each candidate column fails
the "rediscovery must not reset the clock" requirement or measures the wrong
event:

| Column | What it records | Why it is unsuitable |
| --- | --- | --- |
| `articles.fetched_at` | When the ingestion run processed the feed entry | **Rewritten on rediscovery.** The ingestion upsert refreshes it via `ON CONFLICT (id) DO UPDATE`, so re-collecting an article resets it. |
| `article_contents.extracted_at` | When extraction last completed | **Rewritten on re-extraction.** A completed extraction sets it again, and bumping `EXTRACTOR_VERSION` re-queues every stored article, resetting it across the whole table. |
| `article_sources.first_seen_at` | When a provenance identity was first observed in a feed | Measures **feed observation**, not first successful article download. It is also **per provenance row**, not per article, so one article can carry several different values. |

**A new immutable first-download timestamp will therefore be required before
retention can be implemented.** It must be written once, at the transition to a
successfully extracted article, and never updated afterwards — in particular not
by a re-extraction. This document does not prescribe that column's name, type,
or migration; it records only that an immutable anchor is a prerequisite.

### Relationship to cascading deletes

The existing schema cascades deletion from `articles`:

- `article_sources.article_id` references `articles (id) ON DELETE CASCADE`.
- `article_contents.article_id` references `articles (id) ON DELETE CASCADE`.

If future summary, index, or classification storage were given the same
cascade, expiring original content would **delete the long-term records too**,
which directly violates the requirement above.

> **Design consideration, not an approved decision.** Any future summary, index,
> or classification table must avoid cascading from `articles` in a way that
> lets original-content expiry remove long-term data. The specific foreign-key
> design (no foreign key, `ON DELETE SET NULL`, a soft reference, or a separate
> table) is deliberately **not** decided here.

### Deletion mechanism — pending Owner decision

**The deletion mechanism is undecided.** The Owner has not chosen between hard
deletion, soft deletion, a hybrid, deleting the whole `article_contents` row, or
nulling `content_text` while keeping a tombstone. This document must not be read
as endorsing any of them, and no implementation may pick one without an explicit
Owner decision.

### Residual copies

Expiring a row from the live database does **not** erase every physical copy of
the content. Any retention claim describes *live database content only*. Known
residual locations:

- **SQLite freelist pages.** SQLite does not shrink the database file when rows
  are deleted. Freed pages are reused by later writes, and the bytes can remain
  readable in the file until overwritten or reclaimed with `VACUUM`.
- **WAL and `-shm` files.** In WAL mode, recently written pages may remain in the
  `-wal` sidecar file until a checkpoint, and the `-shm` file is transient shared
  memory. Neither is scrubbed by deleting a row.
- **Backups.** Any backup taken before expiry contains the content and is
  unaffected by later deletion.
- **Logs and caches.** Any future logging, tracing, or caching layer that copies
  article bodies becomes another copy that retention does not reach. No such
  copy exists today.

## LLM provider boundary (I7-1b)

`src/core/llm/` holds a vendor-free provider abstraction. Business code depends on
the `LlmProvider` interface and the logical model name it was constructed with; it
never names a vendor, an SDK or a transport.

- **`createProvider(config, deps)`** is the only place an adapter is selected. It
  validates the provider name, then the credential for that provider, then the
  transport seam — in that order, so a missing credential cannot resolve a
  transport. It holds no model table: mapping a logical name to a vendor id is the
  adapter's own private concern.
- **The credential is validated here, not at startup.** `GEMINI_API_KEY` is
  optional in the env schema, so the server and both CLIs boot without it. Only a
  `LLM_PROVIDER=gemini` factory call can fail on a missing key.
- **`fake` is the default and needs no secret.** It is a first-class provider, not
  a test double bolted on: callers are tested against the same interface the real
  adapter will implement.
- **The transport is a seam, not a setting.** `LlmProviderDeps.createTransport`
  returns a `GeminiTransport`; `LlmProviderConfig` has no transport field, so no
  caller can smuggle one through configuration. The factory invokes the callback
  only on the `gemini` branch, and the composition root supplies it. Real socket
  I/O is confined to `providers/gemini.transport.ts`, which implements the
  interface over `node:https`.
- **No provider is built at startup.** `createRuntime()` builds none; the first
  `Runtime.getProvider()` call does. `getProvider()` is exposed but not called by
  any production path yet, so nothing constructs a provider in production — the
  seam is in place for the milestone that adds translation and summarisation.

## Planned modules (not implemented)

The following are **not** implemented. No interfaces or adapters for them exist in
the code yet, and nothing in this repository performs them today:

- **translation and summarization** — producing Traditional Chinese summaries,
  via a provider-agnostic LLM adapter.
- **classification and importance ranking** — categorising articles and ordering
  them by significance.
- **original-content retention** — expiring stored article bodies. The
  requirements are specified in _Original-content retention (planned)_ above; no
  behaviour is implemented.
- **briefing generation** — assembling the daily briefing.
- **notifications** — independent delivery adapters for Kou AI and the Telegram
  bot.
- **scheduling** — triggering daily jobs. Ingestion is invoked externally today;
  there is no scheduler and no 08:00 job. `APP_TIMEZONE` is retained for this.

Each is expected to become its own module following the same boundaries and
dependency direction described above.

> The service's stated goal — collecting AI news, translating and summarizing it
> into Traditional Chinese, generating daily briefings and delivering them to Kou
> AI and Telegram — is the destination, not the current state. What exists today
> is the HTTP server, its health/readiness endpoints, the SQLite-backed ingestion
> CLI, and the operational scaffolding around them.
