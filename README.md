# zryth-backend

The control plane between the Zryth Dashboard, Supabase, Vobiz, LiveKit and the voice
agent's webhook server. The browser only ever talks to this API; all secrets live here
or on the agent. See [../ARCHITECTURE.md](../ARCHITECTURE.md) for the full picture.

## Run locally
    # 1. agent webhook server (knowledge ingest/delete, summaries)
    cd "zryth voice agent/Zryth-Voice-agent" && .venv/Scripts/python -m uvicorn webhook_server:app --host 127.0.0.1 --port 8000
    # 2. backend
    cd zryth-backend && npm run dev                      # :3000
    # 3. dashboard
    cd "Zryth Dashboard" && npm run dev                  # :5173
    # 4. voice worker (calls, heartbeat, knowledge sync)
    cd "zryth voice agent/Zryth-Voice-agent" && .venv/Scripts/python agent.py dev

`AGENT_SHARED_SECRET` here must equal `SUPABASE_WEBHOOK_SECRET` in the agent's `.env`.

## Database
Run in the Supabase SQL editor, in order:
1. `deploy/lock-down-rls.sql` — RLS on every table; browser keeps only its own `users` row
2. `db/002_multitenant.sql` — organizations, agent templates, agents, phone numbers, tenant columns

## API (all under `/api`, all need `Authorization: Bearer <supabase access token>`)
Every route is scoped to the caller's organization (`req.org`, resolved server-side).

| Method | Path | Purpose |
|---|---|---|
| GET | /account/me | user, organization, admin flag |
| DELETE | /account/me | delete account (blocked while the org rents numbers) |
| GET | /agents/templates | published templates to pick from |
| GET/POST | /agents | org's agents / create from a template |
| PUT/DELETE | /agents/:id | edit details / delete (not while a number is bound) |
| GET | /numbers | org's numbers + limit |
| GET | /numbers/inventory | Vobiz stock to buy |
| POST | /numbers/purchase | reserve → buy → route to trunk → LiveKit |
| POST | /numbers/:id/retry | re-run routing after a failed setup |
| POST | /numbers/:id/bind | connect number → agent (permanent) |
| GET/POST/DELETE | /knowledge, /knowledge/:name/url | per-agent knowledge (`agent_id`) |
| GET | /calls, /calls/:id | org's calls + transcript |
| POST | /calls/:id/summary | AI summary (via agent) |
| GET | /metrics, /status | org totals, voice platform health |
| * | /admin/... | `ADMIN_EMAILS` only: templates + their prompts/tools, prompts, tools, org number limits, raw Vobiz numbers |

## Deploy
`npm ci && npm run build`, copy `.env.production` to `/opt/zryth-backend/.env`, install
`deploy/zryth-backend.service`, and use `deploy/nginx.conf` for aicalling.wrytflow.com.
