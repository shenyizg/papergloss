// Parsing pages from the web, and limits on what is downloaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordingServer } from './helpers.js';

// The asset test downloads from this machine.
process.env.PAPERGLOSS_ALLOW_PRIVATE_URLS = '1';
process.env.PAPERGLOSS_NO_PROXY = '1';
const { fetchAsset, metaFromHtml } = await import('../server/sources.js');
const { decodeEntities } = await import('../server/util.js');

test('meta tags with quoted and bare attributes', () => {
  const meta = metaFromHtml(
    `<meta name="citation_title" content="A &amp; B"><meta name=citation_author content=Ada>` +
      `<meta content='paper.pdf' name='citation_pdf_url'><meta name="x"content="glued">`,
  );
  assert.equal(meta.title, 'A & B');
  assert.deepEqual(meta.authors, ['Ada']);
  assert.equal(meta.pdfUrl, 'paper.pdf');
});

test('hostile meta tags are parsed in linear time', () => {
  const started = performance.now();
  metaFromHtml(`<meta ${'a'.repeat(300_000)}><meta name="x" ${'b'.repeat(300_000)}=>`);
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
});

test('invalid character references do not throw', () => {
  assert.equal(decodeEntities('&#x110000;&#99999999999;&#65;&#x42;'), '\uFFFD\uFFFDAB');
});

test('assets over 30 MB are refused, with or without a Content-Length header', async () => {
  const big = 31 * 1024 * 1024;
  const srv = await recordingServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png', ...(req.url === '/declared' ? { 'Content-Length': big } : {}) });
    const chunk = Buffer.alloc(1024 * 1024);
    let sent = 0;
    const pump = () => {
      while (sent < big) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    res.on('close', () => (sent = big));
    pump();
  });
  try {
    for (const p of ['/declared', '/streamed']) {
      await assert.rejects(fetchAsset(srv.url + p), (err) => err.key === 'asset.tooLarge', p);
    }
    const small = await recordingServer((req, res) => res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.alloc(10)));
    try {
      assert.equal((await fetchAsset(`${small.url}/ok.png`)).buf.length, 10);
    } finally {
      await small.close();
    }
  } finally {
    await srv.close();
  }
});
