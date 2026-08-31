# Wallet / P2P Transfer Service

A small wallet service where users hold an integer-paise balance and transfer to each other. Built for correctness under concurrency and retries: money is conserved, retries never double-apply, get-or-create is race-free, and identity comes only from a verified JWT.

- **Live app:** https://wallet-transfer-service.onrender.com
- **Public logs:** https://telemetry.betterstack.com/dashboards/Oo1vkb/charts/20660771892
- **Design write-up:** [`WRITEUP.md`](./WRITEUP.md)

## For evaluators — reproduce the gate in one command (no clone)
Fires the concurrency gate at the live service using only **Node 18+** (zero install, zero clone). `JWT_SECRET` is provided separately in the submission — it must match the deployed server's:

```bash
curl -sL https://raw.githubusercontent.com/Tag12/wallet-transfer-service/main/scripts/burst-standalone.cjs \
  | BASE_URL=https://wallet-transfer-service.onrender.com JWT_SECRET="<secret>" node -
```

It creates two brand-new users, funds one from the seeded faucet, fires 20 concurrent first-transfers (distinct keys) + 20 concurrent retries (one shared key), and asserts money is conserved, wallets are created exactly once, retries apply once, and there are no 5xx. It uses fresh users each run, so re-run it as many times as you like. Then watch the [public logs](https://telemetry.betterstack.com/dashboards/Oo1vkb/charts/20660771892). Pass counts to scale it: `… node - 50 50`.

> Note: this is a free-tier deploy — the first request after ~15 min idle cold-starts (~30–50s), then it's fast.

## Stack
Node + TypeScript · Express · PostgreSQL (raw `pg`, no ORM) · JWT (HS256) · Docker · Jest.

## Quick start (Docker — one command)
Brings up the app + Postgres together; migrations run automatically on boot.

```bash
docker compose up --build
```

The API is then on `http://localhost:3000`. `JWT_SECRET` defaults to `dev-secret-change-me` (override via env). Tear down with `docker compose down` (add `-v` to drop the database volume).

## Local dev (without Docker)
Requires a running Postgres. Copy the example env and fill in the values:

```bash
cp .env.example .env         # edit DATABASE_URL, JWT_SECRET, etc.
npm install
npm run dev                  # ts-node; runs migrations on boot, then listens
```

Note: the app does **not** auto-load `.env` (no `dotenv` dependency), so export the vars first, e.g.:

```bash
set -a; source .env; set +a
npm run dev
```

## Environment variables
| Var | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `JWT_SECRET` | yes | HS256 secret used to verify (and, for the burst script, sign) tokens |
| `DB_SSL` | no | `true` for managed Postgres that requires SSL (e.g. Neon); unset for local |
| `PORT` | no | Listen port (default `3000`; the host platform may inject its own) |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error` (default `info`) |
| `LOGTAIL_SOURCE_TOKEN` | no | Better Stack source token; when set, logs ship there too |
| `LOGTAIL_ENDPOINT` | no | Better Stack ingesting host (e.g. `https://sXXXX.…betterstackdata.com`) |

## API
All endpoints except health/readiness require `Authorization: Bearer <jwt>` (identity taken from the token's `sub`).

| Method | Path | Description |
|---|---|---|
| `POST` | `/accounts` | Get-or-create the caller's wallet → `{ balance }` (idempotent) |
| `GET` | `/accounts/me` | Caller's balance → `{ balance }` |
| `POST` | `/transfers` | `{ to_user, amount_paise, idempotency_key }` → `{ transfer_id, new_balance }` |
| `GET` | `/transfers/:id` | Transfer details (participants only) |
| `GET` | `/healthz` | Liveness |
| `GET` | `/readyz` | Readiness (checks the datastore) |
| `GET` | `/metrics` | Request count, error rate, latency (incl. p99), transfers applied/rejected |

## Tests
Require a reachable Postgres (they run migrations and truncate between cases). Run against a throwaway DB:

```bash
# start a local Postgres, then:
DATABASE_URL="postgres://wallet:wallet@localhost:5432/wallet" \
JWT_SECRET="test-secret" DB_SSL=false \
npm test
```

Covers the concurrency gate (conservation, exactly-once wallet creation, single-apply retries, bidirectional no-deadlock), idempotency, auth, and the HTTP surface.

## Correctness gate (burst script)
Fires many concurrent first-transfers + many concurrent same-key retries at a running service and asserts money is conserved, wallets are created exactly once, retries apply once, and there are no 5xx.

```bash
JWT_SECRET="<same secret as the server>" \
  npm run burst -- <base_url> [firstTransferCount] [retryCount]

# against the live service:
JWT_SECRET="<render secret>" \
  npm run burst -- https://wallet-transfer-service.onrender.com 25 25
```

It funds a fresh user from a seeded `faucet` wallet (the API has no deposit endpoint by design), so `JWT_SECRET` must match the target server's.

## Deploy
The container image (not a buildpack) runs on Render, backed by Neon managed Postgres, with logs shipped to Better Stack. See [`WRITEUP.md`](./WRITEUP.md) for the design, trade-offs, and cost notes.
