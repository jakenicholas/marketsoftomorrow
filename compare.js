/**
 * Markets of Tomorrow — Comparisons feature (Commit 1: builder + storage)
 * --------------------------------------------------------------------
 * PRO-only feature. Lets paid members:
 *   1. Search the project list and select up to 6 projects
 *   2. Name and save a comparison view (persisted to Memberstack JSON)
 *   3. Manage saved comparisons (rename, delete)
 *
 * Commit 2 (next) will add the actual comparison render — a map + cards
 * split view at /?compare=<id> that anyone signed-in can view.
 *
 * Storage shape (Memberstack member JSON):
 *   {
 *     comparisons: [
 *       { id: "abc123", name: "PB Beach Hotels",
 *         slugs: ["nora-hotel","delux-weho"], created: "2026-05-05T12:00:00Z" }
 *     ]
 *   }
 *
 * Dependencies (provided by index.html):
 *   - window.$memberstackDom               (auth + JSON storage)
 *   - window.projectSlugify(title)         (canonical slug fn)
 *   - window.allProjectFeatures            (master list of project features)
 *   - window.isPaidMember (read via getter helper below to avoid stale capture)
 *   - window.showSubscriptionPaywall()     (existing paywall trigger)
 */

(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────
  const MAX_PROJECTS_PER_COMPARISON = 6;
  const MAX_NAME_LENGTH = 60;
  const STORAGE_KEY = 'comparisons'; // key inside Memberstack member JSON

  // In-memory cache of the user's saved comparisons (loaded on auth resolve)
  let savedComparisons = [];
  // The comparison currently being built/edited in the modal
  let workingDraft = createEmptyDraft();

  function createEmptyDraft() {
    return { id: null, name: '', slugs: [] };
  }

  // ─── Read the live paid-member state (avoids stale closures) ──────────────
  // index.html owns `isPaidMember` as a top-level let, but we can read auth state
  // through the cached hint that paywallCheck uses. Mirror that logic here so
  // the gate stays in sync even during the load window before Memberstack reports.
  function isPaidMember() {
    try {
      // Prefer the localStorage hint (set by index.html's refreshMemberStatus)
      const hint = localStorage.getItem('mot_auth_hint');
      if (hint === 'paid') return true;
    } catch (e) { /* ignore */ }
    // Fall back to a globally exposed value if index.html chooses to expose it
    return !!window._isPaidMember;
  }

  function isSignedIn() {
    try {
      const hint = localStorage.getItem('mot_auth_hint');
      return hint === 'paid' || hint === 'free';
    } catch (e) { return false; }
  }

  // ─── ID generation (short, URL-safe) ──────────────────────────────────────
  function generateId() {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) {
      id += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return id;
  }

  // ─── Memberstack JSON storage ─────────────────────────────────────────────
  async function loadComparisonsFromMember() {
    if (!window.$memberstackDom) return [];
    try {
      const result = await window.$memberstackDom.getMemberJSON();
      const json = result?.data || {};
      const arr = Array.isArray(json[STORAGE_KEY]) ? json[STORAGE_KEY] : [];
      // Defensive validation — drop malformed entries rather than crash later
      savedComparisons = arr.filter(c =>
        c && typeof c.id === 'string' &&
        typeof c.name === 'string' &&
        Array.isArray(c.slugs)
      );
      return savedComparisons;
    } catch (e) {
      console.warn('[Compare] load error:', e);
      savedComparisons = [];
      return [];
    }
  }

  async function saveComparisonsToMember() {
    if (!window.$memberstackDom) return false;
    try {
      // updateMemberJSON merges, so this preserves favorites & other keys
      await window.$memberstackDom.updateMemberJSON({
        json: { [STORAGE_KEY]: savedComparisons }
      });
      return true;
    } catch (e) {
      console.warn('[Compare] save error:', e);
      return false;
    }
  }

  // ─── Public CRUD API (used by builder UI + future comparison view) ────────
  window.comparisons = {
    list() { return savedComparisons.slice(); },

    get(id) {
      return savedComparisons.find(c => c.id === id) || null;
    },

    async create({ name, slugs }) {
      if (!isPaidMember()) return { error: 'paywall' };
      const cleanName = (name || '').trim().slice(0, MAX_NAME_LENGTH);
      if (!cleanName) return { error: 'name_required' };
      const cleanSlugs = (slugs || []).filter(s => typeof s === 'string' && s);
      if (!cleanSlugs.length) return { error: 'no_projects' };
      if (cleanSlugs.length > MAX_PROJECTS_PER_COMPARISON) {
        return { error: 'too_many' };
      }
      const entry = {
        id: generateId(),
        name: cleanName,
        slugs: cleanSlugs.slice(0, MAX_PROJECTS_PER_COMPARISON),
        created: new Date().toISOString()
      };
      savedComparisons.unshift(entry);
      const ok = await saveComparisonsToMember();
      if (!ok) {
        // Revert local cache if save failed
        savedComparisons.shift();
        return { error: 'save_failed' };
      }
      return { entry };
    },

    async update(id, { name, slugs }) {
      if (!isPaidMember()) return { error: 'paywall' };
      const idx = savedComparisons.findIndex(c => c.id === id);
      if (idx === -1) return { error: 'not_found' };
      const previous = savedComparisons[idx];
      const next = Object.assign({}, previous);
      if (typeof name === 'string') {
        const clean = name.trim().slice(0, MAX_NAME_LENGTH);
        if (!clean) return { error: 'name_required' };
        next.name = clean;
      }
      if (Array.isArray(slugs)) {
        const cleanSlugs = slugs.filter(s => typeof s === 'string' && s);
        if (!cleanSlugs.length) return { error: 'no_projects' };
        next.slugs = cleanSlugs.slice(0, MAX_PROJECTS_PER_COMPARISON);
      }
      savedComparisons[idx] = next;
      const ok = await saveComparisonsToMember();
      if (!ok) {
        savedComparisons[idx] = previous;
        return { error: 'save_failed' };
      }
      return { entry: next };
    },

    async remove(id) {
      if (!isPaidMember()) return { error: 'paywall' };
      const idx = savedComparisons.findIndex(c => c.id === id);
      if (idx === -1) return { error: 'not_found' };
      const removed = savedComparisons.splice(idx, 1)[0];
      const ok = await saveComparisonsToMember();
      if (!ok) {
        savedComparisons.splice(idx, 0, removed);
        return { error: 'save_failed' };
      }
      return { ok: true };
    },

    // Used by index.html's auth flow — call after refreshMemberStatus resolves
    async hydrate() {
      if (isSignedIn()) await loadComparisonsFromMember();
    },

    // Reset state on logout
    clear() {
      savedComparisons = [];
      workingDraft = createEmptyDraft();
    },

    // For the modal — open with a fresh draft, or pre-populate with given slugs
    openBuilder(opts) {
      openBuilderModal(opts || {});
    }
  };

  // ─── Builder modal UI ─────────────────────────────────────────────────────
  // Created lazily on first open and reused thereafter.
  let modalEl = null;

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.id = 'compareBuilderModal';
    modalEl.className = 'compare-modal';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.setAttribute('aria-labelledby', 'compareBuilderTitle');
    modalEl.innerHTML = `
      <div class="compare-modal-backdrop" data-close="1"></div>
      <div class="compare-modal-card">
        <header class="compare-modal-header">
          <h2 id="compareBuilderTitle" class="compare-modal-title">New comparison</h2>
          <button type="button" class="compare-modal-close" aria-label="Close" data-close="1">&times;</button>
        </header>

        <section class="compare-modal-body">
          <div class="compare-saved-section" hidden>
            <div class="compare-saved-label">Saved comparisons</div>
            <div class="compare-saved-list"></div>
            <button type="button" class="compare-btn compare-btn-ghost compare-new-btn" data-action="new">
              + New comparison
            </button>
            <div class="compare-saved-divider"></div>
          </div>

          <div class="compare-builder-section">
            <label class="compare-field">
              <span class="compare-field-label">Comparison name</span>
              <input type="text" class="compare-name-input" maxlength="${MAX_NAME_LENGTH}"
                     placeholder="e.g. West Palm Beach hotels" />
            </label>

            <div class="compare-slots-wrap">
              <div class="compare-slots-label">
                <span>Selected projects</span>
                <span class="compare-slots-count"></span>
              </div>
              <div class="compare-slots" role="list"></div>
            </div>

            <div class="compare-search-wrap">
              <input type="text" class="compare-search-input" placeholder="Search projects to add…" />
              <div class="compare-search-results" role="listbox"></div>
            </div>
          </div>
        </section>

        <footer class="compare-modal-footer">
          <button type="button" class="compare-btn compare-btn-ghost" data-close="1">Cancel</button>
          <button type="button" class="compare-btn compare-btn-primary" data-action="save" disabled>
            Save
          </button>
        </footer>
      </div>
    `;
    document.body.appendChild(modalEl);

    // Close handlers — backdrop click, X button, Cancel button
    modalEl.addEventListener('click', (e) => {
      const target = e.target;
      if (target instanceof Element && target.closest('[data-close]')) {
        closeBuilderModal();
      }
    });

    // Esc key closes
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalEl.classList.contains('open')) closeBuilderModal();
    });

    // Wire up form fields
    const nameInput = modalEl.querySelector('.compare-name-input');
    nameInput.addEventListener('input', () => {
      workingDraft.name = nameInput.value;
      refreshSaveButton();
    });

    const searchInput = modalEl.querySelector('.compare-search-input');
    searchInput.addEventListener('input', () => {
      renderSearchResults(searchInput.value);
    });

    const saveBtn = modalEl.querySelector('[data-action="save"]');
    saveBtn.addEventListener('click', handleSave);

    // "+ New comparison" button — clears the working draft and shows the builder section
    const newBtn = modalEl.querySelector('[data-action="new"]');
    newBtn.addEventListener('click', () => {
      workingDraft = createEmptyDraft();
      modalEl.querySelector('#compareBuilderTitle').textContent = 'New comparison';
      modalEl.querySelector('.compare-name-input').value = '';
      modalEl.querySelector('.compare-search-input').value = '';
      renderSlots();
      renderSearchResults('');
      refreshSaveButton();
      // Hide the saved section while building so the user can focus
      modalEl.querySelector('.compare-saved-section').setAttribute('hidden', '');
      modalEl.querySelector('.compare-name-input').focus();
    });

    return modalEl;
  }

  // Render the list of saved comparisons. Only shown when opening the modal
  // without a specific edit target — gives the user a glance of what they've saved.
  function renderSavedList() {
    if (!modalEl) return;
    const section = modalEl.querySelector('.compare-saved-section');
    const list = modalEl.querySelector('.compare-saved-list');
    if (!savedComparisons.length) {
      section.setAttribute('hidden', '');
      return;
    }
    section.removeAttribute('hidden');
    list.innerHTML = savedComparisons.map(c => {
      const count = c.slugs.length;
      return `
        <div class="compare-saved-row" data-id="${escapeAttr(c.id)}">
          <div class="compare-saved-row-meta">
            <div class="compare-saved-row-name">${escapeHtml(c.name)}</div>
            <div class="compare-saved-row-sub">${count} project${count === 1 ? '' : 's'}</div>
          </div>
          <div class="compare-saved-row-actions">
            <button type="button" class="compare-saved-btn" data-saved-edit="${escapeAttr(c.id)}" aria-label="Edit">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button type="button" class="compare-saved-btn compare-saved-btn-danger" data-saved-remove="${escapeAttr(c.id)}" aria-label="Delete">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Wire actions
    list.querySelectorAll('[data-saved-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.savedEdit;
        const existing = savedComparisons.find(c => c.id === id);
        if (!existing) return;
        workingDraft = { id: existing.id, name: existing.name, slugs: existing.slugs.slice() };
        modalEl.querySelector('#compareBuilderTitle').textContent = 'Edit comparison';
        modalEl.querySelector('.compare-name-input').value = workingDraft.name;
        modalEl.querySelector('.compare-search-input').value = '';
        renderSlots();
        renderSearchResults('');
        refreshSaveButton();
        section.setAttribute('hidden', '');
        modalEl.querySelector('.compare-name-input').focus();
      });
    });
    list.querySelectorAll('[data-saved-remove]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.savedRemove;
        const existing = savedComparisons.find(c => c.id === id);
        if (!existing) return;
        if (!window.confirm(`Delete "${existing.name}"?`)) return;
        const result = await window.comparisons.remove(id);
        if (result.error) {
          showToast('Could not delete. Try again.');
          return;
        }
        showToast('Comparison deleted.');
        renderSavedList();
        document.dispatchEvent(new CustomEvent('comparisons:updated'));
      });
    });
  }

  function openBuilderModal(opts) {
    if (!isPaidMember()) {
      // Mirror existing paywall behavior — for free signed-in users, show the
      // subscription paywall. For anonymous users, the signup wall is more
      // appropriate but we leave that decision to the existing helper.
      if (typeof window.showSubscriptionPaywall === 'function') {
        window.showSubscriptionPaywall();
      } else if (typeof window.showSignupWall === 'function') {
        window.showSignupWall();
      }
      return;
    }

    const el = ensureModal();

    // Reset / prepare the working draft based on opts:
    //   - opts.editId: editing an existing comparison
    //   - opts.prefillSlugs: starting fresh but with some projects pre-selected
    if (opts.editId) {
      const existing = savedComparisons.find(c => c.id === opts.editId);
      workingDraft = existing
        ? { id: existing.id, name: existing.name, slugs: existing.slugs.slice() }
        : createEmptyDraft();
    } else {
      workingDraft = createEmptyDraft();
      if (Array.isArray(opts.prefillSlugs)) {
        workingDraft.slugs = opts.prefillSlugs
          .filter(s => typeof s === 'string' && s)
          .slice(0, MAX_PROJECTS_PER_COMPARISON);
      }
    }

    el.querySelector('#compareBuilderTitle').textContent =
      workingDraft.id ? 'Edit comparison' : 'New comparison';
    el.querySelector('.compare-name-input').value = workingDraft.name || '';
    el.querySelector('.compare-search-input').value = '';

    renderSlots();
    renderSearchResults('');
    refreshSaveButton();

    // Show the saved-comparisons list at the top when:
    //   - opening fresh (no editId, no prefill) AND
    //   - the user has at least one saved comparison
    // Otherwise jump straight into the builder.
    const openingFresh = !opts.editId && !Array.isArray(opts.prefillSlugs);
    if (openingFresh && savedComparisons.length) {
      renderSavedList();
    } else {
      el.querySelector('.compare-saved-section').setAttribute('hidden', '');
    }

    el.classList.add('open');
    document.body.style.overflow = 'hidden';
    // Focus name field for keyboard users
    setTimeout(() => el.querySelector('.compare-name-input').focus(), 50);
  }

  function closeBuilderModal() {
    if (!modalEl) return;
    modalEl.classList.remove('open');
    document.body.style.overflow = '';
  }

  function refreshSaveButton() {
    if (!modalEl) return;
    const btn = modalEl.querySelector('[data-action="save"]');
    const valid = (workingDraft.name || '').trim().length > 0 && workingDraft.slugs.length > 0;
    btn.disabled = !valid;
    btn.textContent = workingDraft.id ? 'Save changes' : 'Save comparison';
  }

  // ─── Slot list (selected projects) ────────────────────────────────────────
  function renderSlots() {
    if (!modalEl) return;
    const wrap = modalEl.querySelector('.compare-slots');
    const counter = modalEl.querySelector('.compare-slots-count');
    counter.textContent = `${workingDraft.slugs.length} / ${MAX_PROJECTS_PER_COMPARISON}`;

    if (!workingDraft.slugs.length) {
      wrap.innerHTML = `
        <div class="compare-slots-empty">
          Search below to add up to ${MAX_PROJECTS_PER_COMPARISON} projects.
        </div>
      `;
      return;
    }

    const features = window.allProjectFeatures || [];
    const bySlug = new Map();
    features.forEach(f => {
      const slug = window.projectSlugify(f.properties.title || '');
      bySlug.set(slug, f);
    });

    wrap.innerHTML = workingDraft.slugs.map((slug, i) => {
      const f = bySlug.get(slug);
      const title = f?.properties?.title || slug;
      const city  = f?.properties?.city  || '';
      const img   = f?.properties?.image || '';
      const safeTitle = escapeHtml(title);
      const safeCity  = escapeHtml(city);
      return `
        <div class="compare-slot" role="listitem" data-slug="${escapeAttr(slug)}">
          <div class="compare-slot-num">${i + 1}</div>
          ${img
            ? `<img class="compare-slot-thumb" src="${escapeAttr(img)}" alt="" loading="lazy" />`
            : `<div class="compare-slot-thumb compare-slot-thumb-empty"></div>`}
          <div class="compare-slot-meta">
            <div class="compare-slot-title">${safeTitle}</div>
            <div class="compare-slot-sub">${safeCity}</div>
          </div>
          <div class="compare-slot-actions">
            <button type="button" class="compare-slot-btn" data-move="up"  aria-label="Move up"   ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="compare-slot-btn" data-move="down" aria-label="Move down" ${i === workingDraft.slugs.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" class="compare-slot-btn compare-slot-btn-remove" data-remove="1" aria-label="Remove">&times;</button>
          </div>
        </div>
      `;
    }).join('');

    // Wire up per-slot actions
    wrap.querySelectorAll('.compare-slot').forEach(slotEl => {
      const slug = slotEl.dataset.slug;
      const idx = workingDraft.slugs.indexOf(slug);
      slotEl.querySelector('[data-remove]').addEventListener('click', () => {
        workingDraft.slugs.splice(idx, 1);
        renderSlots();
        renderSearchResults(modalEl.querySelector('.compare-search-input').value);
        refreshSaveButton();
      });
      const upBtn   = slotEl.querySelector('[data-move="up"]');
      const downBtn = slotEl.querySelector('[data-move="down"]');
      upBtn?.addEventListener('click', () => {
        if (idx <= 0) return;
        const tmp = workingDraft.slugs[idx - 1];
        workingDraft.slugs[idx - 1] = workingDraft.slugs[idx];
        workingDraft.slugs[idx] = tmp;
        renderSlots();
      });
      downBtn?.addEventListener('click', () => {
        if (idx >= workingDraft.slugs.length - 1) return;
        const tmp = workingDraft.slugs[idx + 1];
        workingDraft.slugs[idx + 1] = workingDraft.slugs[idx];
        workingDraft.slugs[idx] = tmp;
        renderSlots();
      });
    });
  }

  // ─── Search results (matches your existing diacritic-insensitive search) ──
  function normalizeForSearch(s) {
    return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  }

  function renderSearchResults(query) {
    if (!modalEl) return;
    const resultsEl = modalEl.querySelector('.compare-search-results');
    const features = window.allProjectFeatures || [];
    const ql = normalizeForSearch(query.trim());

    // Empty query → show first 8 projects (alphabetical) so the panel isn't blank
    let matches;
    if (!ql) {
      matches = features.slice().sort((a, b) =>
        (a.properties.title || '').localeCompare(b.properties.title || '')
      ).slice(0, 8);
    } else {
      matches = features.filter(f => {
        const t = normalizeForSearch(f.properties.title);
        const c = normalizeForSearch(f.properties.city);
        return t.includes(ql) || c.includes(ql);
      }).slice(0, 12);
    }

    const atCap = workingDraft.slugs.length >= MAX_PROJECTS_PER_COMPARISON;

    if (!matches.length) {
      resultsEl.innerHTML = `<div class="compare-search-empty">No matches.</div>`;
      return;
    }

    resultsEl.innerHTML = matches.map(f => {
      const title = f.properties.title || '';
      const city  = f.properties.city  || '';
      const slug  = window.projectSlugify(title);
      const isSelected = workingDraft.slugs.includes(slug);
      const disabled = isSelected || atCap;
      const buttonLabel = isSelected ? 'Added' : (atCap ? 'Full' : 'Add');
      return `
        <button type="button" class="compare-search-row${isSelected ? ' is-selected' : ''}"
                role="option" data-slug="${escapeAttr(slug)}" ${disabled ? 'disabled' : ''}>
          <div class="compare-search-row-meta">
            <div class="compare-search-row-title">${escapeHtml(title)}</div>
            <div class="compare-search-row-sub">${escapeHtml(city)}</div>
          </div>
          <span class="compare-search-row-cta">${buttonLabel}</span>
        </button>
      `;
    }).join('');

    resultsEl.querySelectorAll('.compare-search-row').forEach(row => {
      row.addEventListener('click', () => {
        const slug = row.dataset.slug;
        if (workingDraft.slugs.includes(slug)) return;
        if (workingDraft.slugs.length >= MAX_PROJECTS_PER_COMPARISON) return;
        workingDraft.slugs.push(slug);
        renderSlots();
        renderSearchResults(modalEl.querySelector('.compare-search-input').value);
        refreshSaveButton();
      });
    });
  }

  // ─── Save handler ─────────────────────────────────────────────────────────
  async function handleSave() {
    const btn = modalEl.querySelector('[data-action="save"]');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Saving…';

    let result;
    if (workingDraft.id) {
      result = await window.comparisons.update(workingDraft.id, {
        name: workingDraft.name,
        slugs: workingDraft.slugs
      });
    } else {
      result = await window.comparisons.create({
        name: workingDraft.name,
        slugs: workingDraft.slugs
      });
    }

    btn.disabled = false;
    btn.textContent = originalText;

    if (result.error) {
      const messages = {
        paywall: 'A paid plan is required.',
        name_required: 'Please enter a name.',
        no_projects: 'Add at least one project.',
        too_many: `You can compare up to ${MAX_PROJECTS_PER_COMPARISON} projects.`,
        save_failed: 'Could not save. Please try again.',
        not_found: 'That comparison could not be found.'
      };
      showToast(messages[result.error] || 'Save failed.');
      return;
    }

    showToast(workingDraft.id ? 'Comparison updated.' : 'Comparison saved.');
    closeBuilderModal();
    // Notify any list view that data changed
    document.dispatchEvent(new CustomEvent('comparisons:updated'));
  }

  // Listen for our own update event to refresh the saved-count badge in the
  // auth dropdown (rendered by index.html).
  document.addEventListener('comparisons:updated', () => {
    const badge = document.getElementById('compareCountBadge');
    if (!badge) return;
    const n = savedComparisons.length;
    badge.textContent = n;
    badge.style.display = n > 0 ? 'inline-block' : 'none';
  });

  // ─── Tiny toast ───────────────────────────────────────────────────────────
  let toastEl = null;
  let toastTimer = null;
  function showToast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'compare-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('open'), 2400);
  }

  // ─── HTML escapers ────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ─── Hook into existing auth flow ────────────────────────────────────────
  // index.html will call window.comparisons.hydrate() once auth resolves.
  // Listen for storage event in case auth state changes in another tab.
  window.addEventListener('storage', (e) => {
    if (e.key === 'mot_auth_hint') {
      if (e.newValue === 'paid' || e.newValue === 'free') {
        loadComparisonsFromMember();
      } else {
        savedComparisons = [];
      }
    }
  });

  // ─── Wire up the top-nav "Compare" link if present ────────────────────────
  // The link renders unconditionally in index.html; we gate the click here so
  // free/anonymous users see the existing paywall.
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const trigger = target.closest('[data-compare-open]');
    if (!trigger) return;
    e.preventDefault();
    if (!isPaidMember()) {
      if (typeof window.showSubscriptionPaywall === 'function') {
        window.showSubscriptionPaywall();
      } else if (typeof window.showSignupWall === 'function') {
        window.showSignupWall();
      }
      return;
    }
    // If trigger has data-compare-edit, open in edit mode
    const editId = trigger.dataset.compareEdit;
    openBuilderModal(editId ? { editId } : {});
  });
})();
