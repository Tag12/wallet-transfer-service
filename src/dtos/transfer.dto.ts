export interface TransferRequestDto {
  to_user: string;
  amount_paise: number;
  idempotency_key: string;
}

export interface TransferResponseDto {
  transfer_id: string;
  new_balance: string;
}

export interface TransferDetailsDto {
  transfer_id: string;
  from_user: string;
  to_user: string;
  amount_paise: string;
  status: 'successful' | 'rejected';
  error_code?: string; // present only when status === 'rejected'
  created_at: string;
}
