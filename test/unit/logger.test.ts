import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/lib/logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, stream };
}

describe('createLogger redaction', () => {
  it('masks phone numbers and auth headers', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ logLevel: 'info', nodeEnv: 'test' }, stream);
    logger.info({ contact: { phone: '+85512345678' }, req: { headers: { authorization: 'Bearer abc' } } }, 'x');
    const out = lines.join('');
    expect(out).toContain('***678');
    expect(out).not.toContain('12345678');
    expect(out).not.toContain('Bearer abc');
  });
});
