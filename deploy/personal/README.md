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

With `PERSONAL_MODE=1` an empty database stays empty on boot: no demo seed, no placeholder user and no starter team. Sign-in and the Chief bot onboarding arrive in T02 and T03.

## Tests

```bash
npm test                    # unit tests; a few need Redis/Postgres and fail without them
npm run typecheck && npm run server:typecheck
npm run lint
```

`npm test` without Redis or a `cumora` database reports five failures in the realtime and post-spawn retry suites. They are environment failures, not regressions.
