/*
  Partners of Tomorrow — shared mount.

  Usage on any page:
      <div data-tmw-partners></div>
      <script src="/_shared/partners.js" defer></script>

  Renders TWO stacked blocks into the mount (auto-injected before the footer
  if no mount exists, so the section is universal across journal pages):

    1. Signature Partners — curated rich cards (studio-editable list
       /list/partners, falling back to /partners.json).
    2. Client wall — the full media-kit client list (/clients.json),
       collapsed to ~2.5 rows with a fade and a "Load more" that links to /media.
*/
(function () {
  'use strict';

  const scriptEl = document.currentScript || (function () {
    const s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();
  const SCRIPT_URL = scriptEl && scriptEl.src ? new URL(scriptEl.src) : null;
  const rel = (p) => SCRIPT_URL ? new URL(p, SCRIPT_URL).href : ('/' + p.replace('../', ''));
  const PARTNERS_URL = rel('../partners.json');
  const CLIENTS_URL  = rel('../clients.json');
  const WORKER = 'https://tmw.jake-ab7.workers.dev';
  const MEDIA_URL = '/media';
  const CLIENT_PREVIEW = 36;   // logos rendered in the collapsed wall

  if (!document.getElementById('tmw-partners-styles')) {
    const css = `
      .tmw-partners{background:#070807; color:#ECEAE5; padding:90px 0 80px; position:relative; font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; border-top:1px solid rgba(255,255,255,.08); border-bottom:1px solid rgba(255,255,255,.08)}
      .tmw-partners::before{content:""; position:absolute; top:-30%; left:50%; transform:translateX(-50%); width:900px; height:600px; background:radial-gradient(closest-side, rgba(31,223,103,.06), transparent 70%); pointer-events:none}
      .tmw-partners-wrap{position:relative; max-width:1320px; margin:0 auto; padding:0 28px}
      .tmw-partners-head{text-align:center; margin-bottom:50px}
      .tmw-partners-eyebrow{font-family:'JetBrains Mono',ui-monospace,monospace; font-size:11px; letter-spacing:.24em; text-transform:uppercase; color:#9AA39C; margin-bottom:14px}
      .tmw-partners-title{font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:clamp(34px,4.4vw,56px); letter-spacing:-.02em; line-height:1.04; color:#fff; margin:0}
      .tmw-partners-sub{font-family:'Fraunces',Georgia,serif; font-weight:300; font-style:italic; font-size:17px; color:#C2C9C3; margin-top:14px; max-width:48ch; margin-left:auto; margin-right:auto}
      /* Signature Partners cards */
      .tmw-partners-grid{display:grid; grid-template-columns:repeat(4, 1fr); gap:18px}
      @media(max-width:1100px){.tmw-partners-grid{grid-template-columns:repeat(2, 1fr)}}
      @media(max-width:620px){.tmw-partners-grid{grid-template-columns:repeat(2, 1fr); gap:10px}}
      .tmw-partner-card{background:linear-gradient(180deg,#121d11,#0d130c); border:1px solid rgba(230,197,116,.34); border-radius:16px; overflow:hidden; display:flex; flex-direction:column; box-shadow:0 0 18px rgba(230,197,116,.12), inset 0 0 0 1px rgba(230,197,116,.05); transition:transform .25s ease, border-color .25s ease, box-shadow .25s ease}
      .tmw-partner-card:hover{transform:translateY(-3px); border-color:rgba(230,197,116,.7); box-shadow:0 0 28px rgba(230,197,116,.26), inset 0 0 0 1px rgba(230,197,116,.1)}
      .tmw-partner-img{aspect-ratio:16/10; background:#1a1d1a; overflow:hidden; position:relative}
      .tmw-partner-img img{width:100%; height:100%; object-fit:cover; transition:transform .6s ease}
      .tmw-partner-card:hover .tmw-partner-img img{transform:scale(1.04)}
      .tmw-partner-body{padding:26px 14px 14px; display:flex; flex-direction:column; align-items:center; gap:18px; text-align:center; flex:1}
      @media(max-width:620px){.tmw-partner-body{padding:18px 14px 16px; gap:12px}}
      .tmw-partner-logo{height:54px; width:100%; max-width:200px; display:flex; align-items:center; justify-content:center}
      .tmw-partner-logo .lmask{display:block; width:100%; height:54px; background:#fff; opacity:.95; -webkit-mask-size:contain; mask-size:contain; -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat; -webkit-mask-position:center; mask-position:center}
      .tmw-partner-logo .wm-fallback{font-family:'Fraunces',Georgia,serif; font-weight:500; font-size:22px; color:#fff; letter-spacing:.04em; text-align:center; line-height:1.1}
      .tmw-partner-cat{font-family:'JetBrains Mono',ui-monospace,monospace; font-size:10.5px; letter-spacing:.22em; text-transform:uppercase; color:#C2C9C3; font-weight:500}
      .tmw-mobr{display:none}
      @media(max-width:620px){
        .tmw-partner-logo, .tmw-partner-logo .lmask{height:40px}
        .tmw-partner-cat{font-size:9.5px; letter-spacing:.16em; line-height:1.5}
        .tmw-mobr{display:inline}
      }
      .tmw-partner-cta{margin-top:auto; display:block; width:100%; text-align:center; padding:11px 14px; background:rgba(0,0,0,.24); border:1px solid rgba(255,255,255,.05); border-radius:14px; color:#9AA39C; text-decoration:none; font-family:'Inter',sans-serif; font-size:12.5px; font-weight:500; letter-spacing:.01em; transition:background .2s, border-color .2s, color .2s}
      .tmw-partner-cta:hover{background:rgba(0,0,0,.34); border-color:rgba(255,255,255,.12); color:#ECEAE5}
      /* Client wall */
      .tmw-clients{margin-top:76px}
      .tmw-clients-head{text-align:center; margin-bottom:40px}
      .tmw-clients-title{font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:clamp(26px,3.2vw,40px); letter-spacing:-.02em; line-height:1.1; color:#fff; margin:0 auto; max-width:20ch}
      .tmw-clients-collapse{position:relative; overflow:hidden; max-height:clamp(420px,42vw,560px)}
      .tmw-clients-collapse::after{content:""; position:absolute; left:0; right:0; bottom:0; height:150px; background:linear-gradient(to bottom, rgba(7,8,7,0), #070807 88%); pointer-events:none}
      .tmw-clients-grid{display:grid; grid-template-columns:repeat(6,1fr); gap:14px}
      @media(max-width:980px){.tmw-clients-grid{grid-template-columns:repeat(4,1fr)}}
      @media(max-width:560px){.tmw-clients-grid{grid-template-columns:repeat(3,1fr); gap:9px}}
      .tmw-client{display:flex; align-items:center; justify-content:center; aspect-ratio:1; border:1px solid rgba(255,255,255,.08); border-radius:14px; background:rgba(255,255,255,.025); padding:16px; transition:border-color .25s, background .25s}
      .tmw-client:hover{border-color:rgba(31,223,103,.4); background:rgba(31,223,103,.05)}
      .tmw-client img{max-width:100%; max-height:100%; width:auto; height:auto; object-fit:contain; filter:saturate(.95)}
      @media(max-width:560px){.tmw-client{padding:9px; border-radius:10px}}
      .tmw-clients-more{position:relative; z-index:2; display:flex; justify-content:center; margin-top:-40px}
      .tmw-clients-more a{display:inline-flex; align-items:center; gap:10px; padding:14px 30px; border-radius:999px; border:1px solid rgba(255,255,255,.16); background:rgba(13,15,13,.92); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); color:#ECEAE5; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:12px; letter-spacing:.16em; text-transform:uppercase; text-decoration:none; transition:all .2s}
      .tmw-clients-more a:hover{border-color:rgba(31,223,103,.5); color:#fff; background:rgba(31,223,103,.10); gap:14px}
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

  function partnerCard(p) {
    const logoEl = p.logo
      ? `<span class="lmask" role="img" aria-label="${esc(p.name)}" style="-webkit-mask-image:url('${esc(p.logo)}');mask-image:url('${esc(p.logo)}')"></span>`
      : `<div class="wm-fallback">${esc(p.name)}</div>`;
    const imgEl = p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : '';
    return `<a class="tmw-partner-card" href="${esc(p.ctaUrl || '#')}" target="_blank" rel="noopener" data-partner-id="${esc(p.id)}">
      <div class="tmw-partner-img">${imgEl}</div>
      <div class="tmw-partner-body">
        <div class="tmw-partner-logo">${logoEl}</div>
        <div class="tmw-partner-cat">${esc(p.category || '').replace(/ TOMORROW/i, ' <br class="tmw-mobr">TOMORROW')}</div>
        <span class="tmw-partner-cta">${esc(p.ctaLabel || 'Learn More')}</span>
      </div>
    </a>`;
  }

  function logoTile(c) {
    if (!c || !c.logo) return '';
    return `<div class="tmw-client" title="${esc(c.name)}"><img src="${esc(c.logo)}" alt="${esc(c.name)}" loading="lazy"></div>`;
  }

  function render(mount, partnersData, clients) {
    const head = partnersData.header || {};
    const partners = (partnersData.partners || []).filter(p => p && p.active !== false);
    const preview = clients.slice(0, CLIENT_PREVIEW);
    mount.classList.add('tmw-partners');
    mount.innerHTML = `
      <div class="tmw-partners-wrap">
        ${partners.length ? `
          <div class="tmw-partners-head">
            ${head.eyebrow ? `<div class="tmw-partners-eyebrow">${esc(head.eyebrow)}</div>` : ''}
            ${head.title   ? `<h2 class="tmw-partners-title">${esc(head.title).replace(/ of /i, ' <br class="tmw-mobr">of ')}</h2>` : ''}
            ${head.sub     ? `<p class="tmw-partners-sub">${esc(head.sub)}</p>` : ''}
          </div>
          <div class="tmw-partners-grid">${partners.map(partnerCard).join('')}</div>
        ` : ''}
        ${preview.length ? `
          <div class="tmw-clients">
            <div class="tmw-clients-head">
              <h3 class="tmw-clients-title">We're grateful to work with some incredible people</h3>
            </div>
            <div class="tmw-clients-collapse">
              <div class="tmw-clients-grid">${preview.map(logoTile).join('')}</div>
            </div>
            <div class="tmw-clients-more">
              <a href="${MEDIA_URL}">Load more
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
              </a>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  function toPartnersShape(data) {
    if (data && Array.isArray(data.items) && !data.partners) {
      return { header: { eyebrow: 'SIGNATURE PARTNERS', title: data.title || 'Our Partners of Tomorrow', sub: data.subtitle || '' }, partners: data.items };
    }
    return data || {};
  }

  async function loadPartners() {
    try {
      const r = await fetch(WORKER + '/list/partners', { cache: 'no-store' });
      if (r.ok) {
        const w = await r.json();
        if (w && w.exists && w.data && Array.isArray(w.data.items) && w.data.items.length) return toPartnersShape(w.data);
      }
    } catch (e) {}
    try {
      const res = await fetch(PARTNERS_URL, { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch (e) {}
    return { header: {}, partners: [] };
  }

  function clientsActive(c) {
    return c && c.logo && c.active !== false && c.active !== '' && c.active !== '0' && c.active !== 'false' && c.active !== 'no';
  }
  async function loadClients() {
    // 1) Live, studio-editable list (D1) — honors the active flag + view order.
    try {
      const r = await fetch(WORKER + '/list/clients', { cache: 'no-store' });
      if (r.ok) {
        const w = await r.json();
        if (w && w.exists && w.data && Array.isArray(w.data.items) && w.data.items.length) {
          return w.data.items.filter(clientsActive).map(c => ({ name: c.name || '', logo: c.logo }));
        }
      }
    } catch (e) {}
    // 2) Rich static seed (regenerated on save), then 3) the flat legacy file.
    for (const url of [rel('../clients-data.json'), CLIENTS_URL]) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          const arr = Array.isArray(data) ? data : (data.clients || []);
          const out = arr.filter(clientsActive).map(c => ({ name: c.name || '', logo: c.logo }));
          if (out.length) return out;
        }
      } catch (e) {}
    }
    return [];
  }

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
      const [partnersData, clients] = await Promise.all([loadPartners(), loadClients()]);
      if (!(partnersData.partners && partnersData.partners.length) && !clients.length) throw new Error('no data');
      mounts.forEach(m => render(m, partnersData, clients));
    } catch (err) {
      console.warn('[tmw-partners] failed to load', err);
      mounts.forEach(m => { m.style.display = 'none'; });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
