export interface WalletRow {
  user_id: string;
  balance_paise: string; // pg returns BIGINT as string
  created_at: string;
}
