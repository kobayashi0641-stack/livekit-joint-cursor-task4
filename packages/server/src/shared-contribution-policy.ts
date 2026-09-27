export function isValidSharedContribution(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 7;
}
