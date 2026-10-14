// Outbound HTTP for the server. Node's built-in fetch ignores HTTPS_PROXY/HTTP_PROXY,
// so requests go through undici with an env-aware proxy agent, like curl would.
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
