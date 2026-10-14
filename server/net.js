// Outbound HTTP for the server. Node's built-in fetch ignores HTTPS_PROXY/HTTP_PROXY,
// so requests go through undici with an env-aware proxy agent, like curl would.
import dns from 'node:dns';
import net from 'node:net';
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

const env = process.env;
const proxyConfigured = !!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
const useProxy = proxyConfigured && env.PAPERGLOSS_NO_PROXY !== '1';

// Loopback always bypasses the proxy so local model servers (Ollama, vLLM) keep working.
const noProxy = [env.NO_PROXY || env.no_proxy || '', 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');

const dispatcher = useProxy ? new EnvHttpProxyAgent({ noProxy }) : new Agent();

export function httpFetch(url, init = {}) {
  return undiciFetch(url, { ...init, dispatcher });
}

export function proxyDescription() {
  if (!useProxy) return proxyConfigured ? 'direct (proxy disabled by PAPERGLOSS_NO_PROXY=1)' : 'direct';
  const p = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  try {
    const u = new URL(p);
    return `via proxy ${u.host}`;
  } catch {
    return 'via proxy';
  }
}

// ---- links from users and web pages ------------------------------------------------------

// Paper links come from users and from the pages they point to, so by default they may not
// reach this machine, the local network or cloud metadata services.
const allowPrivateUrls = env.PAPERGLOSS_ALLOW_PRIVATE_URLS === '1';

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
]) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

export function isPublicAddress(address) {
  const version = net.isIP(address);
  return version !== 0 && !blocked.check(address, version === 6 ? 'ipv6' : 'ipv4');
}

export class PrivateAddressError extends Error {
  constructor(host) {
    super(`${host} is a local or private address`);
    this.code = 'ERR_PRIVATE_ADDRESS';
    this.host = host;
  }
}

// Filters addresses when connecting, so a name can't resolve to a public address when it's
// checked and to a private one when it's used.
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const usable = addresses.filter((a) => isPublicAddress(a.address));
    if (!usable.length) return callback(new PrivateAddressError(hostname));
    if (options.all) callback(null, usable);
    else callback(null, usable[0].address, usable[0].family);
  });
}

const publicDispatcher = useProxy ? dispatcher : new Agent({ connect: { lookup: publicLookup } });

async function checkHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new PrivateAddressError(host);
    return;
  }
  // Without a proxy, publicLookup checks the name when connecting.
  if (!useProxy) return;
  // Behind a proxy the proxy resolves the name; check what it resolves to here, if anything.
  let addresses;
  try {
    addresses = await dns.promises.lookup(host, { all: true });
  } catch {
    return;
  }
  if (addresses.some((a) => !isPublicAddress(a.address))) throw new PrivateAddressError(host);
}

// fetch() for untrusted URLs: redirects are followed by hand so that every hop is checked.
// The returned response's `url` is the final address, as with redirect: 'follow'.
export async function publicFetch(url, init = {}) {
  if (allowPrivateUrls) return httpFetch(url, { ...init, redirect: 'follow' });
  let current = new URL(url);
  for (let hops = 0; ; hops++) {
    await checkHost(current);
    const res = await undiciFetch(current, { ...init, redirect: 'manual', dispatcher: publicDispatcher });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    await res.body?.cancel();
    if (hops >= 10) throw new TypeError('too many redirects');
    current = new URL(location, current);
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new TypeError(`unsupported redirect to ${current.protocol}`);
  }
}

export function privateAddressIn(err) {
  for (let e = err; e; e = e.cause) if (e.code === 'ERR_PRIVATE_ADDRESS') return e;
  return null;
}
