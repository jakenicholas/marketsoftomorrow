/*
  Partners of Tomorrow — shared client wall.

  Usage on any page:
      <div data-tmw-partners></div>
      <script src="/journal/_shared/partners.js" defer></script>

  If no [data-tmw-partners] mount exists on the page, one is auto-injected
  just before the footer (or at the end of <body>), so the section is
  UNIVERSAL across every journal page with a single script include.

  Reads /journal/clients.json (the same client list shown on the /media kit)
  and renders a logo wall preview. The "Load more" button links to /media
  for the full directory rather than expanding inline.
*/
(function () {
  'use strict';

  const scriptEl = document.currentScript || (function () {
    const s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();
  const SCRIPT_URL = scriptEl && scriptEl.src ? new URL(scriptEl.src) : null;
  const DATA_URL = SCRIPT_URL
    ? new URL('../clients.json', SCRIPT_URL).href
    : '/journal/clients.json';

  const PREVIEW_COUNT = 30;   // logos shown before "Load more"
  const MEDIA_URL = '/media';

  if (!document.getElementById('tmw-partners-styles')) {
    const css = `
      .tmw-partners{background:#070807; color:#ECEAE5; padding:90px 0 80px; position:relative; font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; border-top:1px solid rgba(255,255,255,.08); border-bottom:1px solid rgba(255,255,255,.08)}
      .tmw-partners::before{content:""; position:absolute; top:-30%; left:50%; transform:translateX(-50%); width:900px; height:600px; background:radial-gradient(closest-side, rgba(31,223,103,.06), transparent 70%); pointer-events:none}
      .tmw-partners-wrap{position:relative; max-width:1320px; margin:0 auto; padding:0 28px}
      .tmw-partners-head{text-align:center; margin-bottom:50px}
      .tmw-partners-eyebrow{font-family:'JetBrains Mono',ui-monospace,monospace; font-size:11px; letter-spacing:.24em; text-transform:uppercase; color:#9AA39C; margin-bottom:16px}
      .tmw-partners-title{font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:clamp(30px,4vw,52px); letter-spacing:-.02em; line-height:1.06; color:#fff; margin:0 auto; max-width:20ch}
      .tmw-clients-grid{display:grid; grid-template-columns:repeat(6,1fr); gap:14px}
      @media(max-width:980px){.tmw-clients-grid{grid-template-columns:repeat(4,1fr)}}
      @media(max-width:560px){.tmw-clients-grid{grid-template-columns:repeat(3,1fr); gap:9px}}
      .tmw-client{display:flex; align-items:center; justify-content:center; aspect-ratio:1; border:1px solid rgba(255,255,255,.08); border-radius:14px; background:rgba(255,255,255,.025); padding:16px; transition:border-color .25s, background .25s}
      .tmw-client:hover{border-color:rgba(31,223,103,.4); background:rgba(31,223,103,.05)}
      .tmw-client img{max-width:100%; max-height:100%; width:auto; height:auto; object-fit:contain; filter:saturate(.95)}
      @media(max-width:560px){.tmw-client{padding:9px; border-radius:10px}}
      .tmw-clients-more{display:flex; justify-content:center; margin-top:44px}
      .tmw-clients-more a{display:inline-flex; align-items:center; gap:10px; padding:14px 30px; border-radius:999px; border:1px solid rgba(255,255,255,.16); background:rgba(255,255,255,.04); color:#ECEAE5; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:12px; letter-spacing:.16em; text-transform:uppercase; text-decoration:none; transition:all .2s}
      .tmw-clients-more a:hover{border-color:rgba(31,223,103,.5); color:#fff; background:rgba(31,223,103,.08); gap:14px}
      .tmw-clients-more svg{width:15px; height:15px}
    `;
    const style = document.createElement('style');
    style.id = 'tmw-partners-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
    );
  }

  function logoTile(c) {
    if (!c || !c.logo) return '';
    return `<div class="tmw-client" title="${esc(c.name)}">
      <img src="${esc(c.logo)}" alt="${esc(c.name)}" loading="lazy">
    </div>`;
  }

  function render(mount, clients) {
    const preview = clients.slice(0, PREVIEW_COUNT);
    mount.classList.add('tmw-partners');
    mount.innerHTML = `
      <div class="tmw-partners-wrap">
        <div class="tmw-partners-head">
          <div class="tmw-partners-eyebrow">Partners of Tomorrow</div>
          <h2 class="tmw-partners-title">We're grateful to work with some incredible people</h2>
        </div>
        <div class="tmw-clients-grid">${preview.map(logoTile).join('')}</div>
        <div class="tmw-clients-more">
          <a href="${MEDIA_URL}">Load more
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
          </a>
        </div>
      </div>
    `;
  }

  async function loadClients() {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('clients ' + res.status);
    const data = await res.json();
    // clients.json is an array of {name, logo}; tolerate {clients:[...]} too.
    return Array.isArray(data) ? data : (data.clients || []);
  }

  // Universal: if the page didn't place a mount, drop one in before the footer.
  function ensureMount() {
    let mounts = document.querySelectorAll('[data-tmw-partners]');
    if (mounts.length) return mounts;
    const host = document.createElement('div');
    host.setAttribute('data-tmw-partners', '');
    const footer = document.querySelector('footer');
    if (footer && footer.parentNode) footer.parentNode.insertBefore(host, footer);
    else document.body.appendChild(host);
    return document.querySelectorAll('[data-tmw-partners]');
  }

  async function init() {
    const mounts = ensureMount();
    if (!mounts.length) return;
    try {
      const clients = await loadClients();
      if (!clients.length) throw new Error('no clients');
      mounts.forEach(m => render(m, clients));
    } catch (err) {
      console.warn('[tmw-partners] failed to load', err);
      mounts.forEach(m => { m.style.display = 'none'; });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
