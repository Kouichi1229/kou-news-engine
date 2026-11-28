# Scheduling the notification run

## The daily pipeline (`npm start`)

The server registers one in-process schedule when it starts listening. By default
it fires at **08:00 every day in `APP_TIMEZONE` (Asia/Taipei)**, and runs three
steps in order:

| Step    | Command equivalent             | Cap         |
| ------- | ------------------------------ | ----------- |
| ingest  | `npm run ingest -- --execute`  | one pass    |
| extract | `npm run extract -- --execute` | 5 articles  |
| notify  | `npm run notify -- --execute`  | one article |

`SCHEDULE_CRON` overrides the time, for example `SCHEDULE_CRON='*/2 * * * *'` for
a two-minute local test. The expression is validated with `node-cron` at startup:
a typo stops the process with `Invalid SCHEDULE_CRON expression ...` instead of
silently never firing. Overlapping runs are suppressed (`noOverlap`), and
`SIGTERM`/`SIGINT` stops future fires before the server drains.

Every step's exit code is logged; a failing step does not cancel the rest, so a
broken feed cannot block the articles already stored from being published.

## Quota protection

Three limits keep a free-tier Gemini key from being exhausted:

- **Run cap.** `extract --execute` processes at most **5** articles per run. Pass
  `--limit <n>` (1–100) to change it for one invocation; a value outside that
  range, a missing value, or the flag twice exits `2` without opening the
  database.
- **Cooldown.** Calls to the real provider are spaced a fixed **4 seconds** apart
  within a run. The `fake` provider builds no hook, so nothing is paced.
- **429 stop.** When the provider answers `429`, the run stops before the next
  article is claimed, logs `Stopping extraction: the LLM provider reported a rate
limit (HTTP 429)`, and exits `0`. The alert-free articles stay queued for the
  next run.

## External scheduling

The engine also runs fine without the in-process schedule. A system scheduler —
cron, a systemd timer, a container orchestrator's job — can call one command on
the schedule it wants, and that process publishes at most one article and exits.

## The command

```bash
npm run notify:scheduled
```

or, against a built image:

```bash
npm run notify:scheduled:prod
```

The entry takes **no required arguments**. The only flag it accepts besides
`--help` is the optional `--category <category>`. Any other argument, and any
unknown category, exits `2` without opening the database, so a mistyped cron line
fails loudly instead of doing something else. `--help` prints the usage and exits
`0`.

`notify:scheduled` delegates to the same publish flow as `npm run notify --
--execute`: same formatter, same `article_derived` selection, same
`notification_delivery` deduplication, same exit codes. The only difference is
that the flags are settled for you.

## Publishing one category

Both notification commands accept the same optional flag:

```bash
npm run notify:scheduled -- --category 財經
npm run notify -- --execute --category 財經
```

`--category` narrows the selection to one of the nine fixed categories (國際,
政治, 財經, 科技, 社會, 生活, 健康, 娛樂, 體育). Everything else is unchanged: the
newest article of that category is published, one message per run, and an article
already recorded in `notification_delivery` is skipped rather than sent again.

Without the flag the run publishes the newest derived article of any category,
exactly as before. A record derived before categories existed has no category, so
a filtered run never picks it up; an unfiltered run still can.

An unknown label — including a misspelling, a value with stray whitespace, or the
flag given twice — exits `2` with the full list in the message and opens no
database, so a bad cron line fails loudly. The `--category=<value>` spelling is not
recognised and is rejected as an unknown argument.

`notify:scheduled` only parses the flag and forwards it. It opens no database of
its own, and it adds no publishing logic: the article selection, the formatter, the
`notification_delivery` deduplication and the exit codes all come from the same
flow `npm run notify -- --execute` uses.

One deployment can therefore run several schedules against one database, each with
its own category:

```cron
# Every 15 minutes, financial news only.
*/15 * * * * cd /srv/kou-news-engine && /usr/bin/npm run notify:scheduled -- --category 財經 >> /var/log/kou-notify-finance.log 2>&1
```

## Environment

Everything the run needs comes from the environment. Nothing is hard-coded, so
the same command serves any deployment.

| Variable             | Required | Meaning                                                                                                               |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_PATH`      | no       | Database to read. Defaults to the engine's usual path (see `src/config/constants.ts`). Set it to pin a specific file. |
| `TELEGRAM_BOT_TOKEN` | **yes**  | Bot credential. A blank value counts as missing.                                                                      |
| `TELEGRAM_CHAT_ID`   | **yes**  | Destination chat. A blank value counts as missing.                                                                    |
| `LOG_LEVEL`          | no       | `debug` / `info` / `warn` / `error`. Defaults to `info`.                                                              |

`npm run notify:scheduled` loads `.env` when the file exists
(`--env-file-if-exists=.env`); `notify:scheduled:prod` does not, so a container
must supply these variables directly.

## Minimal crontab

```cron
# Every 15 minutes: publish the newest derived article, if it has not been sent.
*/15 * * * * cd /srv/kou-news-engine && /usr/bin/npm run notify:scheduled >> /var/log/kou-notify.log 2>&1
```

Notes:

- `cd` first: npm needs the project directory, and cron starts in `$HOME`.
- Use absolute paths for `npm` and for any log file; cron has a minimal `PATH`.
- Redirect both streams. The command writes one JSON document per run: a success
  to stdout, a failure to stderr.
- Do not use `*/15` with a `>>` log you never rotate; see `logrotate` if the
  volume matters.

## Exit codes

| Code          | Meaning                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`           | The run succeeded: `sent`, `skipped` (already published) or `no-article`.                                                                         |
| `1`           | The run failed: Telegram refused or was unreachable, credentials are missing, the database could not be read or written. The reason is on stderr. |
| `2`           | The command line was rejected. No database was opened and nothing was sent.                                                                       |
| `130` / `143` | Interrupted by SIGINT / SIGTERM.                                                                                                                  |

A non-zero exit is the only signal cron needs; per-run details are in the JSON
documents on stdout and stderr.

## The summary line

Every run ends with one summary document on stdout, whatever the outcome:

```json
{
  "summary": { "sent": 1, "skipped": 0, "failed": 0 },
  "results": [{ "articleId": "a1", "outcome": "sent" }]
}
```

- `summary` counts the articles handled: `sent`, `skipped`, `failed`.
- `results` lists each one with its `articleId` and, for a failure, its `reason`.

The line is present even when the failure document went to stderr, so a wrapper
can count runs with one `tail -1` and no knowledge of the outcome shapes. One
invocation handles at most one article, so each count is `0` or `1`; the summary
is a ledger entry, not a batch report.

### Failure documents worth alerting on

| `status` | `reason`                                               | Meaning                                                                                                                                               |
| -------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed` | `not_configured`                                       | `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` missing. Nothing was sent.                                                                                 |
| `failed` | `api_rejected` / `http_status` / `network` / `timeout` | Telegram did not accept the message. Nothing was recorded, so the next run retries.                                                                   |
| `failed` | `delivery-not-recorded`                                | The message **was** delivered but the record could not be written. It carries `articleId` and `messageId`; the next run will send that article again. |

## Running it once, by hand

```bash
DATABASE_PATH=/tmp/scratch.db TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
  npm run notify:scheduled
```

The same command is what an external scheduler runs; the in-process schedule calls
the same entry function, so there is no separate dry-run and no second
implementation.
