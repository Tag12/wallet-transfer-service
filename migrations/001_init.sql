CREATE TABLE IF NOT EXISTS wallets (
  user_id       TEXT PRIMARY KEY,
  balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No FK from transfers.from_user/to_user to wallets(user_id) by design: Postgres takes
-- an implicit FOR KEY SHARE lock on the referenced wallet row at INSERT time to enforce
-- an FK, ahead of our own explicit FOR UPDATE locking later in the same transaction.
-- Under concurrent transfers between the same two users, every transaction ends up
-- holding a shared FK lock while trying to escalate to an exclusive lock on the same
-- rows -> lock-upgrade deadlock. Referential integrity is already guaranteed without
-- an FK: ensureWalletExists() creates both wallets earlier in the same transaction
-- before the balance mutation commits, so a transfer row can never outlive/precede
-- its wallets.
CREATE TABLE IF NOT EXISTS transfers (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user               TEXT NOT NULL,
  to_user                 TEXT NOT NULL,
  amount_paise            BIGINT NOT NULL CHECK (amount_paise > 0),
  idempotency_key         TEXT NOT NULL,
  request_hash            TEXT NOT NULL,
  -- The caller's resulting balance, captured once at the moment this transfer
  -- committed. Nullable only for the instant between the idempotency-guard INSERT
  -- and the balance UPDATE within the same transaction — by the time any other
  -- transaction can see this row (i.e. after commit), it is always populated.
  -- Idempotent replay returns this stored value verbatim rather than the wallet's
  -- current balance, since "the original outcome" includes new_balance and a
  -- later unrelated transfer must not change what a replay of an earlier one returns.
  resulting_balance_paise BIGINT,
  -- 'successful' | 'rejected'. Nullable only transiently before commit, same as
  -- resulting_balance_paise. Deterministic business-rule rejections (e.g.
  -- insufficient funds) are committed here too, not rolled back, so a retry with
  -- the same idempotency_key replays the frozen original decision even if the
  -- underlying state (balance) later changes — the caller must use a NEW key to
  -- make a genuinely new attempt. error_code/error_status are set only when
  -- status = 'rejected'; error_status is stored directly (not derived from
  -- error_code) so replay doesn't need a code->HTTP-status mapping function.
  status                  TEXT CHECK (status IS NULL OR status IN ('successful', 'rejected')),
  error_code              TEXT,
  error_status            INT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_user, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_transfers_from_to ON transfers (from_user, to_user);

-- Seed a system "faucet" wallet with a large balance. The API surface deliberately has
-- no deposit/mint endpoint (per spec), so this is the only way to get real money into
-- a brand-new test user's wallet for the concurrency burst gate — the burst script
-- transfers from this faucet into a fresh test user once, sequentially, before firing
-- the actual concurrent burst between two brand-new users.
INSERT INTO wallets (user_id, balance_paise) VALUES ('faucet', 100000000000)
ON CONFLICT (user_id) DO NOTHING;
