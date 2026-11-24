# API Conventions

This document describes the HTTP API conventions of Kou News Engine as they exist
today (Milestone 0). It reflects actual behavior.

## Base path

All endpoints are served under the `/api` base path. Routes registered outside
`/api` do not exist and return `404`.

Example: `GET /api/health`.

## Content type

- Responses are `application/json` (`Content-Type: application/json`).
- Requests that carry a body must send `Content-Type: application/json`.

## Request conventions

- JSON request bodies are parsed by `express.json()`.
- A malformed JSON body is rejected before reaching any route handler and returns
  `400` with the standard error envelope (see below).
- The framework signature header `X-Powered-By` is disabled and is never sent.

## Endpoints

### `GET /api/health`

Liveness check. Reports that the process is running. It performs no external
dependency checks.

Response `200`:

```json
{
  "status": "ok",
  "service": "kou-news-engine",
  "version": "0.0.0",
  "uptimeSeconds": 12,
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

### `GET /api/ready`

Readiness check. Reports whether this process should receive **new** traffic.

Readiness is not liveness. A process that is finishing work is still alive — it
is simply no longer a candidate for new requests. `/api/health` covers liveness;
`/api/ready` covers routing.

The `checks` object carries one entry per injected dependency, keyed by the
probe's name. Every entry has the shape `{ "ready": boolean, "detail"?: string }`,
and `detail` is a stable reason code — never SQL, a file path, or an exception
message.

One entry exists today:

| Key         | Meaning                                                |
| ----------- | ------------------------------------------------------ |
| `lifecycle` | Whether the process is shutting down. Always injected. |

A `database` entry will join this object when the SQLite probe is wired in.

Response `200`:

```json
{
  "status": "ready",
  "checks": { "lifecycle": { "ready": true } },
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

#### Draining

Once graceful shutdown begins the process transitions to draining, permanently,
and readiness answers `503`:

```json
{
  "status": "not_ready",
  "checks": { "lifecycle": { "ready": false, "detail": "draining" } },
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

The transition is one-way: there is no reset, and a draining process never
reports ready again.

What this does **not** mean:

- A `503` does not stop the listener. The socket keeps accepting connections
  until the server is closed separately; readiness only tells a router to stop
  choosing this instance.
- A `503` does not cancel in-flight requests. Handlers that already started run
  to completion.
- A `503` does not guarantee zero dropped requests. Requests that arrive after
  routing notices the change are still refused.

If the service were not ready for any other reason, the response would also be
`503` with `"status": "not_ready"`.

## Standard error envelope

Every error response uses the same envelope:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route not found"
  }
}
```

- `code` — a stable, machine-readable identifier.
- `message` — a human-readable description.

## HTTP status code conventions

| Status | Meaning                      | Example `code`   |
| ------ | ---------------------------- | ---------------- |
| `200`  | Success                      | —                |
| `400`  | Malformed or invalid request | `BAD_REQUEST`    |
| `404`  | Route or resource not found  | `NOT_FOUND`      |
| `500`  | Unexpected server error      | `INTERNAL_ERROR` |
| `503`  | Service not ready            | —                |

Codes are stable identifiers; clients should branch on `code`, not on `message`
text.

## Production error disclosure policy

- Errors the application marks as safe to expose (for example `NOT_FOUND`) return
  their message to the client.
- All other errors return a generic body:

  ```json
  { "error": { "code": "INTERNAL_ERROR", "message": "Internal server error" } }
  ```

- **Stack traces, parser details, and internal error messages are never sent to
  clients.** Unexpected server errors are logged server-side at `error` level
  instead.
- Malformed JSON returns a fixed, non-descriptive message
  (`"Invalid JSON request body"`) so that parser internals are not disclosed.

## Versioning

No API version prefix is used at Milestone 0. If versioning is introduced later,
it will be documented here.
