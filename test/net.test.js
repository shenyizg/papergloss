// Fetching links from users: which addresses are off limits, checked when connecting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordingServer } from './helpers.js';

process.env.PAPERGLOSS_NO_PROXY = '1';
delete process.env.PAPERGLOSS_ALLOW_PRIVATE_URLS;
const { isPublicAddress, privateAddressIn, publicFetch } = await import('../server/net.js');

test('local, private and special addresses are not public', () => {
  const blocked = [
    '127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
  ];
  for (const ip of blocked) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  assert.equal(isPublicAddress('not-an-ip'), false);
});

test('publicFetch refuses local addresses, written as an IP or as a name', async () => {
  const srv = await recordingServer();
  try {
    for (const url of [srv.url, `http://localhost:${srv.port}/`, `http://[::1]:${srv.port}/`, `http://2130706433:${srv.port}/`]) {
      await assert.rejects(publicFetch(url), (err) => !!privateAddressIn(err), url);
    }
    assert.equal(srv.requests.length, 0);
  } finally {
    await srv.close();
  }
});
