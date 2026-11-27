import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { AppError } from '../../lib/errors.js';

/** Downloads the photo at an https link and returns its bytes (throws AppError with a reason staff can act on). */
export type ImageFetcher = (url: string) => Promise<Buffer>;

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96]] as const) blocked.addSubnet(net, bits, 'ipv6');

/** True only for addresses on the public internet (private, loopback, link-local, metadata and special ranges are refused). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !blocked.check(address, 'ipv6');
  }
  return !blocked.check(address, 'ipv4');
}

const privateLink = () => new AppError('validation_failed', 400, 'That link points to a private address');

/**
 * Resolves the host and refuses it unless every address is public. Used as the connection's own lookup, so the
 * address checked is the address connected to (a second DNS answer cannot swap in an internal one).
 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, family: (options as { family?: number }).family ?? 0 }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || !list.every((a) => isPublicAddress(a.address))) return callback(privateLink(), '', 0);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

function checkLink(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('validation_failed', 400, 'That is not a web link');
  }
  if (url.protocol !== 'https:') throw new AppError('validation_failed', 400, 'Photo links must start with https://');
  if (url.username || url.password) throw new AppError('validation_failed', 400, 'Photo links cannot contain a user name or password');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !isPublicAddress(host))) throw privateLink();
  return url;
}

/** Real downloader: https only, public addresses only (re-checked on every redirect, at most 3), size and time limits. */
export function createImageFetcher(opts: { maxBytes?: number; timeoutMs?: number } = {}): ImageFetcher {
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const get = (url: URL, redirects: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const req = request(url, { lookup: safeLookup, timeout: timeoutMs, headers: { accept: 'image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.1', 'user-agent': 'shop-photo-import/1.0' } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects >= 3) return reject(new AppError('validation_failed', 400, 'That link redirects too many times'));
          try {
            return resolve(get(checkLink(new URL(res.headers.location, url).toString()), redirects + 1));
          } catch (e) {
            return reject(e);
          }
        }
        if (status !== 200) {
          res.resume();
          return reject(new AppError('validation_failed', 400, `Could not download that photo (HTTP ${status})`));
        }
        if (Number(res.headers['content-length'] ?? 0) > maxBytes) {
          res.destroy();
          return reject(new AppError('payload_too_large', 413, 'That photo is larger than 4 MB'));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new AppError('payload_too_large', 413, 'That photo is larger than 4 MB'));
          } else chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => reject(new AppError('validation_failed', 400, 'The download was interrupted')));
      });
      req.on('timeout', () => req.destroy(new AppError('validation_failed', 400, 'That photo took too long to download')));
      req.on('error', (e) => reject(e instanceof AppError ? e : new AppError('validation_failed', 400, 'Could not reach that link')));
      req.end();
    });
  return (raw) => {
    try {
      return get(checkLink(raw), 0);
    } catch (e) {
      return Promise.reject(e);
    }
  };
}
