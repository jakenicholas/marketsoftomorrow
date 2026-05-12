/**
 * Markets of Tomorrow -- Comparisons feature (Commit 1: builder + storage)
 * --------------------------------------------------------------------
 * PRO-only feature. Lets paid members:
 *   1. Search the project list and select up to 6 projects
 *   2. Name and save a comparison view (persisted to Memberstack JSON)
 *   3. Manage saved comparisons (rename, delete)
 *
 * Commit 2 (next) will add the actual comparison render -- a map + cards
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

  // --- Constants ------------------------------------------------------------
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

  // --- Read the live paid-member state (avoids stale closures) --------------
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

  // --- ID generation (short, URL-safe) --------------------------------------
  function generateId() {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) {
      id += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return id;
  }

  // --- Memberstack JSON storage ---------------------------------------------
  async function loadComparisonsFromMember() {
    if (!window.$memberstackDom) return [];
    try {
      const result = await window.$memberstackDom.getMemberJSON();
      const json = result?.data || {};
      const arr = Array.isArray(json[STORAGE_KEY]) ? json[STORAGE_KEY] : [];
      // Defensive validation -- drop malformed entries rather than crash later
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

  // --- Public CRUD API (used by builder UI + future comparison view) --------
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

    // Used by index.html's auth flow -- call after refreshMemberStatus resolves
    async hydrate() {
      if (isSignedIn()) await loadComparisonsFromMember();
    },

    // Reset state on logout
    clear() {
      savedComparisons = [];
      workingDraft = createEmptyDraft();
    },

    // For the modal -- open with a fresh draft, or pre-populate with given slugs
    openBuilder(opts) {
      openBuilderModal(opts || {});
    }
  };

  // --- Builder modal UI -----------------------------------------------------
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
              <input type="text" class="compare-search-input" placeholder="Search projects to add..." />
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

    // Close handlers -- backdrop click, X button, Cancel button
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

    // "+ New comparison" button -- clears the working draft and reveals the builder
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

    // Wire actions -- open on tile click, edit/delete on action buttons (with stopPropagation)
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
      // Mirror existing paywall behavior -- for free signed-in users, show the
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
    //   - Editing existing OR prefilling slugs   builder visible, gallery hidden
    //   - Opening fresh + has saved comparisons   gallery visible, builder hidden
    //     (user clicks "+ New comparison" to expand the builder)
    //   - Opening fresh + no saved comparisons   builder visible, gallery hidden
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
        ? null  // viewing gallery -- let user click a tile
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

  // --- Slot list (selected projects) ----------------------------------------
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
            <button type="button" class="compare-slot-btn" data-move="up"  aria-label="Move up"   ${i === 0 ? 'disabled' : ''}> </button>
            <button type="button" class="compare-slot-btn" data-move="down" aria-label="Move down" ${i === workingDraft.slugs.length - 1 ? 'disabled' : ''}> </button>
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

  // --- Search results (matches your existing diacritic-insensitive search) --
  function normalizeForSearch(s) {
    return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  }

  function renderSearchResults(query) {
    if (!modalEl) return;
    const resultsEl = modalEl.querySelector('.compare-search-results');
    const features = window.allProjectFeatures || [];
    const ql = normalizeForSearch(query.trim());

    // Empty query   show first 8 projects (alphabetical) so the panel isn't blank
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
      const img   = f.properties.image || '';
      const slug  = window.projectSlugify(title);
      const isSelected = workingDraft.slugs.includes(slug);
      const disabled = isSelected || atCap;
      const buttonLabel = isSelected ? 'Added' : (atCap ? 'Full' : 'Add');
      return `
        <button type="button" class="compare-search-row${isSelected ? ' is-selected' : ''}"
                role="option" data-slug="${escapeAttr(slug)}" ${disabled ? 'disabled' : ''}>
          ${img
            ? `<img class="compare-search-row-thumb" src="${escapeAttr(img)}" alt="" loading="lazy" />`
            : `<div class="compare-search-row-thumb compare-search-row-thumb-empty"></div>`}
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

  // --- Save handler ---------------------------------------------------------
  async function handleSave() {
    const btn = modalEl.querySelector('[data-action="save"]');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Saving...';

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

  // --- Tiny toast -----------------------------------------------------------
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

  // --- HTML escapers --------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // --- Comparison view: Sheet (default) + Map (full-map) modes ----------------
  //
  // Two modes, sharing one container:
  //   SHEET mode — editorial spec-grid layout: sticky attribute labels on the
  //     left, project columns scrolling horizontally to the right. Reads like a
  //     market table from a magazine. Optimized for an agent sending it to a
  //     client (curator attribution, branded footer, print-friendly).
  //   MAP mode  — full-screen Mapbox map with numbered pins for each project.
  //     Geographic context only. Click a pin to scroll back to Sheet at that
  //     project's column.
  //
  // The redesign replaces the previous stack/deck + side-by-side modes. The
  // back-card click conflict, mode toggle icon race, two parallel render
  // functions, and most pagination plumbing are gone.
  let viewEl = null;
  let viewMap = null;       // mapboxgl.Map instance for MAP mode
  let viewMapMarkers = [];  // mapboxgl.Marker objects, parallel to slugs
  let activeComparisonId = null;
  // 'sheet' | 'map' -- sheet is the default; users toggle via the top-right
  // button. Mode persists in sessionStorage so a hard-refresh on the same
  // comparison restores it, but defaults to sheet on a NEW comparison open.
  let viewMode = 'sheet';

  function ensureViewEl() {
    if (viewEl) return viewEl;
    viewEl = document.createElement('div');
    viewEl.id = 'compareView';
    viewEl.className = 'compare-view';
    viewEl.dataset.mode = viewMode;
    viewEl.innerHTML = `
      <!-- HEADER: agent attribution + actions. Same on both modes. -->
      <header class="cv-header">
        <button type="button" class="cv-back" aria-label="Close comparison" data-cv-action="close">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        </button>
        <div class="cv-titles">
          <div class="cv-eyebrow"><span class="cv-eyebrow-dot"></span><span class="cv-eyebrow-text">Comparison</span></div>
          <h1 class="cv-title"></h1>
          <div class="cv-byline">
            <span class="cv-byline-avatar"></span>
            <span class="cv-byline-text">Curated by <strong class="cv-byline-name"></strong></span>
            <span class="cv-byline-sep"></span>
            <span class="cv-byline-updated"></span>
          </div>
        </div>
        <div class="cv-actions">
          <!-- Mode toggle: icon swaps between sheet (rows) and map (pin) -->
          <button type="button" class="cv-action-btn cv-action-icon" data-cv-action="toggle-mode" aria-label="Toggle view mode" title="Toggle view mode">
            <svg class="cv-icon-map" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21 3 6"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>
            <svg class="cv-icon-sheet" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
          </button>
          <button type="button" class="cv-action-btn cv-action-icon" data-cv-action="edit" aria-label="Edit comparison" title="Edit">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <!-- Share is the primary CTA -- bright accent, agent-focused -->
          <div class="cv-share-wrap">
            <button type="button" class="cv-action-btn cv-action-primary" data-cv-action="share" aria-haspopup="menu" aria-expanded="false">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
              <span class="cv-action-label">Share with client</span>
            </button>
            <!-- Share menu: two items live (Copy link + Send via email).
                 PDF was previously a third item that triggered window.print(),
                 but the resulting print was unusable -- removed pending a real
                 server-side Puppeteer render. -->
            <div class="cv-share-menu" role="menu" hidden>
              <button type="button" class="cv-share-item" data-cv-share="link" role="menuitem">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                <span>Copy link</span>
              </button>
              <button type="button" class="cv-share-item" data-cv-share="email" role="menuitem">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                <span>Send via email</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <!-- BODY: holds either the sheet OR the map, depending on viewMode. -->
      <div class="cv-body">
        <!-- SHEET MODE -->
        <div class="cv-sheet-scroll" data-cv-pane="sheet">
          <div class="cv-sheet-grid"></div>
        </div>
        <!-- MAP MODE -->
        <div class="cv-map-pane" data-cv-pane="map" hidden>
          <div class="cv-map-container" id="compareViewMap"></div>
          <!-- Map-mode legend: numbered list of pins so users can match
               pin number  to project name without leaving the map. -->
          <div class="cv-map-legend"></div>
        </div>
      </div>

      <!-- FOOTER: brand mark + link back to main site -->
      <footer class="cv-footer">
        <div class="cv-footer-brand">
          <img class="cv-footer-logo" src="https://static.wixstatic.com/shapes/ca3b83_a647b53cad4c49c5b012af991d286a86.svg" alt="Markets of Tomorrow" />
        </div>
        <a class="cv-footer-link" href="/" target="_blank" rel="noopener">View full map at oftmw.com →</a>
      </footer>
    `;
    document.body.appendChild(viewEl);

    // Delegated click handler for everything inside the view. Single attach
    // means re-rendering content doesn't lose handlers.
    viewEl.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;

      // Close share menu when clicking outside it
      const shareMenu = viewEl.querySelector('.cv-share-menu');
      const shareWrap = viewEl.querySelector('.cv-share-wrap');
      if (shareMenu && !shareWrap.contains(target)) {
        shareMenu.setAttribute('hidden', '');
        const shareBtn = viewEl.querySelector('[data-cv-action="share"]');
        if (shareBtn) shareBtn.setAttribute('aria-expanded', 'false');
      }

      // Action buttons (close, toggle-mode, edit, share)
      const actionEl = target.closest('[data-cv-action]');
      if (actionEl) {
        const action = actionEl.dataset.cvAction;
        if (action === 'close') {
          closeComparisonView({ updateUrl: true });
        } else if (action === 'toggle-mode') {
          toggleViewMode();
        } else if (action === 'edit') {
          if (activeComparisonId) openBuilderModal({ editId: activeComparisonId });
        } else if (action === 'share') {
          toggleShareMenu();
        }
        return;
      }

      // Share menu items (placeholder wiring -- Copy works, others toast)
      const shareItem = target.closest('[data-cv-share]');
      if (shareItem) {
        handleShareAction(shareItem.dataset.cvShare);
        return;
      }

      // (View project buttons are now real <a target="_blank"> anchors --
      // no JS handler needed; the browser handles them natively.)

      // Map legend item: clicking jumps map to that pin
      const legendItem = target.closest('[data-cv-pin]');
      if (legendItem) {
        const i = parseInt(legendItem.dataset.cvPin, 10);
        if (!Number.isNaN(i)) flyToMarker(i);
        return;
      }
    });

    // Keyboard: Escape closes
    document.addEventListener('keydown', (e) => {
      if (!viewEl || !viewEl.classList.contains('open')) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') closeComparisonView({ updateUrl: true });
    });

    return viewEl;
  }

  // --- Shared helpers (used by both Sheet and Map modes) ----------------------

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
    if (!s) return { label: 'Announced', cls: 'announced' };
    if (s.includes('now open')) return { label: 'Now Open', cls: 'open' };
    if (s.includes('opening')) return { label: 'Opening Soon', cls: 'open' };
    if (s.includes('construction') || s.includes('topping')) return { label: 'Construction', cls: 'construction' };
    if (s.includes('breaking ground') || s.includes('groundbreak')) return { label: 'Breaking Ground', cls: 'construction' };
    return { label: 'Announced', cls: 'announced' };
  }

  // Construction completion %. Mirrors the values used by the project modal's
  // pm-progress so the same status reads the same number everywhere.
  function progressFromDelivery(delivery) {
    const s = (delivery || '').toLowerCase();
    if (s.includes('now open')) return 100;
    if (s.includes('opening')) return 90;
    if (s.includes('topping')) return 80;
    if (s.includes('construction')) return 60;
    if (s.includes('breaking ground') || s.includes('groundbreak')) return 30;
    return 10;
  }

  // Pull the curator's display name from Memberstack, falling back gracefully
  // through customFields -> email -> "Anonymous Curator". Initials drive the
  // avatar circle. This is the key piece of agent attribution -- when an
  // agent shares the comparison, the client sees a real person's name on it.
  function getCuratorAttribution() {
    const m = (window._memberstackMember && window._memberstackMember.data) || null;
    let name = '';
    if (m && m.customFields) {
      const f = (m.customFields['first-name'] || m.customFields.firstName || '').trim();
      const l = (m.customFields['last-name'] || m.customFields.lastName || '').trim();
      if (f || l) name = (f + ' ' + l).trim();
    }
    if (!name && m && m.auth && m.auth.email) {
      // Fall back to the email username (before the @). Better than blank.
      name = m.auth.email.split('@')[0];
    }
    if (!name) name = (window._memberDisplayName || '').trim();
    if (!name) name = 'Anonymous Curator';
    const parts = name.split(/\s+/).slice(0, 2);
    const initials = parts.map(p => (p[0] || '').toUpperCase()).join('') || '?';
    return { name, initials };
  }

  // Format a timestamp like "May 11, 2026". Used for the "Updated" line.
  function formatUpdated(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_) { return ''; }
  }

  // --- SHEET MODE -------------------------------------------------------------
  // Build the editorial spec-grid. Each row is an attribute (Name, Location,
  // Status, Timeline, Developer, etc); each column is a project. Sticky left
  // label column. Rows where every project's value is empty are hidden.

  // Attribute rows. Each entry has a key for the data, a label for the row
  // header, and a renderer that returns HTML for one cell. Renderers receive
  // the feature properties (p) for the project in that column.
  function getSheetRows() {
    return [
      // Hero image is special -- rendered as a 200px-tall image cell
      {
        key: 'hero', label: 'Project', kind: 'hero',
        render: (p, i) => {
          const img = (p.image || '').trim();
          return `
            <div class="cv-hero">
              ${img
                ? `<div class="cv-hero-img" style="background-image:url('${escapeAttr(img)}')"></div>`
                : `<div class="cv-hero-img cv-hero-img-empty"></div>`}
              <div class="cv-hero-overlay"></div>
              <div class="cv-hero-num">${i + 1}</div>
              <div class="cv-hero-label">${escapeHtml(p.title || '')}</div>
            </div>
          `;
        },
        // Hero row is always shown
        hasValue: () => true,
      },
      {
        key: 'title', label: 'Name',
        render: (p) => `<div class="cv-project-title">${escapeHtml(p.title || '')}</div>`,
        hasValue: (p) => !!(p.title && p.title.trim()),
      },
      {
        key: 'city', label: 'Location',
        render: (p) => {
          const city = (p.city || '').trim();
          return city ? `<span class="cv-cell-val">${escapeHtml(city)}</span>` : '<span class="cv-cell-val cv-cell-empty">--</span>';
        },
        hasValue: (p) => !!(p.city && p.city.trim()),
      },
      {
        key: 'status', label: 'Status',
        render: (p) => {
          const s = statusFromDelivery(p.delivery);
          return `<span class="cv-status-pill cv-status-${s.cls}">${escapeHtml(s.label)}</span>`;
        },
        hasValue: () => true,
      },
      {
        key: 'timeline', label: 'Timeline',
        render: (p) => {
          // Date-driven progress: window.computeProgress returns the overall
          // pct, label, AND a per-segment array. Each of the 5 stages has
          // a proportional width (10/10/60/10/10) and fills independently
          // -- so the Construction block (60% wide) shows finer granularity
          // for projects mid-construction than the old single-bar layout.
          const cp = (typeof window.computeProgress === 'function')
            ? window.computeProgress(p.deliveryDate, p.delivery, p.startDate)
            : null;
          const segments = (cp && cp.segments) ? cp.segments : null;
          const label = cp ? cp.label : statusFromDelivery(p.delivery).label;
          const subtitle = (cp && cp.subtitle) || (p.deliveryDate || '').trim() || (p.delivery || '').trim() || '--';

          // Render either the segmented bar (date-driven) or a fallback
          // single bar (legacy path -- only if computeProgress missing).
          let barHtml;
          if (segments) {
            barHtml = `
              <div class="cv-segments">
                ${segments.map(seg => {
                  const c = seg.state === 'future' ? 'rgba(255,255,255,0.08)' : seg.color;
                  return `<div class="cv-seg cv-seg-${seg.state}" style="flex:${seg.widthPct} 0 0;--seg-c:${c};"><div class="cv-seg-fill" style="width:${seg.fillPct}%"></div></div>`;
                }).join('')}
              </div>`;
          } else {
            // Legacy bar (kept for the no-computeProgress fallback)
            const pct = (cp && cp.pct) || progressFromDelivery(p.delivery);
            const fillCls = pct >= 100 ? 'cv-progress-fill cv-progress-fill-done' : 'cv-progress-fill';
            barHtml = `<div class="cv-progress-bar"><div class="${fillCls}" style="width:${pct}%"></div></div>`;
          }

          return `
            <div class="cv-progress">
              ${barHtml}
              <div class="cv-progress-meta">
                <strong>${escapeHtml(label)}</strong>
                <span>${escapeHtml(subtitle)}</span>
              </div>
            </div>
          `;
        },
        hasValue: () => true,
      },
      {
        key: 'developer', label: 'Developer',
        render: (p) => {
          const v = (p.developer || '').trim();
          return v ? `<span class="cv-cell-val" title="${escapeAttr(v)}">${escapeHtml(v)}</span>` : '<span class="cv-cell-val cv-cell-empty">--</span>';
        },
        hasValue: (p) => !!(p.developer && p.developer.trim()),
      },
      {
        key: 'architect', label: 'Architect',
        render: (p) => {
          const v = (p.architect || '').trim();
          return v ? `<span class="cv-cell-val" title="${escapeAttr(v)}">${escapeHtml(v)}</span>` : '<span class="cv-cell-val cv-cell-empty">--</span>';
        },
        hasValue: (p) => !!(p.architect && p.architect.trim()),
      },
      {
        key: 'type', label: 'Type',
        render: (p) => {
          const t = (p.preferredType && p.preferredType.trim())
            ? p.preferredType.trim()
            : (p.projectType ? p.projectType.split(',')[0].trim() : '');
          return t ? `<span class="cv-cell-val">${escapeHtml(t)}</span>` : '<span class="cv-cell-val cv-cell-empty">--</span>';
        },
        hasValue: (p) => {
          const t = (p.preferredType && p.preferredType.trim()) || (p.projectType ? p.projectType.split(',')[0].trim() : '');
          return !!t;
        },
      },
      {
        key: 'units', label: 'Units',
        render: (p) => {
          const v = (p.units || '').trim();
          return v ? `<span class="cv-cell-val">${escapeHtml(v)}</span>` : '<span class="cv-cell-val cv-cell-empty">--</span>';
        },
        hasValue: (p) => !!(p.units && p.units.trim()),
      },
      {
        key: 'height', label: 'Height',
        render: (p) => {
          const v = (p.height || '').trim();
          return v ? `<span class="cv-cell-val">${escapeHtml(v)}</span>` : '<span class="cv-cell-val cv-cell-empty">--</span>';
        },
        hasValue: (p) => !!(p.height && p.height.trim()),
      },
      {
        key: 'pricing', label: 'Pricing',
        render: (p) => {
          const v = (p.pricing || p.priceRange || '').trim();
          return v ? `<span class="cv-cell-val">${escapeHtml(v)}</span>` : '<span class="cv-cell-val cv-cell-empty">Pricing TBA</span>';
        },
        hasValue: (p) => !!((p.pricing || p.priceRange || '').trim()),
      },
      // CTA row -- always shown. Renders as an <a> opening the project's
      // static landing page in a new tab. Simpler than opening the project
      // modal on top of comparison view (cleaner share UX too -- the client
      // who opens a shared comparison can click into any project as its
      // own page).
      {
        key: 'cta', label: '', kind: 'cta',
        render: (p) => {
          const slug = window.projectSlugify(p.title || '');
          return `
            <a class="cv-view-btn" href="/projects/${escapeAttr(slug)}/" target="_blank" rel="noopener">
              View project
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/><polyline points="17 5 19 5 19 7" style="display:none"/></svg>
            </a>
          `;
        },
        hasValue: () => true,
      },
    ];
  }

  function renderSheet(comparison) {
    if (!viewEl) return;
    const grid = viewEl.querySelector('.cv-sheet-grid');
    const features = comparison.slugs.map(getFeatureForSlug);
    const total = features.length;
    if (!total) {
      grid.innerHTML = '<div class="cv-empty">No projects in this comparison yet.</div>';
      grid.style.setProperty('--cv-col-count', '0');
      return;
    }
    grid.style.setProperty('--cv-col-count', String(total));

    // Build only the rows that have at least one non-empty value across projects.
    // Hero, status, timeline, and CTA always render. Optional rows (units,
    // height, pricing, etc.) auto-hide when every project is blank -- so the
    // sheet looks intentional rather than cluttered with placeholders.
    const rows = getSheetRows().filter(row => {
      // Always-show rows
      if (row.kind === 'hero' || row.kind === 'cta' || row.key === 'status' || row.key === 'timeline' || row.key === 'title' || row.key === 'city') return true;
      // Otherwise: at least one feature must have data for the row
      return features.some(f => f && row.hasValue(f.properties));
    });

    grid.innerHTML = rows.map((row, rowIdx) => {
      const rowCls = `cv-row cv-row-${row.key}` + (row.kind ? ` cv-row-${row.kind}` : '');
      // Label cell (sticky left column)
      const labelCell = `<div class="cv-label-cell ${rowCls}" data-row="${row.key}">${escapeHtml(row.label)}</div>`;
      // Project cells
      const projectCells = features.map((f, i) => {
        const isLast = i === total - 1;
        const cls = `cv-cell ${rowCls}${isLast ? ' cv-cell-last' : ''}`;
        if (!f) {
          // Missing project: render a sad placeholder cell
          return `<div class="${cls}"><span class="cv-cell-val cv-cell-empty">Project removed</span></div>`;
        }
        return `<div class="${cls}" data-col="${i}">${row.render(f.properties, i)}</div>`;
      }).join('');
      return labelCell + projectCells;
    }).join('');
  }

  // --- MAP MODE ---------------------------------------------------------------
  // Full-pane Mapbox map. Numbered pins. Legend at the bottom-left lets the
  // user click a project name to fly to that pin. Replaces the old drawer +
  // map split, which was the source of most stacking/sizing bugs.

  function buildMarkerEl(num) {
    const el = document.createElement('div');
    el.className = 'cv-map-pin';
    // The inner element carries the visual styling + any transform-based
    // animations. The outer element is owned exclusively by Mapbox for
    // positioning (it sets translate(...) every frame).
    el.innerHTML = `<div class="cv-map-pin-inner"><span>${num}</span></div>`;
    return el;
  }

  function mountComparisonMap(comparison) {
    if (!window.mapboxgl) return;
    if (viewMap) {
      viewMapMarkers.forEach(m => m.remove());
      viewMapMarkers = [];
      try { viewMap.remove(); } catch (_) {}
      viewMap = null;
    }
    const features = comparison.slugs.map(getFeatureForSlug).filter(Boolean);
    if (!features.length) return;

    const container = document.getElementById('compareViewMap');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) {
      // Container not laid out yet -- try next frame
      requestAnimationFrame(() => mountComparisonMap(comparison));
      return;
    }

    viewMap = new mapboxgl.Map({
      container: 'compareViewMap',
      style: 'mapbox://styles/floridaoftomorrow/clkbk4qlw000a01qw94rj0xa7',
      center: features[0].geometry.coordinates,
      zoom: 11,
      attributionControl: false,
    });
    viewMap.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

    viewMap.on('load', () => {
      try { viewMap.resize(); } catch (_) {}
      comparison.slugs.forEach((slug, i) => {
        const f = getFeatureForSlug(slug);
        if (!f) return;
        const el = buildMarkerEl(i + 1);
        el.addEventListener('click', () => {
          // Open the project's static landing page in a new tab. Matches
          // the View project CTA in sheet mode -- a client browsing a
          // shared comparison gets a clean per-project page either way.
          window.open(`/projects/${encodeURIComponent(slug)}/`, '_blank', 'noopener');
        });
        const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
          .setLngLat(f.geometry.coordinates)
          .addTo(viewMap);
        viewMapMarkers.push(marker);
      });

      // Fit bounds to show every pin. Simple symmetric padding -- no drawer
      // to dodge anymore, so the math is uncomplicated.
      if (features.length === 1) {
        viewMap.flyTo({ center: features[0].geometry.coordinates, zoom: 13, duration: 0 });
      } else {
        const bounds = new mapboxgl.LngLatBounds();
        features.forEach(f => bounds.extend(f.geometry.coordinates));
        viewMap.fitBounds(bounds, { padding: 80, duration: 0, maxZoom: 12 });
      }
    });

    // Resize on container size changes
    if (window.ResizeObserver && !container._cvResize) {
      const ro = new ResizeObserver(() => {
        if (viewMap) { try { viewMap.resize(); } catch (_) {} }
      });
      ro.observe(container);
      container._cvResize = ro;
    }
  }

  function renderMapLegend(comparison) {
    if (!viewEl) return;
    const legend = viewEl.querySelector('.cv-map-legend');
    if (!legend) return;
    const features = comparison.slugs.map(getFeatureForSlug);
    legend.innerHTML = `
      <div class="cv-map-legend-title">Projects</div>
      <ul class="cv-map-legend-list">
        ${features.map((f, i) => {
          const title = f ? (f.properties.title || '') : 'Project removed';
          const city = f ? (f.properties.city || '') : '';
          return `
            <li class="cv-map-legend-item" data-cv-pin="${i}" tabindex="0">
              <span class="cv-map-legend-num">${i + 1}</span>
              <span class="cv-map-legend-text">
                <strong>${escapeHtml(title)}</strong>
                ${city ? `<span>${escapeHtml(city)}</span>` : ''}
              </span>
            </li>
          `;
        }).join('')}
      </ul>
    `;
  }

  function flyToMarker(idx) {
    const marker = viewMapMarkers[idx];
    if (!marker || !viewMap) return;
    viewMap.flyTo({
      center: marker.getLngLat(),
      zoom: 14,
      duration: 800,
      essential: true,
    });
    // Brief highlight pulse
    const el = marker.getElement();
    el.classList.add('cv-map-pin-pulse');
    setTimeout(() => el.classList.remove('cv-map-pin-pulse'), 1500);
  }

  // --- Mode switching ---------------------------------------------------------

  function toggleViewMode() {
    if (!viewEl) return;
    const comparison = savedComparisons.find(c => c.id === activeComparisonId);
    if (!comparison) return;
    viewMode = viewMode === 'sheet' ? 'map' : 'sheet';
    viewEl.dataset.mode = viewMode;
    try { sessionStorage.setItem('cv:mode', viewMode); } catch (_) {}

    const sheetPane = viewEl.querySelector('[data-cv-pane="sheet"]');
    const mapPane = viewEl.querySelector('[data-cv-pane="map"]');
    if (viewMode === 'sheet') {
      sheetPane.removeAttribute('hidden');
      mapPane.setAttribute('hidden', '');
    } else {
      sheetPane.setAttribute('hidden', '');
      mapPane.removeAttribute('hidden');
      // Mount map after pane is visible (so the container has dimensions)
      renderMapLegend(comparison);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => mountComparisonMap(comparison));
      });
    }
  }

  // --- Share menu -------------------------------------------------------------
  // Three actions, only the first is wired up. The other two surface a toast
  // ("Coming soon") so the affordance is in place for design lock-in before
  // we build the real email + PDF pipelines.

  function toggleShareMenu() {
    if (!viewEl) return;
    const menu = viewEl.querySelector('.cv-share-menu');
    const btn = viewEl.querySelector('[data-cv-action="share"]');
    if (!menu || !btn) return;
    const isOpen = !menu.hasAttribute('hidden');
    if (isOpen) {
      menu.setAttribute('hidden', '');
      btn.setAttribute('aria-expanded', 'false');
    } else {
      menu.removeAttribute('hidden');
      btn.setAttribute('aria-expanded', 'true');
    }
  }

  async function handleShareAction(kind) {
    if (!activeComparisonId) return;
    const menu = viewEl.querySelector('.cv-share-menu');
    if (menu) menu.setAttribute('hidden', '');
    const btn = viewEl.querySelector('[data-cv-action="share"]');
    if (btn) btn.setAttribute('aria-expanded', 'false');

    // Build a self-contained share URL: the slug list + title + curator
    // name are all encoded in the URL itself. The recipient doesn't need
    // a Memberstack account or backend lookup -- their browser loads the
    // map app, sees ?compare=share, and renders the comparison sheet
    // against the live CSV. Recipient sees exactly the same project data
    // the curator does.
    const comparison = savedComparisons.find(c => c.id === activeComparisonId);
    if (!comparison) {
      // Defensive: if active id doesn't resolve (e.g. user opened a shared
      // link themselves and clicked Share), bail with a toast.
      showToast("Couldn't build a share link.");
      return;
    }
    const shareUrl = buildSharedUrlForComparison(comparison);

    if (kind === 'link') {
      // Native share sheet first (mobile), clipboard fallback
      if (navigator.share) {
        try { await navigator.share({ url: shareUrl }); return; } catch (_) {}
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(shareUrl); showToast('Link copied to clipboard.'); return; }
        catch (_) {}
      }
      // Last-resort textarea copy
      try {
        const ta = document.createElement('textarea');
        ta.value = shareUrl; ta.setAttribute('readonly', '');
        ta.style.position = 'absolute'; ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select(); document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Link copied to clipboard.');
      } catch (_) { showToast('Could not copy link.'); }
      return;
    }

    if (kind === 'email') {
      // Open the user's email client with a templated message + the
      // shareable URL. Real "send via email" will use a templated email
      // service later; this gives agents a workable surface now.
      const name = comparison.name || 'Comparison';
      const subject = encodeURIComponent(`${name} — Markets of Tomorrow`);
      const body = encodeURIComponent(
        `Hi,\n\nI put together a comparison of projects I thought you'd find interesting. You can view it here:\n\n${shareUrl}\n\nBest,\n`
      );
      window.location.href = `mailto:?subject=${subject}&body=${body}`;
      return;
    }

    // (PDF removed -- will be re-added when server-side Puppeteer render exists)
  }

  // --- Map nav + URL routing --------------------------------------------------

  function navigateToComparison(id) {
    const url = new URL(window.location.href);
    url.searchParams.set('compare', id);
    url.searchParams.delete('project');
    url.searchParams.delete('view');
    history.pushState({}, '', url.toString());
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
    renderComparisonView(comparison);
  }

  // Open a comparison passed by value (as opposed to looked up by ID).
  // Used by the shared-link path -- the recipient doesn't have to be
  // signed in, and the comparison object is built from URL params, not
  // from Memberstack. Hides the Edit button (recipient isn't the curator).
  function openSharedComparisonView(comparison) {
    activeComparisonId = comparison.id; // 'shared'
    renderComparisonView(comparison, { isShared: true });
  }

  // Render the comparison view. Source-agnostic -- works for both personal
  // (savedComparisons lookup) and shared (URL-derived ephemeral object).
  function renderComparisonView(comparison, opts) {
    opts = opts || {};
    const isShared = !!opts.isShared || !!comparison.isShared;

    // Always default to sheet mode when opening a comparison. Map mode is
    // one tap away via the toggle. "Sheet first" optimizes for agents who
    // want to read/share spec data, not browse a map.
    viewMode = 'sheet';

    const el = ensureViewEl();
    el.dataset.mode = viewMode;
    // Surface "this is a shared view" as a body-level state so CSS can hide
    // the Edit button (only the curator should be able to edit). The Share
    // button is also hidden because re-sharing a shared URL would duplicate
    // the link rather than build a fresh one from the underlying
    // comparison record.
    el.classList.toggle('cv-shared', isShared);

    // Header content -- title, eyebrow count, curator attribution
    const count = comparison.slugs.length;
    el.querySelector('.cv-title').textContent = comparison.name || 'Untitled comparison';
    el.querySelector('.cv-eyebrow-text').textContent =
      `Comparison · ${count} project${count === 1 ? '' : 's'}`;

    // Curator name: for shared views, comes from the URL "by" param. For
    // personal views, comes from the viewer's own Memberstack profile (the
    // viewer IS the curator). Fall back gracefully if neither is available.
    let curatorName, curatorInitials;
    if (isShared && comparison.curator) {
      curatorName = comparison.curator;
      const parts = curatorName.split(/\s+/).slice(0, 2);
      curatorInitials = parts.map(p => (p[0] || '').toUpperCase()).join('') || '?';
    } else {
      const c = getCuratorAttribution();
      curatorName = c.name;
      curatorInitials = c.initials;
    }
    el.querySelector('.cv-byline-name').textContent = curatorName;
    el.querySelector('.cv-byline-avatar').textContent = curatorInitials;

    const updatedIso = comparison.updated_at || comparison.created_at || '';
    const updatedStr = formatUpdated(updatedIso);
    const updatedEl = el.querySelector('.cv-byline-updated');
    const sepEl = el.querySelector('.cv-byline-sep');
    if (updatedStr) {
      updatedEl.textContent = `Updated ${updatedStr}`;
      sepEl.style.display = '';
    } else {
      updatedEl.textContent = '';
      sepEl.style.display = 'none';
    }

    // Show sheet pane, hide map pane
    el.querySelector('[data-cv-pane="sheet"]').removeAttribute('hidden');
    el.querySelector('[data-cv-pane="map"]').setAttribute('hidden', '');

    renderSheet(comparison);

    el.classList.add('open');
    document.body.classList.add('compare-view-active');
  }

  function closeComparisonView(opts) {
    opts = opts || {};
    if (!viewEl) return;
    viewEl.classList.remove('open');
    document.body.classList.remove('compare-view-active');
    document.body.classList.remove('compare-modal-open');
    activeComparisonId = null;
    viewMode = 'sheet'; // reset for next open

    if (viewMap) {
      viewMapMarkers.forEach(m => m.remove());
      viewMapMarkers = [];
      try { viewMap.remove(); } catch (_) {}
      viewMap = null;
    }

    if (opts.updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.delete('compare');
      // Also strip the shared-link params so a recipient closing their
      // view lands on a clean map URL, not ?slugs=...&title=...
      url.searchParams.delete('slugs');
      url.searchParams.delete('title');
      url.searchParams.delete('by');
      history.pushState({}, '', url.toString());
    }
  }

  // Refresh the active view when a comparison is edited from inside it.
  // The builder modal dispatches 'comparisons:updated' on save -- listen
  // for it and re-render so the new project set appears immediately.
  // Skips entirely when viewing a SHARED comparison (the activeComparisonId
  // is 'shared'; there's nothing in savedComparisons to look up, and the
  // viewer is the recipient anyway, not the curator).
  document.addEventListener('comparisons:updated', () => {
    if (!activeComparisonId || !viewEl || !viewEl.classList.contains('open')) return;
    if (activeComparisonId === 'shared') return;
    const comparison = savedComparisons.find(c => c.id === activeComparisonId);
    if (!comparison) {
      closeComparisonView({ updateUrl: true });
      return;
    }
    // Update header titles in case the name changed
    const count = comparison.slugs.length;
    viewEl.querySelector('.cv-title').textContent = comparison.name || 'Untitled comparison';
    viewEl.querySelector('.cv-eyebrow-text').textContent =
      `Comparison · ${count} project${count === 1 ? '' : 's'}`;
    if (viewMode === 'sheet') {
      renderSheet(comparison);
    } else {
      renderMapLegend(comparison);
      mountComparisonMap(comparison);
    }
  });

  // Public API additions
  window.comparisons.open = navigateToComparison;
  window.comparisons.close = (opts) => closeComparisonView(opts || {});

  // --- URL routing -----------------------------------------------------------
  // Two routing modes:
  //   ?compare=<id>          - personal: looks up the comparison in the
  //                            viewer's own savedComparisons. Used when the
  //                            creator opens their own comparison or returns
  //                            to one they previously navigated to.
  //   ?compare=share         - shared: parses slug list + title + curator
  //     &slugs=a,b,c           from the URL itself. Recipient does NOT need
  //     &title=...             to be signed in. This is the agent-shares-
  //     &by=...                with-client flow. No backend needed -- the
  //                            URL carries the whole payload. Long URLs but
  //                            functional. Can be replaced with a real
  //                            server-side store later without breaking the
  //                            ?compare=share contract.
  let hydrationDone = false;
  const originalHydrate = window.comparisons.hydrate;
  window.comparisons.hydrate = async function () {
    await originalHydrate();
    hydrationDone = true;
    document.dispatchEvent(new CustomEvent('comparisons:hydrated'));
    // For private comparisons (?compare=<id>), routing must wait for
    // Memberstack data so we can look up the comparison. Shared comparisons
    // don't need this -- they're handled by the bootstrap below which runs
    // immediately on script load.
    const params = new URLSearchParams(window.location.search);
    if (params.get('compare') && params.get('compare') !== 'share') {
      maybeRouteToComparisonFromUrl();
    }
  };

  // Bootstrap: if the page loads with a SHARED link, kick off routing
  // immediately. Doesn't wait for hydrate (which requires auth -- the
  // recipient might not be signed in, and shouldn't have to be).
  // Routing itself defers further until window.allProjectFeatures is
  // populated, via the projects:loaded event listener inside.
  (function bootstrapSharedRoute() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('compare') === 'share') {
      maybeRouteToComparisonFromUrl();
    }
  })();

  // Build an ephemeral comparison object from URL params. Returns null if
  // the params don't describe a valid shared comparison.
  function parseSharedComparisonFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('compare') !== 'share') return null;
    const rawSlugs = params.get('slugs') || '';
    const slugs = rawSlugs.split(',').map(s => s.trim()).filter(Boolean);
    if (!slugs.length) return null;
    return {
      id: 'shared',
      name: params.get('title') || 'Shared comparison',
      slugs,
      // curator name from URL takes priority over the viewer's own identity
      // (because the recipient isn't the curator); this is what powers the
      // "Curated by [agent name]" byline on the recipient's view.
      curator: params.get('by') || '',
      // No timestamps in the URL -- treat as undated. The byline simply
      // hides the "Updated" segment when there's no date.
      created_at: '',
      updated_at: '',
      isShared: true,
    };
  }

  // Build a shareable URL from a saved comparison. URL-encodes everything
  // so it survives email clients and messengers without breaking.
  function buildSharedUrlForComparison(comparison) {
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('compare', 'share');
    url.searchParams.set('slugs', comparison.slugs.join(','));
    if (comparison.name) url.searchParams.set('title', comparison.name);
    const curator = getCuratorAttribution();
    if (curator.name && curator.name !== 'Anonymous Curator') {
      url.searchParams.set('by', curator.name);
    }
    return url.toString();
  }

  function maybeRouteToComparisonFromUrl() {
    // Shared link path -- check FIRST, before signup-wall logic, because
    // shared comparisons are public and shouldn't trigger a paywall on the
    // recipient. The creator's account is the only one that needs Pro;
    // viewing a shared link doesn't.
    const shared = parseSharedComparisonFromUrl();
    if (shared) {
      // Features may not be loaded yet (CSV is async). Defer if so.
      if (!window.allProjectFeatures || !window.allProjectFeatures.length) {
        const onReady = () => {
          document.removeEventListener('projects:loaded', onReady);
          openSharedComparisonView(shared);
        };
        document.addEventListener('projects:loaded', onReady);
      } else {
        openSharedComparisonView(shared);
      }
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const id = params.get('compare');
    if (!id) return;
    if (!isSignedIn()) {
      // Anonymous viewer trying to open a private comparison ID -- fire
      // signup wall. After signup, refreshMemberStatus will run hydrate
      // again, which routes them in.
      if (typeof window.showSignupWall === 'function') window.showSignupWall();
      return;
    }
    openComparisonView(id);
  }

  // Browser back/forward navigation
  window.addEventListener('popstate', () => {
    // Shared-link path takes priority -- doesn't require hydration since
    // the comparison data lives in the URL itself.
    const shared = parseSharedComparisonFromUrl();
    if (shared) {
      openSharedComparisonView(shared);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const id = params.get('compare');
    if (id && hydrationDone) {
      openComparisonView(id);
    } else {
      closeComparisonView({ updateUrl: false });
    }
  });

  // --- Hook into existing auth flow ----------------------------------------
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

  // --- Wire up the top-nav "Compare" link if present ------------------------
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
