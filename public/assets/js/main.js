import { api, onUnauthorized } from './api.js';
import { renderHome } from './home.js';
import { renderLogin } from './login.js';
import { openReader } from './reader.js';
import { applyTheme, closeMenus, local, toast, trackKeyboard } from './ui.js';
import { t } from './i18n.js';

const app = document.getElementById('app');
let current = null;
let routing = Promise.resolve();
let needLogin = false;

applyTheme(local.get('theme', 'system'));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(local.get('theme', 'system')));
trackKeyboard();

async function route() {
  try {
    current?.destroy?.();
  } catch (err) {
    console.error(err);
  }
  current = null;
  closeMenus();
  document.querySelectorAll('.modal, .scrim, .drawer, .lightbox, .peek').forEach((e) => e.remove());
  app.replaceChildren();
  window.scrollTo(0, 0);
  if (needLogin) {
    current = renderLogin(app, () => {
      needLogin = false;
      schedule();
    });
    return;
  }
  const m = location.hash.match(/^#\/read\/([^?]+)/);
  try {
    current = m ? await openReader(app, decodeURIComponent(m[1])) : await renderHome(app);
  } catch (err) {
    console.error(err);
    toast(err.message || t('common.pageLoadFailed'), { type: 'error' });
  }
}

function schedule() {
  routing = routing.then(route, route);
  return routing;
}

onUnauthorized(() => {
  if (needLogin) return;
  needLogin = true;
  schedule();
});

window.addEventListener('hashchange', schedule);

(async () => {
  try {
    const { authed } = await api.session();
    needLogin = !authed;
  } catch {
    needLogin = false;
  }
  schedule();
})();
