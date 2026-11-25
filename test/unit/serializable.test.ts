import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { withSerializable } from '../../src/modules/checkout/serializable.js';

function fakeDb(failures: number, code = '40001') {
  let calls = 0;
  const db = {
    async transaction(fn: (tx: unknown) => Promise<unknown>) {
      calls += 1;
      if (calls <= failures) throw Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('could not serialize'), { code }) });
      return fn({});
    },
  } as unknown as Db;
  return { db, calls: () => calls };
}

describe('withSerializable', () => {
  it('retries serialization failures and deadlocks until it succeeds', async () => {
    const f = fakeDb(5);
    await expect(withSerializable(f.db, async () => 'ok', 8, 1)).resolves.toBe('ok');
    expect(f.calls()).toBe(6);
  });

  it('answers 503 busy (retryable) when the retries run out', async () => {
    const f = fakeDb(99, '40P01');
    await expect(withSerializable(f.db, async () => 'ok', 3, 1)).rejects.toMatchObject({ code: 'busy', status: 503 });
    expect(f.calls()).toBe(3);
  });

  it('does not retry other errors', async () => {
    const f = fakeDb(1, '23505');
    await expect(withSerializable(f.db, async () => 'ok', 8, 1)).rejects.toThrow('Failed query');
    expect(f.calls()).toBe(1);
  });
});
