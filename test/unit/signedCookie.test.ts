import { describe, expect, it } from 'vitest';
import { sign, verify } from '../../src/lib/signedCookie.js';

const secret = 'a'.repeat(32);

describe('signed cookies', () => {
  it('round-trips a value', () => {
    expect(verify(sign('abc123', secret), secret)).toBe('abc123');
  });

  it('rejects a tampered value', () => {
    const signed = sign('abc123', secret);
    expect(verify(signed.replace('abc123', 'abc124'), secret)).toBeNull();
    expect(verify(`${signed}x`, secret)).toBeNull();
    expect(verify('no-dot-at-all', secret)).toBeNull();
  });

  it('rejects a value signed with another secret', () => {
    expect(verify(sign('abc123', 'b'.repeat(32)), secret)).toBeNull();
  });
});
