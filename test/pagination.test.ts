import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import { decodeCursor, encodeCursor } from '../src/lib/pagination.js';

describe('cursor encoding', () => {
  it('round-trips mixed values', () => {
    expect(decodeCursor(encodeCursor([9800, 'real-madrid']))).toEqual([9800, 'real-madrid']);
  });

  it('produces URL-safe text', () => {
    expect(encodeCursor(['a/b+c', 1])).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each(['%%%', 'bm90LWpzb24', encodeCursorRaw('{"a":1}'), encodeCursorRaw('[{"x":1}]')])(
    'rejects garbage cursor %s with a 400 ApiError',
    (bad) => {
      expect(() => decodeCursor(bad)).toThrow(ApiError);
      try {
        decodeCursor(bad);
      } catch (e) {
        expect((e as ApiError).status).toBe(400);
      }
    },
  );
});

function encodeCursorRaw(json: string): string {
  return Buffer.from(json).toString('base64url');
}
