# Deployment

This document describes how to build and run Kou News Engine as a Docker
container. It reflects the container assets that exist today
(`Dockerfile`, `.dockerignore`, `compose.yaml`).

The image has **not** yet been built or run in this environment, because no
Docker daemon is available here. The commands below are the intended workflow;
image-level verification is a separate, later step. Nothing in this document
claims that a cloud environment has been configured.

## Prerequisites

- **Docker Engine** or **Docker Desktop** installed.
- **Docker Compose v2** (the `docker compose` subcommand; not the legacy
  `docker-compose` v1 binary).
- A **running Docker daemon**. Compose commands that build or start containers
  fail with an error such as `Cannot connect to the Docker daemon` when the
  daemon is not running. On Docker Desktop, start the application; on Linux,
  start the `docker` service.
- **Node.js 24** is required **only for local, non-containerized development**
  (see the README). Building and running the image does not require Node.js on
  the host — the image provides its own Node.js 24 runtime.

## Environment configuration

Kou News Engine reads all of its configuration from environment variables,
validated at startup by a Zod schema in `src/config/env.ts`. An invalid value
causes the process to exit immediately with a message naming the offending
field.

### How Compose supplies configuration

`compose.yaml` sets the container environment explicitly. It does **not** use
`env_file`, so the local `.env` file is never injected into the container.

Inside the container:

- `NODE_ENV` is fixed to `production`.
- `HOST` is fixed to `0.0.0.0` (listen on all interfaces inside the container).
- `PORT` is fixed to `3000`.

These three are literals in `compose.yaml` and are not read from `.env`.

Compose also reads the **root `.env` file for variable interpolation** — that
is, to fill in the `${...}` placeholders in `compose.yaml` itself. Only the
following placeholders exist, and only these values are affected:

| Placeholder in `compose.yaml`  | Default       | Effect                                   |
| ------------------------------ | ------------- | ---------------------------------------- |
| `${APP_PORT:-3000}`            | `3000`        | Host port published by Compose           |
| `${LOG_LEVEL:-info}`           | `info`        | `LOG_LEVEL` passed into the container    |
| `${APP_TIMEZONE:-Asia/Taipei}` | `Asia/Taipei` | `APP_TIMEZONE` passed into the container |

`APP_PORT` only affects the **host-side** port mapping; it is not a container
environment variable. `LOG_LEVEL` and `APP_TIMEZONE` are passed through to the
container. No other `.env` values are read by Compose, and the container never
receives the full `.env` file.

### Overriding values

Set the variable in the environment for the `docker compose` invocation, or edit
the root `.env`. Examples:

```bash
# Publish the container on host port 8080 instead of 3000
APP_PORT=8080 docker compose up -d

# Run the container with debug logging
LOG_LEVEL=debug docker compose up -d

# Set the application timezone
APP_TIMEZONE=Asia/Tokyo docker compose up -d
```

`LOG_LEVEL` must be one of `debug`, `info`, `warn`, or `error`. `APP_TIMEZONE`
must be a non-empty string. Invalid values cause the container to exit at
startup.

### Secrets

- `.env` must **never** be committed to version control. It is already listed in
  `.gitignore` and excluded from the Docker build context by `.dockerignore`.
- `.env.example` is a **reference template** listing placeholder variable names.
  It is not a production secret store and must not hold real credentials.
- No secrets are required to build or run the service at Milestone 0. When
  secrets are introduced in a later milestone, inject them at runtime (for
  example via a secret manager or a dedicated, gitignored env file that is not
  copied into the image).

## Build and start

### Build the image

```bash
docker compose build
```

This runs the three-stage `Dockerfile`: it installs all dependencies and
compiles TypeScript in a build stage, installs production-only dependencies in a
second stage, and assembles a slim runtime image that copies only the compiled
`dist/` output and production `node_modules`.

### Start the container

```bash
docker compose up -d
```

`-d` runs the container in the background.

### Build and start in one step

```bash
docker compose up -d --build
```

