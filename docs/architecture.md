# Architecture

Kou News Engine is an AI-powered news intelligence service for Kou AI. It collects
global AI news, translates and summarizes articles into Traditional Chinese,
generates daily briefings, and delivers notifications through Kou AI and a
Telegram bot.

This document describes the architecture as it exists today (Milestone 0) and
separates clearly what is implemented from what is only planned.

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
  index.ts          Process entry point: starts the server, wires shutdown
  app.ts            Express application factory (middleware + route mounting)
  server.ts         HTTP server lifecycle (start, close)
  config/
    constants.ts    Static application constants
    env.ts          Environment schema and validated `env` export
  core/
    logger.ts       Minimal structured JSON logger
    errors.ts       AppError base class and NotFoundError
    lifecycle/
      lifecycle-state.ts  One-way process lifecycle state (running → draining)
      request-tracker.ts  In-flight request accounting and idle waiting
      shutdown.ts         Shutdown orchestration
    http/
      not-found.ts      Catch-all handler that raises NotFoundError
      error-handler.ts  Central error middleware
      request-tracking.ts  Middleware feeding the request tracker
  modules/
    health/         Health and readiness module
      health.routes.ts
      health.controller.ts
      health.service.ts
      readiness.ts      Readiness probe abstraction
      draining.probe.ts Readiness entry reporting the lifecycle state
  routes/
    index.ts        Aggregates module routers under the /api base path
  types/
    api.ts          Shared API response types
```

### Implemented modules

- **health** — exposes `GET /api/health` (liveness) and `GET /api/ready`
  (readiness). This is the only feature module implemented at Milestone 0.

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
  into the app it builds, and
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

## Configuration

All runtime configuration comes from environment variables, validated at startup
by a Zod schema in `src/config/env.ts`. Invalid configuration fails fast: the
process throws during startup rather than running in a partially configured
state. The schema, defaults, and semantics are documented in `.env.example` and
the project `README.md`.

## Future database integration extension point

No database is implemented at Milestone 0, and no database provider has been
selected. The intended integration point, when it is introduced, is:

- A dedicated persistence layer under `src/core` (for example a `db` or
  `persistence` concern) that owns the client lifecycle.
- Per-module **repositories** that encapsulate queries and are the only code that
  touches the persistence layer. Services depend on repository interfaces, not on
  a database client directly.
- Readiness reporting (`GET /api/ready`) extended to include a database
  connectivity check in its `checks` object.

This shape keeps the ORM and provider choice behind a boundary so it can be made
later without reshaping module code. **The provider and the ORM are deliberately
undecided.**

## Planned modules (not implemented)

The following are planned for later milestones. They do **not** exist in the code
yet, and no interfaces or adapters for them have been created:

- **news ingestion** — fetching articles from configurable sources.
- **article extraction** — turning raw sources into structured articles.
- **translation and summarization** — producing Traditional Chinese summaries,
  via a provider-agnostic LLM adapter.
- **briefing generation** — assembling the daily briefing (timezone Asia/Taipei,
  08:00).
- **notifications** — independent delivery adapters for Kou AI and the Telegram
  bot.
- **scheduling** — triggering daily jobs.

Each is expected to become its own module following the same boundaries and
dependency direction described above.
