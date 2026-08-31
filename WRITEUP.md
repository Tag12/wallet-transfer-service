# Wallet / P2P Transfer Service — Write-up

## Links
- **Live app:** https://wallet-transfer-service.onrender.com
- **Repo:** https://github.com/Tag12/wallet-transfer-service
- **Public logs:** https://telemetry.betterstack.com/dashboards/Oo1vkb/charts/20660771892
- **Run the correctness gate** (concurrent first-transfers + same-key retries against the live URL):
  ```bash
  JWT_SECRET="<same secret set on Render>" npm run burst -- https://wallet-transfer-service.onrender.com 25 25
  ```
  It funds a fresh user from a seeded faucet, fires N concurrent distinct-key transfers + M concurrent same-key retries, and asserts conservation, exactly-once wallet creation, single-apply retries, and zero 5xx.

## Data model
Two tables, all money as integer **paise** in `BIGINT` (never float).

- **`wallets`** — `user_id TEXT PK` (= JWT `sub`), `balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0)`, `created_at`. The `CHECK` is the last-line backstop against overspend even if application logic were wrong.
- **`transfers`** — `id UUID PK`, `from_user`, `to_user`, `amount_paise BIGINT CHECK (amount_paise > 0)`, `idempotency_key`, `request_hash`, `resulting_balance_paise`, `status` (`successful`/`rejected`), `error_code`, `error_status`, `created_at`, with `UNIQUE (from_user, idempotency_key)`. This table doubles as the ledger and the idempotency record.

**No FK** from `transfers` to `wallets` — deliberately. An FK makes Postgres take a `FOR KEY SHARE` lock on the referenced wallet row at insert time; combined with our own later `FOR UPDATE`, concurrent transfers between the same pair would deadlock on lock upgrade. Referential integrity is guaranteed anyway because both wallets are created earlier in the same transaction before the transfer commits.

## Get-or-create + transfer safety (the crux)
Everything happens in **one transaction**:

1. **Idempotency guard first** — `INSERT INTO transfers (…) RETURNING *`, wrapped in a `SAVEPOINT`. A unique-violation (`23505`) means this key was already used → `ROLLBACK TO SAVEPOINT`, read the existing row, and replay its frozen outcome (see below).
2. **Race-free wallet creation** — `INSERT INTO wallets … ON CONFLICT DO NOTHING` for both parties. No read-then-write, so two concurrent first-transfers can never both insert.
3. **Deterministic locking** — both wallets are created *and* locked (`SELECT … FOR UPDATE`) in the **same sorted `user_id` order**. This is the key detail: creating in `(from, to)` order while locking in sorted order reintroduces an AB-BA deadlock for opposite-direction concurrent first-transfers. Sorting both makes every transaction acquire locks in one global order → no deadlock.
4. **Balance check** under the lock, then debit/credit, then stamp `status`/`resulting_balance_paise`.

**Simplest correct mechanism:** a plain upsert + row locks + a unique idempotency key, all inside one DB transaction. **Heavier alternatives rejected:** advisory locks, `SERIALIZABLE` isolation with a client-side retry loop, a per-account queue/actor, a Redis distributed lock, and the naive find-then-insert (the classic race that 500s). None are needed — the database's own constraints and row locks give us correctness for free.

## Idempotency
- The key is scoped **per caller**: `UNIQUE (from_user, idempotency_key)` — the same key from different users is independent.
- `request_hash = sha256(to_user:amount_paise)`. A retry with the **same key but a different body** is detected by hash mismatch and returns **409**.
- The outcome is **frozen** at commit (`resulting_balance_paise` for success; `error_code`/`error_status` for rejection). A replay returns the stored outcome **verbatim** — never re-evaluated against current balance, so a later unrelated transfer can't change what an earlier replay returns.
- The guard insert sits **inside the same transaction as, and before,** the balance mutation, so replay-protection and money movement commit or roll back atomically.
- **Rejections are idempotent too:** an insufficient-funds decision is *committed* (not thrown/rolled back), so retrying the same key replays the original 402. A caller who tops up and wants to send again must use a **new** key — one key = one payment intent. An unexpected/infra error, by contrast, rolls the whole transaction back (leaving no record) and is safely retryable.
- **No expiry** on idempotency keys currently (see Limitations).

