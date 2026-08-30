import { Router, Request, Response } from 'express';
import { auth } from '../middleware/auth';
import { getOrCreateWallet, getBalance } from '../services/wallet.service';
import { asyncHandler } from '../common/utils/asyncHandler';
import { AccountResponseDto } from '../dtos/account.dto';

const router = Router();

router.post('/accounts', auth, asyncHandler(async (req: Request, res: Response) => {
  const wallet = await getOrCreateWallet(req.userId, req.requestId);
  const response: AccountResponseDto = { balance: wallet.balance_paise };
  return res.status(200).json(response);
}));

router.get('/accounts/me', auth, asyncHandler(async (req: Request, res: Response) => {
  const balance = await getBalance(req.userId);
  const response: AccountResponseDto = { balance: balance ?? '0' };
  return res.status(200).json(response);
}));

export default router;
