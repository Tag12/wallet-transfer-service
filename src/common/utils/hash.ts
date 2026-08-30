import crypto from 'crypto';

export function hashTransferRequest(toUser: string, amountPaise: number): string {
  return crypto.createHash('sha256').update(`${toUser}:${amountPaise}`).digest('hex');
}
