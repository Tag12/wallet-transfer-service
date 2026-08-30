export interface TransferRow {
  id: string;
  from_user: string;
  to_user: string;
  amount_paise: string; // pg returns BIGINT as string
  idempotency_key: string;
  request_hash: string;
  resulting_balance_paise: string | null; // null only transiently before commit, see migration
  status: 'successful' | 'rejected' | null; // null only transiently before commit
  error_code: string | null; // set only when status = 'rejected'
  error_status: number | null; // set only when status = 'rejected'
  created_at: string;
}
