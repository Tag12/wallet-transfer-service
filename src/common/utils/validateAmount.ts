export function isValidAmountPaise(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
