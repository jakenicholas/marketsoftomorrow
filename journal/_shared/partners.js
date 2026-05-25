/*
  Partners of Tomorrow — shared mount script.

  Usage on any page:
      <div data-tmw-partners></div>
      <script src="/journal/_shared/partners.js" defer></script>

  Reads /journal/partners.json (single source of truth across the site)
  and renders the Signature Partners showcase into every matching mount
  point. Styles are scoped via the .tmw-partners root class so this
  embed doesn't collide with host-page CSS.

  Edit partners.json → next page load propagates everywhere.
*/
(function () {
  'use strict';

  // Resolve the JSON URL relative to where THIS script lives in the
  // repo, so the same snippet works at /, /golf/, /florida/foo/, etc.
  const scriptEl = document.currentScript || (function () {
    const s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();
  const SCRIPT_URL = scriptEl && scriptEl.src ? new URL(scriptEl.src) : null;
  const DATA_URL = SCRIPT_URL
    ? new URL('../partners.json', SCRIPT_URL).href
    : '/journal/partners.json';

  // Inject styles once.
  if (!document.getElementById('tmw-partners-styles')) {
    const css = `
      .tmw-partners{background:#070807; color:#ECEAE5; padding:90px 0 80px; position:relative; font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; border-top:1px solid rgba(255,255,255,.08); border-bottom:1px solid rgba(255,255,255,.08)}
      .tmw-partners::before{content:""; position:absolute; top:-30%; left:50%; transform:translateX(-50%); width:900px; height:600px; background:radial-gradient(closest-side, rgba(31,223,103,.06), transparent 70%); pointer-events:none}
      .tmw-partners-wrap{position:relative; max-width:1320px; margin:0 auto; padding:0 28px}
      .tmw-partners-head{text-align:center; margin-bottom:54px}
      .tmw-partners-eyebrow{font-family:'JetBrains Mono',ui-monospace,monospace; font-size:11px; letter-spacing:.24em; text-transform:uppercase; color:#9AA39C; margin-bottom:14px}
      .tmw-partners-title{font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:clamp(34px,4.4vw,56px); letter-spacing:-.02em; line-height:1.04; color:#fff; margin:0}
      .tmw-partners-sub{font-family:'Fraunces',Georgia,serif; font-weight:300; font-style:italic; font-size:17px; color:#C2C9C3; margin-top:14px; max-width:48ch; margin-left:auto; margin-right:auto}
      .tmw-partners-grid{display:grid; grid-template-columns:repeat(4, 1fr); gap:18px}
      @media(max-width:1100px){.tmw-partners-grid{grid-template-columns:repeat(2, 1fr)}}
      @media(max-width:620px){.tmw-partners-grid{grid-template-columns:1fr}}
      .tmw-partner-card{background:#141714; border:1px solid rgba(255,255,255,.08); border-radius:14px; overflow:hidden; display:flex; flex-direction:column; transition:transform .25s ease, border-color .25s ease}
      .tmw-partner-card:hover{transform:translateY(-3px); border-color:rgba(255,255,255,.18)}
      .tmw-partner-img{aspect-ratio:16/10; background:#1a1d1a; overflow:hidden; position:relative}
      .tmw-partner-img img{width:100%; height:100%; object-fit:cover; transition:transform .6s ease}
      .tmw-partner-card:hover .tmw-partner-img img{transform:scale(1.04)}
      .tmw-partner-body{padding:28px 22px 22px; display:flex; flex-direction:column; align-items:center; gap:18px; text-align:center; flex:1}
      .tmw-partner-logo{height:54px; max-width:80%; display:flex; align-items:center; justify-content:center}
      .tmw-partner-logo img{max-height:100%; max-width:100%; object-fit:contain; filter:brightness(1.1)}
      .tmw-partner-logo .wm-fallback{font-family:'Fraunces',Georgia,serif; font-weight:500; font-size:22px; color:#fff; letter-spacing:.04em; text-align:center; line-height:1.1}
      .tmw-partner-cat{font-family:'JetBrains Mono',ui-monospace,monospace; font-size:10.5px; letter-spacing:.22em; text-transform:uppercase; color:#C2C9C3; font-weight:500}
      .tmw-partner-cta{margin-top:auto; display:inline-block; padding:11px 22px; border:1px solid rgba(255,255,255,.18); border-radius:999px; color:#ECEAE5; text-decoration:none; font-family:'Inter',sans-serif; font-size:13px; font-weight:500; transition:all .2s}
      .tmw-partner-cta:hover{background:#1FDF67; color:#070807; border-color:#1FDF67}
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

  function cardHtml(p) {
    const logoEl = p.logo
      ? `<img src="${esc(p.logo)}" alt="${esc(p.name)}" onerror="this.parentElement.innerHTML='<div class=&quot;wm-fallback&quot;>${esc(p.name)}</div>'">`
      : `<div class="wm-fallback">${esc(p.name)}</div>`;
    const imgEl = p.image
      ? `<img src="${esc(p.image)}" alt="" loading="lazy">`
      : '';
    return `<a class="tmw-partner-card" href="${esc(p.ctaUrl || '#')}" target="_blank" rel="noopener" data-partner-id="${esc(p.id)}">
      <div class="tmw-partner-img">${imgEl}</div>
      <div class="tmw-partner-body">
        <div class="tmw-partner-logo">${logoEl}</div>
        <div class="tmw-partner-cat">${esc(p.category || '')}</div>
        <span class="tmw-partner-cta">${esc(p.ctaLabel || 'Learn More')}</span>
      </div>
    </a>`;
  }

  function render(mount, data) {
    const head = data.header || {};
    const partners = (data.partners || []).filter(p => p && p.active !== false);
    mount.classList.add('tmw-partners');
    mount.innerHTML = `
      <div class="tmw-partners-wrap">
        <div class="tmw-partners-head">
          ${head.eyebrow ? `<div class="tmw-partners-eyebrow">${esc(head.eyebrow)}</div>` : ''}
          ${head.title   ? `<h2 class="tmw-partners-title">${esc(head.title)}</h2>` : ''}
          ${head.sub     ? `<p class="tmw-partners-sub">${esc(head.sub)}</p>`     : ''}
        </div>
        <div class="tmw-partners-grid">${partners.map(cardHtml).join('')}</div>
      </div>
    `;
  }

  async function init() {
    const mounts = document.querySelectorAll('[data-tmw-partners]');
    if (!mounts.length) return;
    try {
      const res = await fetch(DATA_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('partners.json ' + res.status);
      const data = await res.json();
      mounts.forEach(m => render(m, data));
    } catch (err) {
      console.warn('[tmw-partners] failed to load', DATA_URL, err);
      mounts.forEach(m => { m.style.display = 'none'; });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
