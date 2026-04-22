# Self-hosted prompt evolution

A thin Docker wrapper around `claude-overnight-evolve` — container + mounted
output dir + optional HTTP enqueue/read API.

Use this if you want to:

- Run evolution on a VPS so your laptop can be off.
- Expose a small HTTP API to kick off runs and browse results.
- Keep everything on infrastructure you control.

For one-off smoke tests, skip Docker and run `npx claude-overnight-evolve …`
directly.

## Quick start — one-shot run

```sh
cd self-host
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL if using a proxy)

docker compose --profile oneshot run --rm evolve \
  --prompt 10_planning/10-3_plan \
  --generations 3 \
  --population 4
```

Output lands in `./out/<runId>/` (bind-mounted from `/out` in the container):

```
out/<runId>/
  meta.json        run config + status
  matrix.jsonl     one line per variant per generation
  learning.jsonl   mutation history
  best.md          best variant with scores
  report.md        human-readable report
  prompts/         every variant's full text
```

## Daemon mode — enqueue via HTTP

```sh
docker compose up -d server
curl http://localhost:8787/
# { "ok": true, "store": "/out" }
```

Kick off a run:

```sh
curl -X POST http://localhost:8787/runs \
  -H 'content-type: application/json' \
  -d '{
    "target": "claude-overnight",
    "prompt": "10_planning/10-3_plan",
    "evalModel": "claude-haiku-4-5",
    "generations": 5,
    "env": { "ANTHROPIC_BASE_URL": "https://openrouter.ai/api/v1" }
  }'
# { "runId": "run-17…", "pid": 42, "args": [...] }
```

Then:

| Request | Returns |
|---|---|
| `GET /runs` | list of runs with meta |
| `GET /runs/<id>` | meta + report.md + best.md inline |
| `GET /runs/<id>/log` | stdout+stderr (tail via `watch curl`) |
| `GET /runs/<id>/files/<name>` | raw artefact (e.g. `matrix.jsonl`) |
| `DELETE /runs/<id>` | remove a run directory |

Set `SELF_HOST_TOKEN=<secret>` in `.env` to require
`Authorization: Bearer <secret>` on every request. Leaving it empty is fine on
a private network; don't expose an unauthenticated server to the public internet.

## Evolving a prompt that lives in another repo

For `--target mcp-browser` (or any run that needs to read files from a
specific repo), bind-mount that repo at `./workspace`:

```sh
# from self-host/
ln -s /path/to/MCP-browser workspace
docker compose --profile oneshot run --rm evolve \
  --target mcp-browser \
  --prompt-kind plan-supervision \
  --generations 5
```

The container's working directory is `/workspace`, so relative paths in the
adapter resolve against whatever you mounted there.

## Using a non-Anthropic provider

The engine speaks the Anthropic Messages protocol. Anything that speaks it
works — Anthropic direct, OpenRouter, Kimi, DashScope, a local proxy. Set
`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` in `.env`, or pass them per-run via
the `env` object on `POST /runs`.

## Updating the CLI

The image pins `claude-overnight` at build time. To pull a new version:

```sh
CLAUDE_OVERNIGHT_VERSION=1.52.0 docker compose build --no-cache
```

Or leave `CLAUDE_OVERNIGHT_VERSION=latest` (the default) and rebuild
periodically.

## What this is not

- Not multi-tenant. One daemon, one output directory, one set of creds.
- No built-in scheduler. Combine with cron / systemd if you want recurring
  runs.
- No UI. Read `report.md` in your editor, or wire the JSON endpoints into
  whatever dashboard you like.
