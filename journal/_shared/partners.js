/*
  Partners of Tomorrow — shared mount.

  Usage on any page:
      <div data-tmw-partners></div>
      <script src="/_shared/partners.js" defer></script>

  Renders TWO stacked blocks into the mount (auto-injected before the footer
  if no mount exists, so the section is universal across journal pages):

    1. Signature Partners SPOTLIGHT — coverflow-style carousel of rich cards.
       Active card sits center, full size + bright; neighbors are scaled to .85
       and dimmed. Auto-advances every 6s, pauses on hover, prev/next arrows +
       progress dots. Data comes from the studio-editable list /list/partners
       (falls back to /partners.json).
    2. Client wall — the full media-kit client list (/clients.json), collapsed
       to ~2.5 rows with a fade and a "Load more" that links to /media.
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
  const CLIENT_PREVIEW = 36;

  if (!document.getElementById('tmw-partners-styles')) {
    const css = `
      .tmw-partners{background:#070807; color:#ECEAE5; padding:90px 0 80px; position:relative; font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; border-top:1px solid rgba(255,255,255,.08); border-bottom:1px solid rgba(255,255,255,.08)}
      .tmw-partners::before{content:""; position:absolute; top:-30%; left:50%; transform:translateX(-50%); width:900px; height:600px; background:radial-gradient(closest-side, rgba(31,223,103,.06), transparent 70%); pointer-events:none}
      .tmw-partners-wrap{position:relative; max-width:1320px; margin:0 auto; padding:0 28px}
      .tmw-partners-head{display:flex; align-items:flex-end; justify-content:space-between; gap:24px; flex-wrap:wrap; margin-bottom:38px}
      .tmw-partners-headtxt{flex:1 1 auto; max-width:64ch}
      .tmw-partners-eyebrow{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; font-size:11px; letter-spacing:.24em; text-transform:uppercase; color:#42EB81; font-weight:500; margin-bottom:14px}
      .tmw-partners-title{font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:clamp(32px,4.2vw,50px); letter-spacing:-.02em; line-height:1.04; color:#fff; margin:0}
      .tmw-partners-sub{font-family:'Fraunces',Georgia,serif; font-weight:300; font-style:italic; font-size:17px; color:#C2C9C3; margin-top:14px; max-width:48ch; line-height:1.5}
      .tmw-partners-controls{display:flex; align-items:center; gap:10px}
      .tmw-partners-arrow{width:44px; height:44px; border-radius:50%; background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.08); color:#ECEAE5; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:background .15s, border-color .15s, color .15s, transform .15s; padding:0}
      .tmw-partners-arrow:hover{background:rgba(255,255,255,.06); border-color:rgba(255,255,255,.14); color:#fff; transform:translateY(-1px)}
      .tmw-partners-arrow svg{width:16px; height:16px}

      /* Spotlight carousel -- breaks out of .tmw-partners-wrap to full 100vw */
      .tmw-spot-viewport{position:relative; overflow:hidden; padding:36px 0; margin-top:-36px; margin-bottom:0; width:100vw; margin-left:calc(50% - 50vw)}
      .tmw-spot-track{display:flex; gap:16px; transition:transform .75s cubic-bezier(.22,1,.36,1); will-change:transform; padding:0}
      .tmw-spot-card{flex:0 0 72%; display:grid; grid-template-columns:1.05fr 1fr; overflow:hidden; padding:0; height:620px;
        background:rgba(255,255,255,.025); border:1px solid rgba(255,255,255,.08); border-radius:20px;
        box-shadow:0 24px 64px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.05);
        backdrop-filter:blur(16px) saturate(1.4); -webkit-backdrop-filter:blur(16px) saturate(1.4);
        transform:scale(.92); opacity:.5; filter:brightness(.5) saturate(.75); cursor:pointer;
        transition:transform .65s cubic-bezier(.22,1,.36,1), opacity .55s ease, filter .55s ease, border-color .25s, box-shadow .25s}
      .tmw-spot-body{overflow:hidden}
      .tmw-spot-card:not(.is-active):hover{opacity:.7; filter:brightness(.7) saturate(.9)}
      .tmw-spot-card.is-active{transform:scale(1); opacity:1; filter:none; cursor:default; z-index:2; box-shadow:0 32px 80px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.05)}
      .tmw-spot-card.is-active:hover{border-color:rgba(255,255,255,.14)}
      .tmw-spot-card .tmw-spot-cta, .tmw-spot-card .tmw-spot-sec{pointer-events:auto}
      .tmw-spot-card:not(.is-active) .tmw-spot-cta, .tmw-spot-card:not(.is-active) .tmw-spot-sec{pointer-events:none}

      .tmw-spot-img{position:relative; overflow:hidden; background:#15171a}
      .tmw-spot-img > img{width:100%; height:100%; object-fit:cover; transition:transform 1s ease}
      .tmw-spot-card.is-active:hover .tmw-spot-img > img{transform:scale(1.03)}
      .tmw-spot-img::after{content:""; position:absolute; inset:0; background:linear-gradient(90deg, transparent 60%, rgba(7,8,7,.4) 100%); pointer-events:none}
      .tmw-spot-imgph{width:100%; height:100%; display:flex; align-items:center; justify-content:center; text-align:center; background:radial-gradient(120% 80% at 30% 40%, #232830 0%, #15181d 60%, #0c0e12 100%); position:relative}
      .tmw-spot-imgph::before{content:""; position:absolute; inset:0; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); opacity:.04; pointer-events:none}
      .tmw-spot-imgph span{font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:clamp(26px,3vw,40px); color:rgba(255,255,255,.5); letter-spacing:-.015em; line-height:1.05; text-transform:uppercase; padding:0 14px}

      .tmw-spot-ribbon{position:absolute; top:22px; left:22px; z-index:2; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:10.5px; letter-spacing:.18em; text-transform:uppercase; font-weight:700; padding:6px 13px; border-radius:6px; line-height:1; background:#e6c574; color:#070807; box-shadow:0 8px 22px rgba(230,197,116,.45); display:inline-flex; align-items:center; gap:7px}
      .tmw-spot-ribbon::before{content:""; width:6px; height:6px; border-radius:50%; background:#070807; animation:tmw-rib-pulse 1.8s ease-in-out infinite}
      @keyframes tmw-rib-pulse{0%,100%{opacity:1}50%{opacity:.35}}

      .tmw-spot-body{padding:46px 50px 38px; display:flex; flex-direction:column}
      .tmw-spot-cat{font-family:'JetBrains Mono',ui-monospace,monospace; font-size:11px; letter-spacing:.22em; text-transform:uppercase; color:#9AA39C; margin-bottom:18px; display:inline-flex; align-items:center; gap:10px}
      .tmw-spot-cat::before{content:""; width:5px; height:5px; border-radius:50%; background:#e6c574; box-shadow:0 0 8px #e6c574; flex:none}
      .tmw-spot-logo{font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:clamp(30px,3.1vw,44px); color:#fff; letter-spacing:-.025em; line-height:1.06; margin-bottom:8px}
      .tmw-spot-sub{font-family:'Fraunces',Georgia,serif; font-style:italic; font-weight:300; font-size:clamp(17px,1.7vw,21px); color:#ECEAE5; margin-bottom:22px; line-height:1.25}
      .tmw-spot-desc{font-size:15px; color:#C2C9C3; line-height:1.55; font-weight:300; margin-bottom:28px; max-width:48ch}
      .tmw-spot-offer{padding:22px 24px; border-radius:12px; background:linear-gradient(180deg,rgba(230,197,116,.07),rgba(230,197,116,.02)); border:1px solid rgba(230,197,116,.28); margin-top:auto; margin-bottom:26px}
      .tmw-spot-offer-head{display:flex; align-items:center; gap:10px; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:10.5px; letter-spacing:.18em; text-transform:uppercase; color:#f0d68a; font-weight:600; margin-bottom:10px}
      .tmw-spot-offer-head svg{width:14px; height:14px}
      .tmw-spot-offer-body{font-family:'Fraunces',Georgia,serif; font-weight:500; font-size:18px; color:#fff; letter-spacing:-.01em; line-height:1.3; margin-bottom:8px}
      .tmw-spot-offer-body em{color:#f0d68a; font-style:normal; font-weight:600}
      .tmw-spot-offer-foot{font-family:'JetBrains Mono',ui-monospace,monospace; font-size:10.5px; letter-spacing:.06em; color:#9AA39C}
      .tmw-spot-spacer{margin-top:auto}
      .tmw-spot-cta-row{display:flex; gap:14px; align-items:center; flex-wrap:wrap}
      .tmw-spot-cta{display:inline-flex; align-items:center; gap:9px; padding:13px 22px; border-radius:999px; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:11.5px; letter-spacing:.1em; text-transform:uppercase; font-weight:500; text-decoration:none; transition:background .2s, border-color .2s, color .2s, transform .2s, box-shadow .2s;
        border:1px solid rgba(230,197,116,.45); background:rgba(230,197,116,.1); color:#f0d68a; text-shadow:0 0 10px rgba(230,197,116,.3); box-shadow:0 0 20px rgba(230,197,116,.16)}
      .tmw-spot-cta:hover{background:rgba(230,197,116,.18); border-color:#e6c574; box-shadow:0 0 30px rgba(230,197,116,.35); transform:translateY(-1px)}
      .tmw-spot-cta svg{width:14px; height:14px; transition:transform .2s}
      .tmw-spot-cta:hover svg{transform:translateX(2px)}
      .tmw-spot-cta.neutral{border-color:rgba(255,255,255,.14); background:rgba(255,255,255,.025); color:#ECEAE5; text-shadow:none; box-shadow:none}
      .tmw-spot-cta.neutral:hover{background:rgba(255,255,255,.05); border-color:rgba(255,255,255,.2); box-shadow:none}
      .tmw-spot-sec{font-family:'JetBrains Mono',ui-monospace,monospace; font-size:11px; letter-spacing:.08em; color:#9AA39C; text-decoration:none; transition:color .15s}
      .tmw-spot-sec:hover{color:#ECEAE5}

      .tmw-spot-dots{display:flex; justify-content:center; gap:8px; margin-top:32px}
      .tmw-spot-dot{width:26px; height:6px; border-radius:3px; background:rgba(255,255,255,.1); border:none; padding:0; cursor:pointer; transition:background .2s, width .25s ease}
      .tmw-spot-dot:hover{background:rgba(255,255,255,.2)}
      .tmw-spot-dot.is-active{background:#42EB81; width:46px; box-shadow:0 0 12px rgba(31,223,103,.4)}

      @media(max-width:1100px){
        .tmw-spot-card{flex:0 0 82%; height:600px}
        .tmw-spot-track{gap:12px}
      }
      @media(max-width:880px){
        .tmw-spot-card{flex:0 0 92%; grid-template-columns:1fr; height:auto; min-height:auto; transform:scale(.94)}
        .tmw-spot-img{aspect-ratio:16/10}
        /* Trim mobile body padding 30/26 -> 22/20, drop the bottom margin
           on the offer panel + spacer that previously pushed CTAs to a
           fixed 620px height. On mobile the card is height:auto, so the
           "margin-top:auto" spacers were just adding empty space below
           the content. Also tighten the per-section bottom margins so
           the card breathes without sprawling. */
        .tmw-spot-body{padding:22px 20px 20px; overflow:visible}
        .tmw-spot-cat{margin-bottom:12px}
        .tmw-spot-sub{margin-bottom:14px}
        .tmw-spot-desc{margin-bottom:18px}
        .tmw-spot-offer{margin-top:0; margin-bottom:16px; padding:16px 18px}
        .tmw-spot-spacer{margin-top:0}
        .tmw-spot-viewport{padding:18px 0; margin-top:-18px; margin-bottom:0; width:100vw; margin-left:calc(50% - 50vw)}
      }

      /* Client wall (unchanged) */
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
      .tmw-clients-more a{display:inline-flex; align-items:center; gap:10px; padding:14px 30px; border-radius:999px; border:1px solid rgba(255,255,255,.16); background:rgba(13,15,13,.92); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); color:#ECEAE5; font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; font-size:12px; letter-spacing:.16em; text-transform:uppercase; text-decoration:none; transition:all .2s}
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

  const ARROW_SVG = '<svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"/></svg>';
  const SPARK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/></svg>';

  function spotlightCard(p) {
    const imgHtml = p.image
      ? '<img src="' + esc(p.image) + '" alt="" loading="lazy">'
      : '<div class="tmw-spot-imgph"><span>' + esc(p.name || '') + '</span></div>';
    const ribbonHtml = p.offer
      ? '<span class="tmw-spot-ribbon">' + esc(p.offer) + '</span>'
      : '';
    const subHtml = p.subtitle
      ? '<div class="tmw-spot-sub">' + esc(p.subtitle) + '</div>'
      : '';
    const descHtml = p.description
      ? '<p class="tmw-spot-desc">' + esc(p.description) + '</p>'
      : '';
    // Every card carries the gold deal tile. offerBody is the rich case (trusted
    // HTML so studio editors can emphasize with <em>); otherwise fall back through
    // the offer-label and then a generic invitation, so a card never renders
    // without the gold treatment.
    let offerBodyHtml;
    if (p.offerBody) {
      offerBodyHtml = p.offerBody;
    } else if (p.offer) {
      offerBodyHtml = 'Reach out to claim our <em>' + esc(String(p.offer).toLowerCase()) + '</em> for our readers.';
    } else {
      offerBodyHtml = 'Exclusive perks available for our readers &mdash; <em>get in touch</em>.';
    }
    const offerHtml =
      '<div class="tmw-spot-offer">' +
        '<div class="tmw-spot-offer-head">' + SPARK_SVG + 'Exclusive for our readers</div>' +
        '<div class="tmw-spot-offer-body">' + offerBodyHtml + '</div>' +
        (p.offerFootnote ? '<div class="tmw-spot-offer-foot">' + esc(p.offerFootnote) + '</div>' : '') +
      '</div>';
    // Always pair the gold tile with a gold CTA -- visual language stays consistent.
    const ctaClass = 'tmw-spot-cta';
    const ctaHtml = p.ctaUrl
      ? '<a class="' + ctaClass + '" href="' + esc(p.ctaUrl) + '" target="_blank" rel="noopener">' + esc(p.ctaLabel || 'Learn More') + ' ' + ARROW_SVG + '</a>'
      : '';
    const secHtml = (p.secondaryUrl && p.secondaryLabel)
      ? '<a class="tmw-spot-sec" href="' + esc(p.secondaryUrl) + '">' + esc(p.secondaryLabel) + ' &nearr;</a>'
      : '';
    return '<article class="tmw-spot-card" data-partner-id="' + esc(p.id || '') + '">' +
      '<div class="tmw-spot-img">' + ribbonHtml + imgHtml + '</div>' +
      '<div class="tmw-spot-body">' +
        '<div class="tmw-spot-cat">' + esc(p.category || '') + '</div>' +
        '<div class="tmw-spot-logo">' + esc(p.name || '') + '</div>' +
        subHtml + descHtml + offerHtml +
        '<div class="tmw-spot-cta-row">' + ctaHtml + secHtml + '</div>' +
      '</div>' +
    '</article>';
  }

  function logoTile(c) {
    if (!c || !c.logo) return '';
    return '<div class="tmw-client" title="' + esc(c.name) + '"><img src="' + esc(c.logo) + '" alt="' + esc(c.name) + '" loading="lazy"></div>';
  }

  function render(mount, partnersData, clients) {
    const head = partnersData.header || {};
    const partners = (partnersData.partners || []).filter(p => p && p.active !== false);
    const preview = clients.slice(0, CLIENT_PREVIEW);
    mount.classList.add('tmw-partners');
    // Opt-in: <div data-tmw-partners="spotlight"> renders ONLY the signature-
    // partners carousel (no client wall) — for pages that already show the full
    // client list (e.g. the media kit, which has its own filterable partner grid).
    const spotlightOnly = (mount.getAttribute('data-tmw-partners') || '').indexOf('spotlight') >= 0;

    const prevSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
    const nextSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

    mount.innerHTML =
      '<div class="tmw-partners-wrap">' +
        (partners.length ? (
          '<div class="tmw-partners-head">' +
            '<div class="tmw-partners-headtxt">' +
              (head.eyebrow ? '<div class="tmw-partners-eyebrow">' + esc(head.eyebrow) + '</div>' : '<div class="tmw-partners-eyebrow">Partners Spotlight</div>') +
              '<h2 class="tmw-partners-title">' + (head.title ? esc(head.title) : 'In good company.') + '</h2>' +
              (head.sub ? '<p class="tmw-partners-sub">' + esc(head.sub) + '</p>' : '<p class="tmw-partners-sub">Brands we work with &mdash; each with an exclusive offer for our readers.</p>') +
            '</div>' +
            '<div class="tmw-partners-controls">' +
              '<button class="tmw-partners-arrow tmw-partners-prev" aria-label="Previous">' + prevSvg + '</button>' +
              '<button class="tmw-partners-arrow tmw-partners-next" aria-label="Next">' + nextSvg + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="tmw-spot-viewport">' +
            '<div class="tmw-spot-track">' + partners.map(spotlightCard).join('') + '</div>' +
          '</div>' +
          '<div class="tmw-spot-dots"></div>'
        ) : '') +
        ((!spotlightOnly && preview.length) ? (
          '<div class="tmw-clients">' +
            '<div class="tmw-clients-head">' +
              '<h3 class="tmw-clients-title">We\'re grateful to work with some incredible people</h3>' +
            '</div>' +
            '<div class="tmw-clients-collapse">' +
              '<div class="tmw-clients-grid">' + preview.map(logoTile).join('') + '</div>' +
            '</div>' +
            '<div class="tmw-clients-more">' +
              '<a href="' + MEDIA_URL + '">Load more' +
                '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>' +
              '</a>' +
            '</div>' +
          '</div>'
        ) : '') +
      '</div>';

    if (partners.length) setupSpotlight(mount);
  }

  // Coverflow-style carousel with seamless infinite loop. We clone the first and
  // last cards onto opposite ends so the user can scroll forward off the end and
  // backward off the start without ever seeing a hard jump. After the transition
  // settles on a clone, we teleport to the real card at the same visual position
  // (transition disabled), making the loop look continuous.
  //
  // Track layout after setup:  [last']  card0  card1 .. cardN-1  [first']
  // Active index starts at 1 (real card0), so [last'] is visible as the dimmed
  // peek on the left -- giving users an immediate sense of the carousel wrapping.
  function setupSpotlight(mount) {
    const track = mount.querySelector('.tmw-spot-track');
    const viewport = mount.querySelector('.tmw-spot-viewport');
    const dotsBox = mount.querySelector('.tmw-spot-dots');
    if (!track || !viewport || !dotsBox) return;
    const realCards = [].slice.call(track.querySelectorAll('.tmw-spot-card'));
    if (!realCards.length) return;
    const totalReal = realCards.length;

    // Single card -- skip the loop machinery, just show it.
    if (totalReal === 1) {
      realCards[0].classList.add('is-active');
      track.style.transform = 'translateX(0)';
      return;
    }

    // Clone first and last for the wrap illusion.
    const firstClone = realCards[0].cloneNode(true);
    const lastClone = realCards[totalReal - 1].cloneNode(true);
    firstClone.classList.add('is-clone');
    lastClone.classList.add('is-clone');
    track.insertBefore(lastClone, realCards[0]);
    track.appendChild(firstClone);

    const allCards = [].slice.call(track.querySelectorAll('.tmw-spot-card'));
    // [lastClone, real0, real1, ..., realN-1, firstClone] -- N+2 total.
    // Real cards live at positions 1..N; clones at 0 and N+1.
    let currentIndex = 1;
    let isTeleporting = false;
    const TRANSITION_MS = 700;  // matches CSS transition duration with a small buffer

    // Build dots -- one per real card only.
    realCards.forEach(function (_, i) {
      const b = document.createElement('button');
      b.className = 'tmw-spot-dot' + (i === 0 ? ' is-active' : '');
      b.setAttribute('aria-label', 'Go to partner ' + (i + 1));
      b.addEventListener('click', function () {
        if (isTeleporting) return;
        goTo(i + 1);  // dot i maps to position i+1 (after the lastClone at 0)
        resume();
      });
      dotsBox.appendChild(b);
    });
    const dots = [].slice.call(dotsBox.children);

    function update(animate) {
      const card = allCards[currentIndex];
      const cardWidth = card.offsetWidth;
      const containerWidth = viewport.offsetWidth;
      const targetX = (containerWidth / 2) - (cardWidth / 2) - card.offsetLeft;
      if (animate === false) {
        track.style.transition = 'none';
        track.style.transform = 'translateX(' + targetX + 'px)';
        // Force reflow so the next transition reinstatement doesn't batch with the jump.
        void track.offsetWidth;
        track.style.transition = '';
      } else {
        track.style.transform = 'translateX(' + targetX + 'px)';
      }
      allCards.forEach(function (c, i) { c.classList.toggle('is-active', i === currentIndex); });
      // Dot follows the visible real card -- clones map back to their originals.
      let dotIndex;
      if (currentIndex === 0) dotIndex = totalReal - 1;       // lastClone -> last
      else if (currentIndex === totalReal + 1) dotIndex = 0;  // firstClone -> first
      else dotIndex = currentIndex - 1;
      dots.forEach(function (d, i) { d.classList.toggle('is-active', i === dotIndex); });
    }

    function goTo(i) {
      if (isTeleporting) return;
      currentIndex = i;
      update(true);
      // If we just landed on a clone, schedule a snap to the real twin.
      if (currentIndex === 0 || currentIndex === totalReal + 1) {
        isTeleporting = true;
        setTimeout(function () {
          currentIndex = (currentIndex === 0) ? totalReal : 1;
          update(false);
          isTeleporting = false;
        }, TRANSITION_MS);
      }
    }
    function next() { goTo(currentIndex + 1); }
    function prev() { goTo(currentIndex - 1); }

    let timer = setInterval(next, 6000);
    function pause() { clearInterval(timer); }
    function resume() { clearInterval(timer); timer = setInterval(next, 6000); }
    mount.addEventListener('mouseenter', pause);
    mount.addEventListener('mouseleave', resume);

    const prevBtn = mount.querySelector('.tmw-partners-prev');
    const nextBtn = mount.querySelector('.tmw-partners-next');
    if (prevBtn) prevBtn.addEventListener('click', function () { prev(); resume(); });
    if (nextBtn) nextBtn.addEventListener('click', function () { next(); resume(); });

    // Click a dimmed side card to jump to it. Clones snap to their real twins.
    allCards.forEach(function (card, i) {
      card.addEventListener('click', function (e) {
        if (i === currentIndex || isTeleporting) return;
        e.preventDefault();
        e.stopPropagation();
        // Clicking a clone -> jump straight to its real counterpart without the teleport hop.
        if (card.classList.contains('is-clone')) {
          goTo(i === 0 ? totalReal : 1);
        } else {
          goTo(i);
        }
        resume();
      });
    });

    let rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { update(false); }, 120);
    });

    // Initial position -- center the real first card, no animation.
    requestAnimationFrame(function () { update(false); });
  }

  function toPartnersShape(data) {
    if (data && Array.isArray(data.items) && !data.partners) {
      return { header: { eyebrow: 'PARTNERS SPOTLIGHT', title: data.title || 'In good company.', sub: data.subtitle || '' }, partners: data.items };
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
    try {
      const r = await fetch(WORKER + '/list/clients', { cache: 'no-store' });
      if (r.ok) {
        const w = await r.json();
        if (w && w.exists && w.data && Array.isArray(w.data.items) && w.data.items.length) {
          return w.data.items.filter(clientsActive).map(c => ({ name: c.name || '', logo: c.logo }));
        }
      }
    } catch (e) {}
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