## Identity & authorization
JWT (HS256). The caller's identity comes **only** from the verified token's `sub` claim — never a header or body field. A transfer can be read only by a participant (`from_user` or `to_user`); anyone else gets 403.

## Consistency vs. availability
For a money workload the transfer path favors **consistency (CP), fail-closed**: if the datastore is unavailable we reject rather than risk a double-spend, and `/readyz` reports not-ready when the DB is unreachable so the platform stops routing traffic. The read path (`GET /accounts/me`) hits the same primary and tolerates mild staleness under load; no caching in v1 to keep the surface small (a read replica would be the scaling step). **Honest caveat:** a `statement_timeout` isn't configured yet, so "fail fast when the DB is slow" currently relies on the platform/connection timeouts rather than a per-statement bound — that's the first hardening I'd add.

## Edge cases
| Case | Response |
|---|---|
| Insufficient funds | 402 (committed + frozen, so replays return 402) |
| Self-transfer | 400 |
| Unknown recipient | wallet auto-created as part of the transfer |
| Retry, same key + same body | 200, original outcome replayed |
| Retry, same key + different body | 409 |
| Negative / zero amount | 400 |
| Missing / invalid / expired token | 401 |
| Reading a transfer you're not part of | 403 |

## Containerization / deploy / observability
- **Container:** multi-stage Dockerfile → small `node:20-alpine` runtime, **non-root** user, container `HEALTHCHECK` on `/healthz`. `docker-compose.yml` brings up app + Postgres in one command; migrations run on boot. 12-factor: everything sensitive via env (`DATABASE_URL`, `JWT_SECRET`, `DB_SSL`, `LOGTAIL_*`), nothing committed.
- **Deploy:** the container **image** (not a buildpack) is built and run on **Render** (free web service), backed by **Neon** free managed Postgres.
- **Observability:** structured JSON logs, one line per event, with a **correlation id (`requestId`) per request**. Meaningful events are logged: `transfer.applied`, `transfer.rejected.insufficient_funds`, `transfer.replay`, `transfer.conflict`, `auth.failed`. Logs ship to **Better Stack** (public dashboard link above). `/metrics` exposes request count, error rate, latency (incl. **p99**), and transfers applied/rejected.
- **A note on the logs:** a no-op `ON CONFLICT` wallet insert can't be distinguished from a genuine concurrent race-loser, so rather than mislabel every pre-existing wallet as a "race lost" it's logged at `debug` as `wallet.create_skipped`; default (`info`) output stays clean and meaningful.
- **A note on metrics:** they're in-memory and per-instance (reset on restart, and a plain-text format rather than full Prometheus exposition) — fine for a single free-tier instance; a shared store / `prom-client` histogram would be the next step.

## Known limitations / trade-offs
- **Faucet in prod:** the migration seeds a `faucet` wallet so the burst script can fund a fresh user (the API deliberately has no deposit endpoint). Anyone with `JWT_SECRET` can mint from it — acceptable for this exercise, but it's a test-only artifact.
- **No idempotency-key expiry:** keys live forever on the ledger; a production system would age them out.
- **Free-tier cold start:** Render sleeps the service after ~15 min idle and Neon auto-suspends, so the first request after idle can take ~30–50s. The `pg` `sslmode` deprecation warning at boot is benign.

## AI usage (directed vs. decided)
I used an AI assistant (Claude), and drove the design decisions myself. **I directed:** the choice of Express + raw `pg` (no ORM, so the locking/transaction logic stays legible), the "one key = one payment intent" idempotency semantics (including committing rejections so they replay), the CP/fail-closed stance, and the deliberate decision to keep the surface tiny. **The AI helped me** implement the service, write the migrations and tests, and stress-test the concurrency — notably it surfaced a bidirectional get-or-create deadlock (opposite-direction first-transfers), which I verified via a stress test, fixed by sorting the wallet-creation order to match the lock order, and confirmed resolved.

## Cost
Everything runs on free tiers — **₹0**:
- **Render** — free web service (Docker), sleeps when idle.
- **Neon** — free managed Postgres, auto-suspends when idle.
- **Better Stack** — free log ingestion + public dashboard.

No paid resources, no credit card required for the running stack.
