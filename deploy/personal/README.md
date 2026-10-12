# Personal bot — local development

Design: [docs/personal-bot](../../docs/personal-bot/). Production packaging (Docker Compose) lands in task T27.

## Prerequisites

| Tool | Notes |
| --- | --- |
| Node 22+ | CI runs Node 24. |
| Postgres 16+ | Homebrew `postgresql@16` or newer. pgvector is optional; without it memory falls back to recency only. |
| Redis 7 | Required: pub/sub, presence and runtime state. The server exits if it cannot reach `REDIS_URL`. |

With Homebrew:

```bash
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
```

## First run

```bash
createdb cumora
npm run setup                                   # root + Cloudflare worker deps
cp deploy/personal/dev.env.example .env         # then fill OPENAI_API_KEY
npm run dev:all                                 # migrate, then Vite :5180 + API :5181
```

`npm run electron:dev` opens the desktop shell against the same servers.

With `PERSONAL_MODE=1` an empty database stays empty on boot: no demo seed, no placeholder user and no starter team. The Chief bot onboarding arrives in T03.

## Signing in

The example env turns on local login, so no OAuth app is needed. On boot the API prints:

```
[personal] one-time login (single use, expires in 10 min): http://localhost:5180/#login=…
```

Open it in the browser. The first login creates the deployment's only account and its workspace; later logins (a fresh link after a server restart) sign back into that account. In personal mode the server refuses every other new account, whether it arrives through OAuth or waitlist approval, and refuses creating a second workspace.

The API binds to `127.0.0.1` here. If the Vite proxy cannot reach it because `localhost` resolves to `::1` first on your machine, start Vite with `CUMORA_DEV_API_TARGET=http://127.0.0.1:5181`.

## First sign-in and the bot host

The first sign-in creates the Chief bot, a pinned "总群" group with you and Chief, and your DM with Chief. Until a computer is paired the app shows a waiting screen.

Pair the daemon on this machine with the bootstrap secret instead of a pairing code. The daemon does not read `.env`, so pass the secret in its environment:

```bash
CUMORA_PERSONAL_BOOTSTRAP_TOKEN="$(grep ^PERSONAL_BOOTSTRAP_TOKEN= .env | cut -d= -f2-)" \
  ./bin/cumora agent computer --server http://127.0.0.1:5181
```

With no `~/.cumora/computer.json` it pairs itself, waiting and retrying every 15 seconds if you have not signed in yet, and every bot without a computer moves onto it. The secret only works for the workspace's first computer: once one is paired the endpoint answers 410, and re-pairing uses that computer's reconnect code like any Cumora computer. It is never sent to a server you did not name with `--server` or `CUMORA_SERVER_URL`.

The Chief runs on the built-in `loop` engine: no CLI to install, but the daemon itself needs `OPENAI_API_KEY` in its environment (add it next to the bootstrap token above). Without it the Computers tab lists `loop` as blocked with that reason. `CUMORA_DEFAULT_LOOP_MODEL` overrides the default `gpt-5.5`, and `OPENAI_BASE_URL` points it at a compatible endpoint. `./bin/cumora agent computer --doctor` checks both model tiers.

## Connectors

The 工作台 (Console) entry in the Rail, or the 我 page on mobile, lists connectors. Adding one takes three steps:

1. Source: paste YAML you wrote, or give an OpenAPI 3 document (its URL or the text). An import turns every operation into a write action.
2. Mark read / write: downgrade the GET/HEAD actions that only read. Other methods stay write. A connector cannot be enabled until every marking is confirmed (YAML you wrote counts as confirmed).
3. Credentials and test: set the API key (sealed in the browser for the bot host) and try a read action; the console shows the first 2KB, with the key redacted. Test calls run on the bot host, so it must be online.

Then enable it, and turn on "临时任务可读" so bots may call its read actions when you ask them directly. A bot can propose a connector with `cumora connector draft`; it shows up as "bot 起草，待你确认" with every action write. Only https hosts on public addresses are reachable, and write actions are refused until approvals land. Every call and every refusal is recorded in the bot's run timeline.

## Tests

```bash
npm test                    # unit tests; a few need Redis/Postgres and fail without them
npm run typecheck && npm run server:typecheck
npm run lint
```

`npm test` without Redis or a `cumora` database reports five failures in the realtime and post-spawn retry suites. They are environment failures, not regressions. Without a `.env`, export a dummy `OPENAI_API_KEY` first: `env.ts` exits at import otherwise.

### End-to-end

```bash
createdb cumora_e2e
npm run test:e2e
```

This boots a real server and daemon against a replayed model (`server/src/__e2e__`). It needs Postgres and Redis; without them the test is skipped, and with `E2E_REQUIRED=1` (CI) it fails instead. The database name must end in `_e2e`, because every run drops its public schema. `E2E_VERBOSE=1` streams the server and daemon logs.
