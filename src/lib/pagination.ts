import { ApiError } from './errors.js';

export type CursorValue = string | number;

/** Opaque, URL-safe cursor holding the last row's sort key and slug. */
export function encodeCursor(values: CursorValue[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

export function decodeCursor(cursor: string): CursorValue[] {
  const invalid = () => ApiError.badRequest('The cursor is not valid. Use nextCursor from a previous response.', [
    { path: 'cursor', message: 'Invalid cursor' },
  ]);
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > 4 ||
    !parsed.every((v) => typeof v === 'string' || typeof v === 'number')
  ) {
    throw invalid();
  }
  return parsed as CursorValue[];
}
