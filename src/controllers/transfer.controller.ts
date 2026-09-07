import { Router, Request, Response } from 'express';
import { auth } from '../middleware/auth';
import { createTransfer, getTransferById, AppError } from '../services/transfer.service';
import { isValidAmountPaise } from '../common/utils/validateAmount';
import { asyncHandler } from '../common/utils/asyncHandler';
import { recordTransferOutcome } from './health.controller';
import { ErrorCode } from '../shared/enums/error-code.enum';
import { TransferRequestDto, TransferResponseDto, TransferDetailsDto } from '../dtos/transfer.dto';

const router = Router();

router.post('/transfers', auth, asyncHandler(async (req: Request, res: Response) => {
  const { to_user, amount_paise, idempotency_key }: TransferRequestDto = req.body;

  if (!to_user || typeof to_user !== 'string') {
    return res.status(400).json({ error: ErrorCode.MISSING_FIELD, message: 'to_user is required' });
  }
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    return res.status(400).json({ error: ErrorCode.MISSING_FIELD, message: 'idempotency_key is required' });
  }
  if (!isValidAmountPaise(amount_paise)) {
    return res.status(400).json({ error: ErrorCode.INVALID_AMOUNT, message: 'amount_paise must be a positive integer' });
  }
  if (to_user === req.userId) {
    return res.status(400).json({ error: ErrorCode.SELF_TRANSFER, message: 'Cannot transfer to yourself' });
  }

  try {
    const result = await createTransfer(req.userId, to_user, amount_paise, idempotency_key, req.requestId);
    recordTransferOutcome(true);
    const response: TransferResponseDto = { transfer_id: result.transferId, new_balance: result.newBalance };
    return res.status(200).json(response);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      if (err.code === ErrorCode.INSUFFICIENT_FUNDS || err.code === ErrorCode.DAILY_CAP_EXCEEDED) {
        recordTransferOutcome(false);
      }
      return res.status(err.status).json({ error: err.code, message: err.code, transfer_id: err.transferId });
    }
    throw err;
  }
}));

router.get('/transfers/:id', auth, asyncHandler(async (req: Request, res: Response) => {
  const transfer = await getTransferById(req.params.id);
  if (!transfer) {
    return res.status(404).json({ error: ErrorCode.TRANSFER_NOT_FOUND, message: 'Transfer not found' });
  }
  if (transfer.from_user !== req.userId && transfer.to_user !== req.userId) {
    return res.status(403).json({ error: ErrorCode.FORBIDDEN, message: 'Not a participant in this transfer' });
  }
  const response: TransferDetailsDto = {
    transfer_id: transfer.id,
    from_user: transfer.from_user,
    to_user: transfer.to_user,
    amount_paise: transfer.amount_paise,
    status: transfer.status as 'successful' | 'rejected',
    error_code: transfer.error_code ?? undefined,
    created_at: transfer.created_at,
  };
  return res.status(200).json(response);
}));

export default router;
