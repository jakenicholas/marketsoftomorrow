"""Shared typeahead search bar for the calculator boxes on the /markets and
/firm hub pages (and mirrored by hand in journal/atlas/index.html — keep the
three in visual lockstep when editing).

Everything here is a PLAIN string interpolated into the generators' page
f-strings, so CSS/JS braces never need doubling (the class of bug behind the
Jul-4 "0 pages" generator outage).
"""

MC_SEARCH_CSS = """
    .mc-search { position: relative; margin-bottom: 14px; }
    .mc-search .mc-s-ico { position: absolute; left: 15px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; fill: none; stroke: var(--purple-bright); stroke-width: 2; stroke-linecap: round; pointer-events: none; }
    .mc-search input { width: 100%; background: rgba(0,0,0,.45); border: 1px solid rgba(167,139,250,.32); border-radius: 10px; padding: 14px 16px 14px 42px; font-family: var(--sans); font-size: 15px; color: var(--white); appearance: none; }
    .mc-search input::placeholder { color: var(--mute); }
    .mc-search input:focus { outline: 0; border-color: var(--purple-bright); }
    .mc-sug { position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 60; background: #101012; border: 1px solid rgba(167,139,250,.32); border-radius: 12px; overflow: hidden; display: none; box-shadow: 0 22px 60px -12px rgba(0,0,0,.85); }
    .mc-sug.show { display: block; }
    .mc-sug a { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 12px 16px; font-size: 14px; color: var(--cream); border-top: 1px solid rgba(255,255,255,.05); cursor: pointer; text-decoration: none; }
    .mc-sug a:first-child { border-top: 0; }
    .mc-sug a:hover, .mc-sug a.sel { background: rgba(167,139,250,.10); }
    .mc-sug .k { font-family: var(--mono); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--mute); flex: none; white-space: nowrap; }
"""


def mc_search_html_for(prefix: str, placeholder: str) -> str:
    """The search field + suggestion panel. Sits inside .mc-box above the form."""
    return (
        f'<div class="mc-search">'
        f'<svg class="mc-s-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>'
        f'<input id="{prefix}-input" type="text" placeholder="{placeholder}" autocomplete="off" spellcheck="false" aria-label="{placeholder}">'
        f'<div class="mc-sug" id="{prefix}-sug"></div>'
        f'</div>'
    )


def mc_search_js_for(prefix: str, items_js: str) -> str:
    """Typeahead wiring. items_js must define, in scope:
      ITEMS   — array of { name, n, meta, ... }
      goItem  — function(item) invoked on pick
    Substring match on name (word-start weighted), ranked by match quality
    then project count, top 8 shown; full keyboard support."""
    return """
    (function() {
      %ITEMS%
      var input = document.getElementById('%P%-input');
      var box = document.getElementById('%P%-sug');
      if (!input || !box) return;
      var cur = [], sel = -1;
      function escT(t){ return String(t).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
      function render(){
        if (!cur.length){ box.classList.remove('show'); box.innerHTML = ''; sel = -1; return; }
        box.innerHTML = cur.map(function(it, i){
          return '<a href="' + escT(it.url || '#') + '" data-i="' + i + '"' + (i === sel ? ' class="sel"' : '') + '>'
            + '<span>' + escT(it.name) + '</span><span class="k">' + escT(it.meta || '') + '</span></a>';
        }).join('');
        box.classList.add('show');
      }
      function update(){
        var q = input.value.trim().toLowerCase();
        if (q.length < 2){ cur = []; render(); return; }
        cur = ITEMS.map(function(it){
            var n = it.name.toLowerCase(), i = n.indexOf(q);
            if (i < 0) return null;
            var m = i === 0 ? 3 : (n.charAt(i - 1) === ' ' ? 2 : 1);
            return { it: it, s: m * 1000 + Math.min(it.n || 0, 999) };
          }).filter(Boolean)
          .sort(function(a, b){ return b.s - a.s; })
          .slice(0, 8).map(function(x){ return x.it; });
        sel = -1; render();
      }
      input.addEventListener('input', update);
      input.addEventListener('keydown', function(e){
        if (e.key === 'ArrowDown'){ if (cur.length){ e.preventDefault(); sel = (sel + 1) % cur.length; render(); } }
        else if (e.key === 'ArrowUp'){ if (cur.length){ e.preventDefault(); sel = (sel - 1 + cur.length) % cur.length; render(); } }
        else if (e.key === 'Enter'){ if (cur.length){ e.preventDefault(); goItem(cur[sel < 0 ? 0 : sel]); } }
        else if (e.key === 'Escape'){ cur = []; render(); input.blur(); }
      });
      box.addEventListener('mousedown', function(e){
        var a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (a){ e.preventDefault(); goItem(cur[+a.getAttribute('data-i')]); }
      });
      document.addEventListener('click', function(e){
        if (!(e.target && e.target.closest && e.target.closest('.mc-search'))){ cur = []; render(); }
      });
    })();
""".replace('%ITEMS%', items_js).replace('%P%', prefix)