**Building an image vs. starting a container.** Building (`docker compose build`)
produces a reusable image from the `Dockerfile`; it does not run anything.
Starting (`docker compose up`) creates and runs a container from that image. If
the image has not been built yet, `docker compose up` builds it first, so
`--build` is only needed to force a rebuild after code changes.

## Verify service health

```bash
# Container state and health
docker compose ps

# Follow application logs
docker compose logs -f app

# Liveness endpoint
curl http://localhost:3000/api/health

# Readiness endpoint
curl http://localhost:3000/api/ready
```

These commands assume the default host port of 3000. If `APP_PORT` is customized
in the Compose environment, replace `3000` with the configured host port.

Expected liveness response:

```json
{
  "status": "ok",
  "service": "kou-news-engine",
  "version": "0.0.0",
  "uptimeSeconds": 12,
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

Expected readiness response:

```json
{
  "status": "ready",
  "checks": { "lifecycle": { "ready": true } },
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

**Container health status vs. application readiness.** These are two different
signals:

- **Container health status** (`docker compose ps`, the `STATUS` column) is
  produced by the image's `HEALTHCHECK`, which periodically calls
  `/api/health` from inside the container using Node.js native `fetch`. It
  reports whether the process is alive and answering.
- **Application readiness** (`/api/ready`) is an HTTP endpoint the application
  exposes for downstream consumers. It reports whether this process should
  receive **new** traffic.

The distinction matters during shutdown. `/api/health` is liveness and stays
`200` throughout: a draining process is alive and finishing work. `/api/ready`
becomes `503` with `checks.lifecycle.detail` of `draining`, which tells a router
to stop choosing this instance.

A container can be running before its first health check has completed; during
the `start-period` the status may show as `starting`. A `healthy` status means
the health check has passed; `unhealthy` means the configured retries were
exhausted.

### Readiness during shutdown

When a `SIGTERM` arrives, the process marks itself draining before it closes the
listener. From that point `/api/ready` answers:

```json
{
  "status": "not_ready",
  "checks": { "lifecycle": { "ready": false, "detail": "draining" } },
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

The transition is one-way. The process never reports ready again.

### In-flight requests during shutdown

Readiness is advice to a router; it does not stop one from sending traffic, and
it is not a mechanism for finishing work. The application therefore also tracks
its own requests and waits for them.

Each request is counted when it arrives and released when its response finishes
or its connection closes. After the listener is closed and idle sockets are
cleared, shutdown waits for that count to reach zero before it disposes the
runtime and exits. The wait is bounded by `SHUTDOWN_TIMEOUT_MS`: a request that
never finishes runs out the deadline, which forces sockets closed and exits `1`
without disposing the runtime.

Two limits are worth stating plainly:

- **The count is HTTP-layer, not handler-layer.** A handler that keeps awaiting
  after it sent its response, or whose client disconnected, is already released.
  A zero count does not mean all application work finished.
- **Requests accepted before draining are still served.** A connection the
  listener already accepted is not refused mid-shutdown; those requests are
  served and recorded. Refusing them would only cause the client to retry.

There is no pre-stop delay. If a load balancer needs longer than the readiness
propagation delay to stop sending traffic, that gap is not absorbed here — it
must be handled by the platform (a pre-stop hook where available) or by raising
the timeout and grace period together.

Three things this deliberately does **not** do:

- **It does not cancel in-flight requests.** A handler that has started keeps
  running. Shutdown waits for its response to finish, but it never interrupts the
  handler, and a handler still awaiting after its response was sent is not waited
  for at all.
- **It does not guarantee zero dropped requests.** Requests that reach the
  container after routing notices the change are still refused. Whether a
  request is dropped depends on how quickly the traffic source reacts.
- **It does not stop the listener by itself.** The `503` is advice to a router.
  The socket keeps accepting connections until the server is closed, which the
  same shutdown sequence does separately.

No load-balancer propagation delay or pre-stop window is configured or promised
here. `stop_grace_period` bounds how long Docker waits; it does not give a
router time to observe the `503`.

## Stop and cleanup

```bash
# Stop the running container, keeping it and the image
docker compose stop

# Stop and remove the container and the Compose network
docker compose down
```

**`stop` vs. `down`.** `docker compose stop` halts the running container but
leaves the container (and the built image) in place, so `docker compose start`
brings it back quickly. `docker compose down` stops and **removes** the
container and the Compose-created network; the built image remains and is reused
on the next `up`. There are no volumes to remove at Milestone 0, so
`docker compose down` takes no `-v` flag.

When the container is stopped, the application handles `SIGTERM`, marks itself
draining so `/api/ready` starts answering `503`, and then shuts the HTTP server
down gracefully, waiting for tracked requests to finish before exiting (see the
shutdown configuration and security notes below).

## Shutdown configuration

Stopping a container is a two-party negotiation: the application decides how long
it will spend draining, and Docker decides how long it will wait before killing
the container. Both values are configured here, and they are related.

| Setting               | Where                                                   | Value                                                 |
| --------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| `SHUTDOWN_TIMEOUT_MS` | Application env var (Zod schema in `src/config/env.ts`) | `8000` ms by default; allowed range `1000`–`60000` ms |
| `stop_grace_period`   | `compose.yaml`, `services.app`                          | `12s`                                                 |

`SHUTDOWN_TIMEOUT_MS` is the upper bound on the application's own draining phase.
It is validated at startup: a value outside `1000`–`60000` ms fails validation and
the process exits with a message naming `SHUTDOWN_TIMEOUT_MS`.

### The two values must stay ordered

The configured `SHUTDOWN_TIMEOUT_MS` must be **strictly less than** the Docker
`stop_grace_period`. The default pair (`8000` ms vs `12s`) leaves roughly four
seconds of headroom for the rest of the shutdown sequence — disposing the runtime
and exiting — after draining completes.

If `SHUTDOWN_TIMEOUT_MS` is increased, `stop_grace_period` must be increased
accordingly, keeping the same ordering. Raising one without the other means Docker
can kill the container while the application is still draining, which defeats the
purpose of the application-level timeout.

### The current Compose file does not set `SHUTDOWN_TIMEOUT_MS`

The application **supports** `SHUTDOWN_TIMEOUT_MS`, but the current
`compose.yaml` does **not** pass it into the container. The service
`environment` block lists only `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, and
`APP_TIMEZONE` — there is no `SHUTDOWN_TIMEOUT_MS` entry, and no `${...}`
placeholder for it either.

The consequences are worth stating plainly:

- Started through the current Compose configuration, the container runs with the
  application **default of `8000` ms**.
- Setting `SHUTDOWN_TIMEOUT_MS` in the **host shell** alone does not override the
  container's application environment. Compose only interpolates variables that
  the service actually references; a value exported in the shell is not forwarded
  to a container that never asks for it.
- Supporting a custom value through Compose therefore requires a **separate
  change** to the service `environment` configuration — for example adding
  `SHUTDOWN_TIMEOUT_MS: '${SHUTDOWN_TIMEOUT_MS:-8000}'` to `services.app.environment`.
  That change is not part of the current file.

Until such a change is made, `stop_grace_period: 12s` is aligned with the default
`8000` ms application timeout. Any future custom timeout introduced through
Compose must remain **strictly less than** `stop_grace_period`; raising the
application timeout without also raising the grace period would let Docker kill
the container mid-drain.

### What happens at each deadline

- **The application's deadline fires first** (normal case, because it is smaller).
  The application forces its sockets closed, logs `Shutdown timed out`, and exits
  with status `1`.
- **Docker's grace period expires first** (only if the ordering above is violated,
  or the process is wedged). Docker sends `SIGKILL`; the process cannot run any
  further cleanup. Nothing in the application can observe or prevent this.

