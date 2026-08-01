/* ============================================================================
   TMW OUTLETS — the universal "Seven outlets, one network" section.
   Mount anywhere with:  <div data-tmw-outlets></div>
                         <script src="/_shared/outlets.js" defer></script>
   One source of truth for the homepage AND every media-kit page. Renders the
   heading + umbrella-total strip + a partners-style INFINITE coverflow slider
   of outlet cards (no blank edges — it wraps like a circle). The centered card
   is spotlit with the reflective glare sweep. Live follower numbers come from
   the worker /followers feed; social links are deterministic per handle.
   ========================================================================== */
(function () {
  var WORKER = 'https://tmw.jake-ab7.workers.dev';

  // Each outlet: display name, follower key (matches /followers), social handle
  // base, banner image, flagship flag, top sub-markets, and default stats
  // [Followers, Mo. Social, Mo. Web, Interactions]. Followers gets overwritten
  // live; the rest are curated.
  var OUTLETS = [
    { name: 'Florida of Tomorrow',   key: 'florida',   base: 'floridaoftomorrow',   img: '/media/img/9998de3ca8af.jpg', flag: true,  cities: ['WPB','MIA','FLL','NYC'], stats: ['160K','3.5M','1.2M','150K'] },
    { name: 'Hotels of Tomorrow',    key: 'hotels',    base: 'hotelsoftomorrow',    img: '/media/img/381d37b9c210.jpg', flag: false, cities: ['NYC','LAX','AUS','TYO'], stats: ['20K','1.1M','82K','52K'] },
    { name: 'Tennessee of Tomorrow', key: 'tennessee', base: 'tennesseeoftomorrow', img: '/media/img/d3ce63b84f46.jpg', flag: false, cities: ['BNA','FKN','CHI','NYC'], stats: ['12K','305K','41K','32K'] },
    { name: 'New York of Tomorrow',  key: 'newyork',   base: 'newyorkoftomorrow',   img: '/media/img/e3c8a4e4ff38.jpg', flag: false, cities: ['NYC','LON','LAX','CHI'], stats: ['10K','297K','22K','19K'] },
    { name: 'Caribbean of Tomorrow', key: 'caribbean', base: 'caribbeanoftomorrow', img: '/media/img/5d9804404207.jpg', flag: false, cities: ['BHS','MEX','LCA','DOM'], stats: ['2.5K','88K','12K','5.7K'] },
    { name: 'Rockies of Tomorrow',   key: 'rockies',   base: 'rockiesoftomorrow',   img: '/media/img/35b59ff84cf5.jpg', flag: false, cities: ['DEN','SLC','EGE','LAX'], stats: ['400','12K','4.1K','1.1K'] }
  ];
  var STAT_LABELS = ['Followers', 'Mo. Social', 'Mo. Web', 'Interactions'];

  // X uses the "…tmw" handle; everyone else uses the base. Threads is @handle.
  function xHandle(base) { return base.replace(/tomorrow$/, 'tmw'); }
  var SOCIALS = [
    { k: 'instagram', url: function (o) { return 'https://instagram.com/' + o.base; },
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.4" cy="6.6" r="1.1" fill="currentColor" stroke="none"/></svg>' },
    { k: 'facebook', url: function (o) { return 'https://facebook.com/' + o.base; },
      svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 8.5V7c0-.8.5-1 1-1h1.5V3H14c-2.2 0-3.5 1.4-3.5 3.6V8.5H8.5V12h2V21h3.5v-9h2.4l.4-3.5H14z"/></svg>' },
    { k: 'linkedin', url: function (o) { return 'https://www.linkedin.com/company/' + o.base; },
      svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.6 3.5a2.1 2.1 0 100 4.2 2.1 2.1 0 000-4.2zM3 9h3.2v11H3zM9 9h3v1.5c.5-.9 1.7-1.8 3.4-1.8 3 0 3.6 2 3.6 4.6V20h-3.2v-5.1c0-1.2 0-2.7-1.7-2.7s-1.9 1.3-1.9 2.6V20H9z"/></svg>' },
    { k: 'threads', url: function (o) { return 'https://threads.net/@' + o.base; },
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 8.5c-.7-1.6-2.1-2.5-4-2.5-2.8 0-4.6 2-4.6 6s1.8 6 4.6 6c2.2 0 3.6-1.2 3.6-3.1 0-2-1.6-3.1-3.6-3.1-1.4 0-2.4.7-2.4 1.8 0 .9.7 1.5 1.7 1.5 1.2 0 1.9-.9 1.9-2.5"/></svg>' },
    { k: 'x', url: function (o) { return 'https://x.com/' + xHandle(o.base); },
      svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 3h3l-6.6 7.6L21.8 21h-6l-4.3-5.6L6.5 21H3.4l7-8.1L2.6 3h6.1l3.9 5.2L17.5 3zm-1 16h1.7L7.6 4.8H5.8L16.5 19z"/></svg>' }
  ];

  var IG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4.5"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/></svg>';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var CSS =
    '.tmw-outlets{background:#070807;color:#ECEAE5;padding:78px 0 40px;position:relative;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden}' +
    '.tmw-outlets .tmo-wrap{position:relative;z-index:1;max-width:1240px;margin:0 auto;padding:0 28px}' +
    '.tmw-outlets .tmo-eyebrow{font-family:Inter,sans-serif;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#A78BFA;font-weight:600;margin-bottom:12px}' +
    '.tmw-outlets h2{font-family:Fraunces,Georgia,serif;font-weight:600;letter-spacing:-.015em;color:#fff;font-size:clamp(26px,3.2vw,40px);line-height:1.08;margin:0 0 14px}' +
    '.tmw-outlets .tmo-lede{font-size:clamp(15px,1.4vw,18px);color:#C2C9C3;max-width:64ch;line-height:1.55;font-weight:300}' +
    '.tmw-outlets .tmo-lede .g{color:#e6c574;text-shadow:0 0 18px rgba(230,197,116,.35)}' +
    '.tmw-outlets .tmo-umb{margin-top:28px;display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;' +
      'padding:22px 28px;border-radius:18px;border:1px solid rgba(230,197,116,.32);background:linear-gradient(180deg,rgba(230,197,116,.08),rgba(230,197,116,.02));box-shadow:0 0 44px -20px rgba(230,197,116,.5)}' +
    '.tmw-outlets .tmo-umb-lab{font-family:Inter,sans-serif;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#f0d68a;font-weight:600}' +
    '.tmw-outlets .tmo-umb-stats{display:flex;gap:34px;flex-wrap:wrap}' +
    '.tmw-outlets .tmo-us{display:flex;flex-direction:column;gap:3px}' +
    '.tmw-outlets .tmo-uv{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:26px;color:#f0d68a;line-height:1}' +
    '.tmw-outlets .tmo-uk{font-family:Inter,sans-serif;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#9AA39C}' +
    /* full-bleed coverflow */
    '.tmw-outlets .tmo-vp{position:relative;width:100vw;margin-left:calc(50% - 50vw);margin-top:30px;overflow:hidden;padding:16px 0}' +
    '.tmw-outlets .tmo-track{display:flex;gap:22px;transition:transform .7s cubic-bezier(.22,1,.36,1);will-change:transform}' +
    '.tmw-outlets .tmo-card{flex:0 0 auto;width:clamp(300px,30vw,380px);position:relative;display:flex;flex-direction:column;overflow:hidden;' +
      'border-radius:20px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.045);box-shadow:0 18px 50px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06);opacity:.5;cursor:pointer}' +
    '.tmw-outlets .tmo-card.is-active{opacity:1;border-color:rgba(230,197,116,.32);box-shadow:0 30px 80px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.08),0 0 0 1px rgba(230,197,116,.2),0 0 62px -18px rgba(230,197,116,.42)}' +
    '.tmw-outlets .tmo-card.is-active::before{content:"";position:absolute;top:-35%;left:-95%;width:75%;height:170%;z-index:4;pointer-events:none;transform:skewX(-20deg);filter:blur(13px);' +
      'background:linear-gradient(90deg,transparent,rgba(255,255,255,.05) 28%,rgba(255,255,255,.22) 50%,rgba(255,255,255,.05) 72%,transparent);animation:tmoGlare 6s ease-in-out infinite}' +
    '@keyframes tmoGlare{0%{left:-95%}45%{left:165%}100%{left:165%}}' +
    '.tmw-outlets .tmo-ban{position:relative;width:100%;aspect-ratio:2/1;overflow:hidden;border-bottom:1px solid rgba(255,255,255,.08)}' +
    '.tmw-outlets .tmo-ban img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.tmw-outlets .tmo-flag{position:absolute;top:12px;left:12px;font-family:Inter,sans-serif;font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;' +
      'color:#04210f;background:#1FDF67;padding:4px 9px;border-radius:6px}' +
    '.tmw-outlets .tmo-body{padding:22px 22px 22px;display:flex;flex-direction:column;text-align:center}' +
    /* 4 stats, centered */
    '.tmw-outlets .tmo-stats{display:grid;grid-template-columns:1fr 1fr;gap:16px 12px;padding-bottom:18px}' +
    '.tmw-outlets .tmo-st{display:flex;flex-direction:column;gap:3px;align-items:center}' +
    '.tmw-outlets .tmo-sv{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:21px;color:#fff;letter-spacing:-.01em;line-height:1}' +
    '.tmw-outlets .tmo-sk{font-family:Inter,sans-serif;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#9AA39C}' +
    '.tmw-outlets .tmo-div{height:1px;background:rgba(255,255,255,.08);margin:0}' +
    '.tmw-outlets .tmo-citlab{font-family:Inter,sans-serif;font-size:8.5px;letter-spacing:.14em;text-transform:uppercase;color:#9AA39C;margin-top:16px}' +
    '.tmw-outlets .tmo-cities{display:flex;gap:7px;flex-wrap:wrap;justify-content:center;margin:8px 0 16px}' +
    '.tmw-outlets .tmo-chip{font-family:Inter,sans-serif;font-size:9.5px;letter-spacing:.08em;color:#C2C9C3;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);padding:4px 9px;border-radius:5px}' +
    /* social bar */
    '.tmw-outlets .tmo-follow{font-family:Inter,sans-serif;font-size:11px;color:#9AA39C;margin-top:16px}' +
    '.tmw-outlets .tmo-follow b{color:#C2C9C3;font-weight:600}' +
    '.tmw-outlets .tmo-social{display:flex;gap:14px;justify-content:center;margin-top:12px}' +
    '.tmw-outlets .tmo-social a{color:#7d857e;transition:color .15s,transform .15s;display:flex}' +
    '.tmw-outlets .tmo-social a:hover{color:#fff;transform:translateY(-1px)}' +
    '.tmw-outlets .tmo-social svg{width:17px;height:17px}' +
    /* nav */
    '.tmw-outlets .tmo-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:6;width:46px;height:46px;border-radius:50%;' +
      'background:rgba(15,17,15,.72);border:1px solid rgba(255,255,255,.14);color:#fff;display:flex;align-items:center;justify-content:center;' +
      '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);cursor:pointer;transition:background .15s,border-color .15s}' +
    '.tmw-outlets .tmo-nav:hover{background:rgba(30,33,30,.92);border-color:rgba(230,197,116,.45)}' +
    '.tmw-outlets .tmo-nav.prev{left:max(18px,calc(50vw - 648px))}' +
    '.tmw-outlets .tmo-nav.next{right:max(18px,calc(50vw - 648px))}' +
    '.tmw-outlets .tmo-nav svg{width:18px;height:18px}' +
    '.tmw-outlets .tmo-dots{display:flex;gap:8px;justify-content:center;margin-top:20px}' +
    '.tmw-outlets .tmo-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.2);border:0;padding:0;cursor:pointer;transition:background .2s,width .2s}' +
    '.tmw-outlets .tmo-dot.is-active{background:#e6c574;width:20px;border-radius:99px}' +
    '@media(prefers-reduced-motion:reduce){.tmw-outlets .tmo-card.is-active::before{animation:none;opacity:0}.tmw-outlets .tmo-track{transition:none}}' +
    '@media(max-width:640px){.tmw-outlets .tmo-card{width:80vw}.tmw-outlets .tmo-nav{display:none}.tmw-outlets .tmo-umb-stats{gap:20px}}';

  function cardHtml(o) {
    var stats = STAT_LABELS.map(function (lab, i) {
      return '<div class="tmo-st"><span class="tmo-sv" data-fk="' + (i === 0 ? o.key : '') + '">' + esc(o.stats[i] || '—') + '</span><span class="tmo-sk">' + lab + '</span></div>';
    }).join('');
    var cities = o.cities.map(function (c) { return '<span class="tmo-chip">' + esc(c) + '</span>'; }).join('');
    var social = SOCIALS.map(function (s) {
      return '<a href="' + s.url(o) + '" target="_blank" rel="noopener" aria-label="' + s.k + '">' + s.svg + '</a>';
    }).join('');
    return '<div class="tmo-card' + (o.flag ? ' flag' : '') + '" data-key="' + o.key + '">'
      + '<div class="tmo-ban"><img src="' + esc(o.img) + '" alt="' + esc(o.name) + '" loading="lazy">' + (o.flag ? '<span class="tmo-flag">Flagship</span>' : '') + '</div>'
      + '<div class="tmo-body">'
      +   '<div class="tmo-stats">' + stats + '</div>'
      +   '<div class="tmo-div"></div>'
      +   '<div class="tmo-citlab">Largest sub-market audiences</div>'
      +   '<div class="tmo-cities">' + cities + '</div>'
      +   '<div class="tmo-div"></div>'
      +   '<div class="tmo-follow">Follow <b>@' + esc(o.base) + '</b> on socials</div>'
      +   '<div class="tmo-social">' + social + '</div>'
      + '</div>'
      + '</div>';
  }

  function sectionHtml(eyebrow) {
    return '<section class="tmw-outlets">'
      + '<div class="tmo-wrap">'
      +   '<div class="tmo-eyebrow">' + esc(eyebrow) + '</div>'
      +   '<h2>Seven outlets, one network</h2>'
      +   '<p class="tmo-lede"><span class="g">Florida of Tomorrow</span> leads as our <span class="g">flagship</span>, with co-posting across the network where relevant. Together they roll up under the Markets of Tomorrow umbrella.</p>'
      +   '<div class="tmo-umb">'
      +     '<div class="tmo-umb-lab">Markets of Tomorrow &middot; Umbrella Total</div>'
      +     '<div class="tmo-umb-stats">'
      +       '<div class="tmo-us"><span class="tmo-uv" data-fk="umbrella">205K</span><span class="tmo-uk">Followers</span></div>'
      +       '<div class="tmo-us"><span class="tmo-uv">8.1M</span><span class="tmo-uk">Mo. Social</span></div>'
      +       '<div class="tmo-us"><span class="tmo-uv">593K</span><span class="tmo-uk">Mo. Web</span></div>'
      +       '<div class="tmo-us"><span class="tmo-uv">260K</span><span class="tmo-uk">Interactions</span></div>'
      +     '</div>'
      +   '</div>'
      + '</div>'
      + '<div class="tmo-vp">'
      +   '<button class="tmo-nav prev" type="button" aria-label="Previous outlet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>'
      +   '<div class="tmo-track">' + OUTLETS.map(cardHtml).join('') + '</div>'
      +   '<button class="tmo-nav next" type="button" aria-label="Next outlet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>'
      + '</div>'
      + '<div class="tmo-wrap"><div class="tmo-dots"></div></div>'
      + '</section>';
  }

  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
  function liveFollowers(root) {
    fetch(WORKER + '/followers', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        var m = d.markets || {}, umb = d.umbrella || 0;
        if (umb) { var u = root.querySelector('[data-fk="umbrella"]'); if (u) u.textContent = fmt(umb); }
        root.querySelectorAll('.tmo-sv[data-fk]').forEach(function (el) {
          var k = el.getAttribute('data-fk'); if (k && k !== 'umbrella' && m[k] != null) el.textContent = fmt(m[k]);
        });
      }).catch(function () {});
  }

  // ── Coverflow with a seamless infinite loop (mirrors the partners tile) ──
  function setup(root) {
    var vp = root.querySelector('.tmo-vp');
    var track = root.querySelector('.tmo-track');
    var dotsBox = root.querySelector('.tmo-dots');
    if (!vp || !track) return;
    var realCards = [].slice.call(track.querySelectorAll('.tmo-card'));
    var n = realCards.length;
    if (!n) return;

    // Clone last→front and first→end so both edges always show a neighbour and
    // the row wraps like a circle: [lastClone, c0..cN-1, firstClone].
    var firstClone = realCards[0].cloneNode(true);
    var lastClone = realCards[n - 1].cloneNode(true);
    firstClone.classList.add('is-clone'); lastClone.classList.add('is-clone');
    track.insertBefore(lastClone, realCards[0]);
    track.appendChild(firstClone);
    var all = [].slice.call(track.querySelectorAll('.tmo-card'));

    var cur = 1;              // real c0 (Florida) centered; lastClone peeks left
    var teleporting = false;
    var T = 720;

    realCards.forEach(function (_, i) {
      var b = document.createElement('button');
      b.className = 'tmo-dot' + (i === 0 ? ' is-active' : '');
      b.setAttribute('aria-label', 'Go to outlet ' + (i + 1));
      b.addEventListener('click', function () { if (!teleporting) { goTo(i + 1); resume(); } });
      dotsBox.appendChild(b);
    });
    var dots = [].slice.call(dotsBox.children);

    function place(animate) {
      var card = all[cur];
      var x = (vp.offsetWidth / 2) - (card.offsetWidth / 2) - card.offsetLeft;
      if (animate === false) { track.style.transition = 'none'; track.style.transform = 'translateX(' + x + 'px)'; void track.offsetWidth; track.style.transition = ''; }
      else track.style.transform = 'translateX(' + x + 'px)';
      all.forEach(function (c, i) { c.classList.toggle('is-active', i === cur); });
      var di = cur === 0 ? n - 1 : (cur === n + 1 ? 0 : cur - 1);
      dots.forEach(function (d, i) { d.classList.toggle('is-active', i === di); });
    }
    function goTo(i) {
      if (teleporting) return;
      cur = i; place(true);
      if (cur === 0 || cur === n + 1) {
        teleporting = true;
        setTimeout(function () { cur = (cur === 0) ? n : 1; place(false); teleporting = false; }, T);
      }
    }
    function next() { goTo(cur + 1); }
    function prev() { goTo(cur - 1); }

    var timer = setInterval(next, 6000);
    function pause() { clearInterval(timer); }
    function resume() { clearInterval(timer); timer = setInterval(next, 6000); }
    root.addEventListener('mouseenter', pause);
    root.addEventListener('mouseleave', resume);

    var pb = root.querySelector('.tmo-nav.prev'), nb = root.querySelector('.tmo-nav.next');
    if (pb) pb.addEventListener('click', function () { prev(); resume(); });
    if (nb) nb.addEventListener('click', function () { next(); resume(); });

    all.forEach(function (card, i) {
      card.addEventListener('click', function (e) {
        if (i === cur || teleporting) return;
        if (e.target.closest('a')) return;   // let the social links through
        e.preventDefault();
        goTo(card.classList.contains('is-clone') ? (i === 0 ? n : 1) : i);
        resume();
      });
    });

    var rt;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { place(false); }, 120); });
    requestAnimationFrame(function () { place(false); });
    // Re-center once fonts/images settle (the section often mounts far down-page).
    window.addEventListener('load', function () { setTimeout(function () { place(false); }, 90); });
    setTimeout(function () { place(false); }, 600);
  }

  function mount(el) {
    if (el.getAttribute('data-tmw-outlets-done')) return;
    el.setAttribute('data-tmw-outlets-done', '1');
    if (!document.getElementById('tmw-outlets-styles')) {
      var st = document.createElement('style'); st.id = 'tmw-outlets-styles'; st.textContent = CSS; document.head.appendChild(st);
    }
    var eyebrow = el.getAttribute('data-eyebrow') || 'The Network';
    el.innerHTML = sectionHtml(eyebrow);
    var root = el.querySelector('.tmw-outlets');
    var anchor = el.getAttribute('data-anchor'); if (anchor && root) root.id = anchor;
    if (root) { setup(root); liveFollowers(root); }
  }

  document.querySelectorAll('[data-tmw-outlets]').forEach(mount);
})();
