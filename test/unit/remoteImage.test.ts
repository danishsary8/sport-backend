import { lookup } from 'node:dns/promises';
import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createImageFetcher, isPublicAddress } from '../../src/modules/admin/remoteImage.js';

describe('isPublicAddress', () => {
  it('allows public addresses', () => {
    for (const a of ['8.8.8.8', '151.101.1.69', '2606:4700::6810:84e5']) expect(isPublicAddress(a)).toBe(true);
  });
  it('refuses private, local and special addresses (v4, v6 and v4-mapped v6)', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip'])
      expect(isPublicAddress(a), a).toBe(false);
  });
});

describe('createImageFetcher', () => {
  const fetchImage = createImageFetcher();
  it('only takes https links', async () => {
    await expect(fetchImage('http://example.com/a.jpg')).rejects.toMatchObject({ code: 'validation_failed', message: 'Photo links must start with https://' });
    await expect(fetchImage('ftp://example.com/a.jpg')).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(fetchImage('not a url')).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('refuses links that point inside the network', async () => {
    await expect(fetchImage('https://localhost/a.jpg')).rejects.toMatchObject({ code: 'validation_failed', message: 'That link points to a private address' });
    await expect(fetchImage('https://127.0.0.1/a.jpg')).rejects.toMatchObject({ message: 'That link points to a private address' });
    await expect(fetchImage('https://169.254.169.254/latest/meta-data')).rejects.toMatchObject({ message: 'That link points to a private address' });
  });
  it('checks where a host name really points, at connection time', async (t) => {
    const own = await lookup(hostname()).catch(() => null);
    if (!own || isPublicAddress(own.address)) return t.skip();
    // This machine's own name resolves (from /etc/hosts) to a private address: refused before any request is sent.
    await expect(fetchImage(`https://${hostname()}/a.jpg`)).rejects.toMatchObject({ message: 'That link points to a private address' });
  });
});