So the application-level timeout is the mechanism that makes shutdown
_deliberate_; `stop_grace_period` is the backstop that guarantees the container
eventually dies.

### Why the application skips database disposal on timeout

On a clean shutdown the application closes the HTTP server, waits for draining to
finish, and then disposes the runtime (closing the SQLite connection). On the
**timeout** path it deliberately does **not** dispose the runtime.

The reason is that forcing sockets closed is not application-level cancellation.
A request handler that has already started keeps running after its socket is gone,
and it may still be using the SQLite connection. Closing that connection
underneath a running handler would replace a slow shutdown with a database race.
Leaving the connection open lets the process terminate while SQLite is in a
recoverable state.

### What this does not guarantee

The timeout path does **not** guarantee zero data loss. SQLite's own crash
recovery protects **database consistency** — the file stays readable and
committed transactions survive — but it does not complete business work that was
still in flight. A handler interrupted by a timeout may not finish its task, and
any work it had not yet committed is lost. The design trades completion of
in-flight work for a bounded, consistent shutdown.

## Configuration and security notes

- **Non-root runtime.** The runtime image switches to the built-in `node` user
  (`USER node`), and copied files are owned by `node:node`. The process does not
  run as root.
- **Production dependencies only.** The runtime image copies `node_modules` from
  a stage that ran `npm ci --omit=dev`, so development tooling (TypeScript,
  ESLint, Vitest, and so on) is not present in the shipped image.
