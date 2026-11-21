# kou-news-engine

AI-powered news intelligence service for Kou AI. It will collect global AI news,
translate and summarize articles into Traditional Chinese, generate daily
briefings, and deliver notifications through Kou AI and Telegram.

## Status

Milestone 0 is complete: project scaffolding, Express bootstrap, environment
validation, the health and readiness endpoints, and centralized error handling,
along with a unit and integration test suite and coverage reporting. News
collection, translation, summarization, and notification features are not
implemented yet.

## Tech Stack

- Node.js 24 (ESM)
- TypeScript (strict mode)
- Express 5
- Zod (environment validation)
- Vitest + Supertest (unit and integration tests, with V8 coverage reporting)
- ESLint + Prettier

## Requirements

- Node.js 24 (see `.nvmrc`)

## 開發環境設定 (Development Setup)

以下步驟適用於本機開發環境。

1. 確認 Node.js 版本為 24：

   ```bash
   node -v
   ```

2. 安裝相依套件：

   ```bash
   npm install
   ```

3. 建立本機環境變數檔案（由範例複製）：

   ```bash
   cp .env.example .env
   ```

   接著依需求調整 `.env` 內容。請勿將 `.env` 提交到版本控制。

4. 啟動開發伺服器：

   ```bash
   npm run dev
   ```

   伺服器預設監聽 `http://localhost:3000`。

5. 驗證服務是否正常：

   ```bash
   curl http://localhost:3000/api/health
   curl http://localhost:3000/api/ready
   ```

## Scripts

| Script               | Purpose                                           |
| -------------------- | ------------------------------------------------- |
| `npm run dev`        | Start the development server with watch mode      |
| `npm run build`      | Compile TypeScript to `dist/`                     |
| `npm run start`      | Run the compiled server with `.env`               |
| `npm run start:prod` | Run the compiled server (env injected externally) |
| `npm run typecheck`  | Type-check `src/` and `tests/`                    |
| `npm run lint`       | Lint the codebase                                 |
| `npm run format`     | Format files with Prettier                        |
| `npm run test`       | Run the test suite                                |
| `npm run ingest`     | Feed ingestion dry-run, then exit                 |
| `npm run extract`    | Article extraction dry-run, then exit             |

### One-shot CLIs

`npm run ingest` and `npm run extract` perform **no writes and no network
requests** unless `--execute` is passed. With no argument they print a
single-line JSON preview and exit `0`, so a scheduler that loses its flags
cannot start real work by accident.

```bash
npm run ingest -- --help      # usage; opens no database
npm run ingest                # dry-run preview
npm run ingest -- --execute   # real ingestion
```

Both commands exit `2` when the command line is rejected, which is distinct from
`1` (the run failed). The preview opens the database read-only: it never creates
the file and never runs a migration, so it is safe against a database that must
not change.

## API Endpoints

| Method | Path          | Description                               |
| ------ | ------------- | ----------------------------------------- |
| GET    | `/api/health` | Liveness check (no external dependencies) |
| GET    | `/api/ready`  | Readiness check                           |

Error responses use a consistent envelope:

```json
{ "error": { "code": "NOT_FOUND", "message": "Route not found" } }
```

## Project Structure

```
src/
  app.ts          Express app factory
  index.ts        Entry point
  server.ts       HTTP server lifecycle
  config/         Environment and constants
  core/           Logger, errors, HTTP handlers
  modules/health/ Health module
  modules/ingestion/  Feed fetch, parse, persistence
  modules/extraction/ Article fetch, parse, normalise, persistence
  cli/            One-shot entry points (ingest, extract)
  routes/         Route aggregation
  types/          Shared API types
```

## Environment Variables

All configuration is provided through environment variables. See `.env.example`
for the full list of placeholders. Never commit real secrets.

## Docker Deployment

The service can be built and run as a container using the included `Dockerfile`
and `compose.yaml`.

```bash
docker compose up -d --build   # build the image and start the container
curl http://localhost:3000/api/health
docker compose down            # stop and remove the container
```

The container runs the production build as a non-root user with production
dependencies only. Compose sets `NODE_ENV=production`, `HOST=0.0.0.0`, and
`PORT=3000` inside the container, and reads the root `.env` only to interpolate
`APP_PORT`, `LOG_LEVEL`, and `APP_TIMEZONE`. The local `.env` file is never
injected into the container.

**Local development vs. Docker runtime:**

- **Local development** — `npm run dev` runs TypeScript directly with watch
  mode against the local Node.js 24 toolchain, using `.env`.
- **Docker runtime** — `docker compose up` builds and runs the compiled
  `dist/` output inside the container, with configuration supplied by Compose.

See [`docs/deployment.md`](docs/deployment.md) for the full deployment guide,
including prerequisites, environment configuration, health checks, and
troubleshooting.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — architecture, module
  boundaries, request lifecycle, and the future database integration extension
  point.
- [`docs/api-conventions.md`](docs/api-conventions.md) — API base path, response
  conventions, endpoints, error envelope, and status codes.
- [`docs/deployment.md`](docs/deployment.md) — Docker build and run workflow,
  Compose configuration, environment handling, health checks, and
  troubleshooting.
