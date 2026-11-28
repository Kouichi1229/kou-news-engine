# Scheduling the Telegram notification run

The engine does not run its own scheduler. A system scheduler — cron, a systemd
timer, a container orchestrator's job — calls one command on the schedule it
wants, and that process publishes at most one article and exits.

## The command

```bash
npm run notify:scheduled
```

or, against a built image:

```bash
npm run notify:scheduled:prod
```

The entry takes **no arguments**. Any argument except `--help` exits `2` without
opening the database, so a mistyped cron line fails loudly instead of doing
something else. `--help` prints the usage and exits `0`.

`notify:scheduled` delegates to the same publish flow as `npm run notify --
--execute`: same formatter, same `article_derived` selection, same
`notification_delivery` deduplication, same exit codes. The only difference is
that the flags are settled for you.

## Publishing one category

```bash
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
database, so a bad cron line fails loudly. `notify:scheduled` does **not** pass
`--category`; use `npm run notify -- --execute --category <category>` when a
schedule needs a single category.

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

The same command is what the scheduler runs; there is no separate dry-run and no
in-process loop.