- **No secrets in the image.** The `Dockerfile` copies only `package.json`,
  `package-lock.json`, the TypeScript configs, and `src/`. It never copies
  `.env`.
- **Build context is minimized.** `.dockerignore` excludes `.env` and `.env.*`,
  `node_modules`, `dist`, `coverage`, `.git`, `tests`, `docs`, IDE files, and
  logs, so local development artifacts and secrets never enter the build
  context.
- **Health check uses native `fetch`.** The `HEALTHCHECK` calls `/api/health`
  with Node.js built-in `fetch`, so no extra runtime dependency such as `curl`
  is required in the image.
- **Graceful shutdown on `SIGTERM`.** The application listens for `SIGTERM` and
  `SIGINT`, marks itself draining so `/api/ready` reports `503` while the
  listener still accepts, closes the HTTP server, waits for tracked in-flight
  requests to drain within `SHUTDOWN_TIMEOUT_MS` (default `8000` ms), disposes
  the runtime, and exits cleanly. The wait is HTTP-layer only: it does not cancel
  in-flight requests, does not guarantee zero dropped requests, and does not
  itself close the listener. `CMD` uses exec form (`["node", "dist/index.js"]`)
  so the Node.js process receives the signal directly. See
  [Shutdown configuration](#shutdown-configuration)
  for how this relates to Docker's `stop_grace_period`.

## Troubleshooting

**Port already in use.** If startup fails because the host port is taken, choose
a different host port with `APP_PORT`:

```bash
APP_PORT=8080 docker compose up -d
```

**Docker daemon unavailable.** An error such as `Cannot connect to the Docker
daemon` means the daemon is not running. Start Docker Desktop, or start the
`docker` service on Linux, then retry.

**Environment variable interpolation problems.** If a placeholder resolves to an
unexpected value, inspect the fully resolved configuration:

```bash
docker compose config
```

This prints the effective Compose configuration with all `${...}` placeholders
resolved. Remember that only `APP_PORT`, `LOG_LEVEL`, and `APP_TIMEZONE` are
interpolated from the root `.env`; `NODE_ENV`, `HOST`, and `PORT` are fixed in
`compose.yaml`. To change logging or timezone, set `LOG_LEVEL` or
`APP_TIMEZONE`.

**Container unhealthy.** Check the container state and logs:

```bash
docker compose ps
docker compose logs app
```

An `unhealthy` status means the health check failed repeatedly. Confirm the
application started by checking the logs for the `Server listening` message, and
verify the process is listening on port 3000 inside the container. A container
that exited immediately usually indicates an invalid environment variable — the
startup log names the offending field.

**Viewing application logs.** The application writes structured JSON logs. Use
`docker compose logs -f app` to follow them. Raise verbosity with
`LOG_LEVEL=debug` if more detail is needed.
