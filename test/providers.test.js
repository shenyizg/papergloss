// Saved providers: one key per provider, each only sent to the server it was saved for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, readConfig, recordingServer, signIn, startServer, tempDir } from './helpers.js';

const PW = 'test-password';
const models = (req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[{"id":"m1"}]}');

test('each provider keeps its own key, and switching back restores it', async () => {
  const a = await recordingServer(models);
  const b = await recordingServer(models);
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const save = (body) => api(srv.url, 'PUT', '/api/settings', { cookie, body });
    const list = (llm) => api(srv.url, 'POST', '/api/llm/models', { cookie, body: llm ? { llm } : {} });

    await save({ llm: { preset: 'deepseek', protocol: 'openai', baseUrl: `${a.url}/v1`, apiKey: 'sk-key-for-a', model: 'model-a' } });
    const both = await save({ llm: { preset: 'openrouter', protocol: 'openai', baseUrl: `${b.url}/v1`, apiKey: 'sk-key-for-b', model: 'model-b' } });
    assert.equal(both.data.llm.preset, 'openrouter');
    assert.equal(both.data.providers.deepseek.hasKey, true);
    assert.equal(both.data.providers.openrouter.hasKey, true);
    assert.ok(!JSON.stringify(both.data).includes('sk-key-for'), 'keys must not reach the browser');

    // Switching needs only the provider's name; its model and key come back with it.
    const switched = await save({ llm: { preset: 'deepseek' } });
    assert.equal(switched.data.llm.model, 'model-a');
    assert.equal(switched.data.llm.hasKey, true);
    await list();
    assert.equal(a.requests.at(-1).headers.authorization, 'Bearer sk-key-for-a');

    // "Fetch list" in the settings form for the other saved provider uses that provider's key.
    await list({ preset: 'openrouter', protocol: 'openai', baseUrl: `${b.url}/v1` });
    assert.equal(b.requests.at(-1).headers.authorization, 'Bearer sk-key-for-b');
    // ...but never sends it to another provider's server.
    const before = a.requests.length;
    await list({ preset: 'openrouter', protocol: 'openai', baseUrl: `${a.url}/v1` });
    assert.equal(a.requests.length, before + 1);
    assert.equal(a.requests.at(-1).headers.authorization, undefined);
  } finally {
    await srv.stop();
    await a.close();
    await b.close();
  }
});

test('moving one provider to another server drops only its key; keys can be removed one by one', async () => {
  const a = await recordingServer(models);
  const b = await recordingServer(models);
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const save = (body) => api(srv.url, 'PUT', '/api/settings', { cookie, body });
    await save({ llm: { preset: 'deepseek', protocol: 'openai', baseUrl: `${a.url}/v1`, apiKey: 'sk-a', model: 'm' } });
    await save({ llm: { preset: 'custom', protocol: 'openai', baseUrl: `${b.url}/v1`, apiKey: 'sk-b', model: 'm' } });

    // Same server, other path: the key stays.
    let s = (await save({ llm: { preset: 'deepseek', baseUrl: `${a.url}/other/v1` } })).data;
    assert.equal(s.providers.deepseek.hasKey, true);
    // Another server without a new key: the key is dropped, the other provider keeps its own.
    s = (await save({ llm: { preset: 'deepseek', baseUrl: `${b.url}/v1` } })).data;
    assert.equal(s.providers.deepseek.hasKey, false);
    assert.equal(s.providers.custom.hasKey, true);

    s = (await save({ forgetKey: 'custom' })).data;
    assert.equal(s.providers.custom.hasKey, false);
    assert.equal(s.llm.preset, 'deepseek', 'removing a key does not switch providers');
    assert.ok(!fs.readFileSync(path.join(srv.dataDir, 'config.json'), 'utf8').includes('sk-b'));
  } finally {
    await srv.stop();
    await a.close();
    await b.close();
  }
});

test('single-provider settings from earlier versions carry over', async () => {
  const a = await recordingServer(models);
  const dir = tempDir();
  const old = { protocol: 'openai', preset: 'deepseek', baseUrl: `${a.url}/v1`, apiKey: 'sk-old-key', model: 'deepseek-chat', effort: { translate: 'low' } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ secret: 'b'.repeat(64), llm: old }));
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const s = (await api(srv.url, 'GET', '/api/settings', { cookie })).data;
    assert.equal(s.llm.preset, 'deepseek');
    assert.equal(s.llm.model, 'deepseek-chat');
    assert.equal(s.llm.hasKey, true);
    const stored = readConfig(dir).llm;
    assert.equal(stored.providers.deepseek.apiKey, 'sk-old-key');
    assert.equal(stored.apiKey, undefined);
    await api(srv.url, 'POST', '/api/llm/models', { cookie, body: {} });
    assert.equal(a.requests.at(-1).headers.authorization, 'Bearer sk-old-key');
  } finally {
    await srv.stop();
    await a.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
