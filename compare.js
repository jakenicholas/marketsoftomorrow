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
          <!-- Saved comparisons gallery (visible when the user has any saved) -->
          <div class="compare-saved-section" hidden>
            <div class="compare-saved-header">
              <span class="compare-saved-label">Saved comparisons</span>
              <button type="button" class="compare-btn compare-btn-ghost compare-btn-sm" data-action="new">
                + New comparison
              </button>
            </div>
            <div class="compare-saved-grid"></div>
          </div>

          <!-- Builder (collapsible when saved comparisons exist) -->
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

    // "+ New comparison" button — clears the working draft and reveals the builder
    const newBtn = modalEl.querySelector('[data-action="new"]');
    newBtn.addEventListener('click', () => {
      workingDraft = createEmptyDraft();
      modalEl.querySelector('#compareBuilderTitle').textContent = 'New comparison';
      modalEl.querySelector('.compare-name-input').value = '';
      modalEl.querySelector('.compare-search-input').value = '';
      renderSlots();
      renderSearchResults('');
      refreshSaveButton();
      // Reveal the builder section. Keep the saved gallery visible above so the
      // user has context (and can cancel back to it without closing the modal).
      modalEl.querySelector('.compare-builder-section').removeAttribute('hidden');
      modalEl.querySelector('.compare-name-input').focus();
      // Scroll the builder into view since gallery may have pushed it down
      modalEl.querySelector('.compare-builder-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    return modalEl;
  }

  // Render the gallery of saved comparisons as tiles with a 2x2 image collage.
  // Only shown when opening the modal without a specific edit/prefill target.
  function renderSavedGrid() {
    if (!modalEl) return;
    const section = modalEl.querySelector('.compare-saved-section');
    const grid = modalEl.querySelector('.compare-saved-grid');
    if (!savedComparisons.length) {
      section.setAttribute('hidden', '');
      return;
    }
    section.removeAttribute('hidden');

    grid.innerHTML = savedComparisons.map(c => {
      const count = c.slugs.length;
      // Build 2x2 image collage from the first 4 projects
      const tileImages = c.slugs.slice(0, 4).map(slug => {
        const f = getFeatureForSlug(slug);
        return f?.properties?.image || '';
      });
      // Pad with empty strings to always have 4 cells
      while (tileImages.length < 4) tileImages.push('');
      const collage = `
        <div class="compare-tile-collage" aria-hidden="true">
          ${tileImages.map(src => src
            ? `<div class="compare-tile-cell"><img src="${escapeAttr(src)}" alt="" loading="lazy" /></div>`
            : `<div class="compare-tile-cell compare-tile-cell-empty"></div>`
          ).join('')}
        </div>
      `;
      return `
        <div class="compare-tile" data-saved-open="${escapeAttr(c.id)}" role="button" tabindex="0">
          ${collage}
          <div class="compare-tile-meta">
            <div class="compare-tile-name" title="${escapeAttr(c.name)}">${escapeHtml(c.name)}</div>
            <div class="compare-tile-sub">${count} project${count === 1 ? '' : 's'}</div>
          </div>
          <div class="compare-tile-actions">
            <button type="button" class="compare-tile-action" data-saved-edit="${escapeAttr(c.id)}" aria-label="Edit comparison">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button type="button" class="compare-tile-action compare-tile-action-danger" data-saved-remove="${escapeAttr(c.id)}" aria-label="Delete comparison">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Wire actions — open on tile click, edit/delete on action buttons (with stopPropagation)
    grid.querySelectorAll('[data-saved-open]').forEach(tile => {
      tile.addEventListener('click', (e) => {
        if (e.target.closest('[data-saved-edit], [data-saved-remove]')) return;
        const id = tile.dataset.savedOpen;
        closeBuilderModal();
        navigateToComparison(id);
      });
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const id = tile.dataset.savedOpen;
          closeBuilderModal();
          navigateToComparison(id);
        }
      });
    });
    grid.querySelectorAll('[data-saved-edit]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
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
        // Hide the saved gallery and show the builder
        modalEl.querySelector('.compare-saved-section').setAttribute('hidden', '');
        modalEl.querySelector('.compare-builder-section').removeAttribute('hidden');
        modalEl.querySelector('.compare-name-input').focus();
      });
    });
    grid.querySelectorAll('[data-saved-remove]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
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
        renderSavedGrid();
        // If they just deleted their last comparison, show the builder
        if (!savedComparisons.length) {
          modalEl.querySelector('.compare-builder-section').removeAttribute('hidden');
        }
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
      workingDraft.id ? 'Edit comparison' : (savedComparisons.length ? 'Comparisons' : 'New comparison');
    el.querySelector('.compare-name-input').value = workingDraft.name || '';
    el.querySelector('.compare-search-input').value = '';

    renderSlots();
    renderSearchResults('');
    refreshSaveButton();

    // Visibility logic:
    //   - Editing existing OR prefilling slugs → builder visible, gallery hidden
    //   - Opening fresh + has saved comparisons → gallery visible, builder hidden
    //     (user clicks "+ New comparison" to expand the builder)
    //   - Opening fresh + no saved comparisons → builder visible, gallery hidden
    const openingFresh = !opts.editId && !Array.isArray(opts.prefillSlugs);
    const savedSection = el.querySelector('.compare-saved-section');
    const builderSection = el.querySelector('.compare-builder-section');

    if (openingFresh && savedComparisons.length) {
      renderSavedGrid();
      builderSection.setAttribute('hidden', '');
    } else {
      savedSection.setAttribute('hidden', '');
      builderSection.removeAttribute('hidden');
    }

    el.classList.add('open');
    document.body.style.overflow = 'hidden';
    // Focus the most relevant field
    setTimeout(() => {
      const focusTarget = builderSection.hasAttribute('hidden')
        ? null  // viewing gallery — let user click a tile
        : el.querySelector('.compare-name-input');
      if (focusTarget) focusTarget.focus();
    }, 50);
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
    document.dispatchEvent(new CustomEvent('comparisons:updated'));
    // Open the comparison view immediately after save so the user sees their
    // creation rendered. Uses pushState so the URL reflects the active comparison.
    if (result.entry && result.entry.id) {
      navigateToComparison(result.entry.id);
    }
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

  // ─── Comparison view (map + cards) ─────────────────────────────────────
  // Full-screen overlay with a Mapbox map on top and horizontally scrolling
  // project cards below. Mounted on demand at /?compare=<id>, torn down when
  // the user closes — only one Mapbox instance is ever live at a time.
  let viewEl = null;
  let viewMap = null;       // mapboxgl.Map instance for the comparison view
  let viewMapMarkers = [];  // array of mapboxgl.Marker objects (parallel to slugs)
  let activeComparisonId = null;

  function ensureViewEl() {
    if (viewEl) return viewEl;
    viewEl = document.createElement('div');
    viewEl.id = 'compareView';
    viewEl.className = 'compare-view';
    viewEl.innerHTML = `
      <header class="compare-view-header">
        <button type="button" class="compare-view-back" aria-label="Close comparison">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          <span>Back to map</span>
        </button>
        <div class="compare-view-titles">
          <h1 class="compare-view-title"></h1>
          <div class="compare-view-sub"></div>
        </div>
        <div class="compare-view-actions">
          <button type="button" class="compare-view-action" data-view-action="edit" aria-label="Edit comparison">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          <button type="button" class="compare-view-action compare-view-action-primary" data-view-action="share" aria-label="Share comparison">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
            Share
          </button>
        </div>
      </header>
      <div class="compare-view-map" id="compareViewMap"></div>
      <div class="compare-view-cards-wrap">
        <div class="compare-view-cards" role="list"></div>
      </div>
    `;
    document.body.appendChild(viewEl);

    viewEl.querySelector('.compare-view-back').addEventListener('click', () => {
      closeComparisonView({ updateUrl: true });
    });
    viewEl.querySelector('[data-view-action="edit"]').addEventListener('click', () => {
      if (!activeComparisonId) return;
      openBuilderModal({ editId: activeComparisonId });
    });
    viewEl.querySelector('[data-view-action="share"]').addEventListener('click', handleShare);

    return viewEl;
  }

  function getFeatureForSlug(slug) {
    const features = window.allProjectFeatures || [];
    for (const f of features) {
      const s = window.projectSlugify(f.properties.title || '');
      if (s === slug) return f;
    }
    return null;
  }

  function statusFromDelivery(delivery) {
    const s = (delivery || '').toLowerCase();
    if (!s) return { label: 'Announced', color: '#888' };
    if (s.includes('open') || s.includes('now open')) return { label: 'Now Open', color: '#1FDF67' };
    if (s.includes('opening') || s.includes('opening soon')) return { label: 'Opening Soon', color: '#1FDF67' };
    if (s.includes('construction') || s.includes('topping')) return { label: 'Construction', color: '#FFD300' };
    if (s.includes('breaking ground') || s.includes('groundbreak')) return { label: 'Breaking Ground', color: '#FFD300' };
    return { label: 'Announced', color: '#888' };
  }

  function renderComparisonCards(comparison) {
    const wrap = viewEl.querySelector('.compare-view-cards');
    const features = comparison.slugs.map(getFeatureForSlug);

    wrap.innerHTML = features.map((f, i) => {
      if (!f) {
        return `
          <div class="compare-card compare-card-missing" role="listitem">
            <div class="compare-card-num">${i + 1}</div>
            <div class="compare-card-missing-meta">
              <strong>Project not found</strong>
              <span>This project may have been removed.</span>
            </div>
          </div>
        `;
      }
      const p = f.properties;
      const status = statusFromDelivery(p.delivery);
      // Expected completion: prefer DeliveryDate, fall back to Delivery, then to a year extract
      const completion = (p.deliveryDate || '').trim() || (p.delivery || '').trim();
      const dev = (p.developer || '').trim();
      const arc = (p.architect || '').trim();
      const type = (p.preferredType && p.preferredType.trim())
        ? p.preferredType.trim()
        : (p.projectType ? p.projectType.split(',')[0].trim() : '');
      const slug = window.projectSlugify(p.title || '');
      return `
        <article class="compare-card" role="listitem" data-slug="${escapeAttr(slug)}" data-card-idx="${i}">
          <div class="compare-card-img-wrap">
            ${p.image
              ? `<img class="compare-card-img" src="${escapeAttr(p.image)}" alt="" loading="lazy" />`
              : `<div class="compare-card-img compare-card-img-empty"></div>`}
            <div class="compare-card-num">${i + 1}</div>
          </div>
          <div class="compare-card-body">
            <div class="compare-card-title-row">
              <h3 class="compare-card-title">${escapeHtml(p.title || '')}</h3>
            </div>
            <div class="compare-card-city">${escapeHtml(p.city || '')}${type ? ` <span class="compare-card-type">• ${escapeHtml(type)}</span>` : ''}</div>
            <div class="compare-card-status-row">
              <span class="compare-card-status" style="background:${status.color}1f;color:${status.color}">
                ${status.label}
              </span>
            </div>
            ${dev ? `
              <div class="compare-card-spec">
                <div class="compare-card-spec-label">Developer</div>
                <div class="compare-card-spec-val" title="${escapeAttr(dev)}">${escapeHtml(dev)}</div>
              </div>` : ''}
            ${arc ? `
              <div class="compare-card-spec">
                <div class="compare-card-spec-label">Architect</div>
                <div class="compare-card-spec-val" title="${escapeAttr(arc)}">${escapeHtml(arc)}</div>
              </div>` : ''}
            ${completion ? `
              <div class="compare-card-spec">
                <div class="compare-card-spec-label">Expected Completion</div>
                <div class="compare-card-spec-val" title="${escapeAttr(completion)}">${escapeHtml(completion)}</div>
              </div>` : ''}
            <button type="button" class="compare-card-cta" data-open-project="${escapeAttr(slug)}">View project</button>
          </div>
        </article>
      `;
    }).join('');

    wrap.querySelectorAll('[data-open-project]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const slug = btn.dataset.openProject;
        const f = getFeatureForSlug(slug);
        if (!f || typeof window.openProjectModal !== 'function') return;
        // Close the comparison overlay so the user lands back on the map with
        // the project modal showing on top — "bring them back to the map".
        closeComparisonView({ updateUrl: true });
        // Defer one frame so the overlay's removal doesn't fight the modal animation
        requestAnimationFrame(() => window.openProjectModal(f, 'compare-view'));
      });
    });

    wrap.querySelectorAll('.compare-card[data-card-idx]').forEach(card => {
      const idx = parseInt(card.dataset.cardIdx, 10);
      card.addEventListener('mouseenter', () => highlightMarker(idx, true));
      card.addEventListener('mouseleave', () => highlightMarker(idx, false));
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-open-project]')) return;
        flyToMarker(idx);
      });
    });
  }

  function buildMarkerEl(num, isHighlighted) {
    const el = document.createElement('div');
    el.className = 'compare-pin' + (isHighlighted ? ' highlighted' : '');
    el.innerHTML = `<span class="compare-pin-num">${num}</span>`;
    return el;
  }

  function mountComparisonMap(comparison) {
    if (!window.mapboxgl) {
      console.warn('[Compare] mapboxgl not available');
      return;
    }
    if (viewMap) {
      viewMapMarkers.forEach(m => m.remove());
      viewMapMarkers = [];
      try { viewMap.remove(); } catch (e) { /* ignore */ }
      viewMap = null;
    }

    const features = comparison.slugs.map(getFeatureForSlug).filter(Boolean);
    if (!features.length) return;

    viewMap = new mapboxgl.Map({
      container: 'compareViewMap',
      style: 'mapbox://styles/floridaoftomorrow/clkbk4qlw000a01qw94rj0xa7',
      center: [features[0].geometry.coordinates[0], features[0].geometry.coordinates[1]],
      zoom: 9,
      attributionControl: false,
      cooperativeGestures: false
    });
    viewMap.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

    viewMap.on('load', () => {
      comparison.slugs.forEach((slug, i) => {
        const f = getFeatureForSlug(slug);
        if (!f) return;
        const el = buildMarkerEl(i + 1, false);
        el.addEventListener('click', () => {
          const card = viewEl.querySelector(`.compare-card[data-card-idx="${i}"]`);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            card.classList.add('is-flashed');
            setTimeout(() => card.classList.remove('is-flashed'), 800);
          }
        });
        const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
          .setLngLat(f.geometry.coordinates)
          .addTo(viewMap);
        viewMapMarkers.push(marker);
      });

      if (features.length === 1) {
        viewMap.flyTo({ center: features[0].geometry.coordinates, zoom: 13, duration: 0 });
      } else {
        const bounds = new mapboxgl.LngLatBounds();
        features.forEach(f => bounds.extend(f.geometry.coordinates));
        viewMap.fitBounds(bounds, { padding: 80, duration: 0, maxZoom: 14 });
      }
    });
  }

  function highlightMarker(idx, isOn) {
    const marker = viewMapMarkers[idx];
    if (!marker) return;
    const el = marker.getElement();
    el.classList.toggle('highlighted', !!isOn);
  }

  function flyToMarker(idx) {
    const marker = viewMapMarkers[idx];
    if (!marker || !viewMap) return;
    viewMap.flyTo({ center: marker.getLngLat(), zoom: 14, duration: 800 });
    highlightMarker(idx, true);
    setTimeout(() => highlightMarker(idx, false), 1600);
  }

  function navigateToComparison(id) {
    const url = new URL(window.location.href);
    url.searchParams.set('compare', id);
    url.searchParams.delete('project');
    url.searchParams.delete('view');
    url.searchParams.delete('city');
    history.pushState({ compare: id }, '', url.toString());
    openComparisonView(id);
  }

  function openComparisonView(id) {
    if (!isSignedIn()) {
      if (typeof window.showSignupWall === 'function') window.showSignupWall();
      return;
    }
    const comparison = savedComparisons.find(c => c.id === id);
    if (!comparison) {
      showToast("That comparison isn't in your account.");
      const url = new URL(window.location.href);
      url.searchParams.delete('compare');
      history.replaceState({}, '', url.toString());
      return;
    }

    activeComparisonId = id;
    const el = ensureViewEl();
    el.querySelector('.compare-view-title').textContent = comparison.name;
    const projectCount = comparison.slugs.length;
    el.querySelector('.compare-view-sub').textContent =
      `${projectCount} project${projectCount === 1 ? '' : 's'}`;

    el.classList.add('open');
    document.body.classList.add('compare-view-active');

    renderComparisonCards(comparison);
    requestAnimationFrame(() => mountComparisonMap(comparison));
  }

  function closeComparisonView(opts) {
    opts = opts || {};
    if (!viewEl) return;
    viewEl.classList.remove('open');
    document.body.classList.remove('compare-view-active');
    activeComparisonId = null;

    if (viewMap) {
      viewMapMarkers.forEach(m => m.remove());
      viewMapMarkers = [];
      try { viewMap.remove(); } catch (e) { /* already removed */ }
      viewMap = null;
    }

    if (opts.updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.delete('compare');
      history.pushState({}, '', url.toString());
    }
  }

  async function handleShare() {
    if (!activeComparisonId) return;
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('compare', activeComparisonId);
    const shareUrl = url.toString();
    const comparison = savedComparisons.find(c => c.id === activeComparisonId);
    const shareName = comparison ? comparison.name : 'Comparison';

    if (navigator.share) {
      try { await navigator.share({ title: shareName, url: shareUrl }); return; }
      catch (e) { /* user dismissed */ }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(shareUrl); showToast('Link copied to clipboard.'); return; }
      catch (e) { /* fall through */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = shareUrl; ta.setAttribute('readonly', '');
      ta.style.position = 'absolute'; ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Link copied to clipboard.');
    } catch (e) {
      showToast('Could not copy link.');
    }
  }

  // Public API additions
  window.comparisons.open = navigateToComparison;
  window.comparisons.close = (opts) => closeComparisonView(opts || {});

  // ─── URL routing ───────────────────────────────────────────────────────────
  // On load, check for ?compare=<id>. We can't open it until comparisons have
  // hydrated from Memberstack — so we wrap hydrate() to chain into the routing.
  let hydrationDone = false;
  const originalHydrate = window.comparisons.hydrate;
  window.comparisons.hydrate = async function () {
    await originalHydrate();
    hydrationDone = true;
    document.dispatchEvent(new CustomEvent('comparisons:hydrated'));
    maybeRouteToComparisonFromUrl();
  };

  function maybeRouteToComparisonFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('compare');
    if (!id) return;
    if (!isSignedIn()) {
      // Anonymous viewer — fire signup wall. After signup, refreshMemberStatus
      // will run hydrate again, which routes them in.
      if (typeof window.showSignupWall === 'function') window.showSignupWall();
      return;
    }
    openComparisonView(id);
  }

  // Browser back/forward navigation
  window.addEventListener('popstate', () => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('compare');
    if (id && hydrationDone) {
      openComparisonView(id);
    } else {
      closeComparisonView({ updateUrl: false });
    }
  });

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
