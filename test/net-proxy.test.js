// Behind an outbound proxy the proxy resolves names, so they are checked before sending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordingServer } from './helpers.js';

const proxy = await recordingServer();
process.env.HTTPS_PROXY = process.env.HTTP_PROXY = proxy.url;
process.env.NO_PROXY = '';
delete process.env.PAPERGLOSS_NO_PROXY;
delete process.env.PAPERGLOSS_ALLOW_PRIVATE_URLS;
const { privateAddressIn, publicFetch } = await import('../server/net.js');

test('behind a proxy, local addresses are refused before anything is sent', async () => {
  try {
    for (const url of ['http://127.0.0.1:9/', 'http://localhost:9/', 'http://[::1]:9/', 'http://192.168.0.10/']) {
      await assert.rejects(publicFetch(url), (err) => !!privateAddressIn(err), url);
    }
    assert.equal(proxy.requests.length, 0);
    // Public addresses go to the proxy as before.
    await publicFetch('http://93.184.216.34/paper.pdf').catch(() => {});
    assert.equal(proxy.requests.length, 1);
  } finally {
    await proxy.close();
  }
});
