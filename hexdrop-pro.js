'use strict';

// ============================================================================
// HexDrop Pro features
// ----------------------------------------------------------------------------
// Pro tier ($4.99 lifetime via ExtensionPay) unlocks:
//   - Themes: 4 alternate color schemes
//   - Bookmarks: save offsets in files (keyed by SHA-1 hash of file content)
//
// This file wires:
//   1. ExtPay check on viewer load
//   2. Themes UI (selector dropdown + CSS variable swap via data-theme attr)
//   3. Bookmarks UI (bookmark current selection + bookmarks panel)
//   4. Upgrade button when not paid
//
// All Pro features are GATED — calls to ExtPay.getUser() determine access.
// Free tier sees the buttons (so they know Pro exists) but clicking opens
// the payment page instead of the feature.
// ============================================================================

const extpay = ExtPay('hexdrop');

// ── Theme definitions ────────────────────────────────────────────────────────
// Each theme is a name + CSS variable overrides applied via [data-theme="..."]
// in style.css. The default 'amber' theme uses the existing CSS variables.
const THEMES = [
  { id: 'amber',     name: 'Amber Phosphor',  isDefault: true,  isFree: true  },
  { id: 'matrix',    name: 'Matrix Green',    isDefault: false, isFree: false },
  { id: 'cyberpunk', name: 'Cyberpunk Pink',  isDefault: false, isFree: false },
  { id: 'ocean',     name: 'Ocean Blue',      isDefault: false, isFree: false },
  { id: 'sunset',    name: 'Sunset Orange',   isDefault: false, isFree: false },
];

// ── State ────────────────────────────────────────────────────────────────────
let isPaid = false;
let currentFileHash = null;  // SHA-1 of currently loaded file (set by hexdrop.js when file loads)

// ── On load: check Pro status ────────────────────────────────────────────────
extpay.getUser().then(user => {
  isPaid = !!user.paid;
  initProUI();
  applyStoredTheme();
}).catch(err => {
  // Network error or ExtensionPay unreachable — degrade gracefully to free
  console.warn('[HexDrop Pro] ExtPay check failed, defaulting to free:', err);
  isPaid = false;
  initProUI();
  applyStoredTheme();
});

// ── UI: inject Pro button + bookmarks panel into viewer toolbar ─────────────
function initProUI() {
  injectProButton();
  injectBookmarksUI();

  // Listen for changes to paid status (user might purchase mid-session)
  extpay.onPaid.addListener(user => {
    isPaid = true;
    updateProButtonLabel();
    refreshBookmarksPanel();
  });
}

function injectProButton() {
  const toolbar = document.querySelector('.toolbar-right');
  if (!toolbar) return;

  // Themes dropdown wrapper
  const wrap = document.createElement('div');
  wrap.className = 'pro-wrap';
  wrap.innerHTML = `
    <button id="proBtn" class="help-btn" title="${isPaid ? 'HexDrop Pro is active' : 'Unlock Pro features for $4.99'}">
      ${isPaid ? '★' : '⬢ Pro'}
    </button>
    <div class="pro-menu" id="proMenu">
      <div class="pro-menu-section">
        <div class="pro-menu-title">${isPaid ? 'THEMES' : 'THEMES (PRO)'}</div>
        ${THEMES.map(t => `
          <button class="pro-theme-btn" data-theme="${t.id}">
            ${t.name}${t.isDefault ? ' (default)' : ''}${!t.isFree && !isPaid ? ' 🔒' : ''}
          </button>
        `).join('')}
      </div>
      ${isPaid ? '' : `
        <div class="pro-menu-section pro-upgrade-section">
          <div class="pro-menu-title">UPGRADE TO PRO</div>
          <button id="upgradeProBtn" class="pro-upgrade-btn">Unlock all features — $4.99</button>
          <div class="pro-menu-hint">Themes · Bookmarks · One-time payment · Lifetime</div>
        </div>
      `}
    </div>
  `;
  // Insert before the help button if it exists, else append
  const helpBtn = document.getElementById('helpBtn');
  if (helpBtn) {
    toolbar.insertBefore(wrap, helpBtn);
  } else {
    toolbar.appendChild(wrap);
  }

  // Wire button toggles
  const proBtn = document.getElementById('proBtn');
  const proMenu = document.getElementById('proMenu');
  proBtn.addEventListener('click', () => {
    proMenu.classList.toggle('open');
  });
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) proMenu.classList.remove('open');
  });

  // Wire theme buttons
  wrap.querySelectorAll('.pro-theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const themeId = btn.dataset.theme;
      const theme = THEMES.find(t => t.id === themeId);
      if (!theme.isFree && !isPaid) {
        // Free user clicked locked theme — open upgrade page
        extpay.openPaymentPage('hexdrop-pro');
        return;
      }
      applyTheme(themeId);
      saveTheme(themeId);
      proMenu.classList.remove('open');
    });
  });

  // Wire upgrade button
  const upBtn = document.getElementById('upgradeProBtn');
  if (upBtn) {
    upBtn.addEventListener('click', () => extpay.openPaymentPage('hexdrop-pro'));
  }
}

function updateProButtonLabel() {
  const btn = document.getElementById('proBtn');
  if (btn) {
    btn.innerHTML = isPaid ? '★' : '⬢ Pro';
    btn.title = isPaid ? 'HexDrop Pro is active' : 'Unlock Pro features for $4.99';
  }
}

// ── Themes ──────────────────────────────────────────────────────────────────
function applyTheme(themeId) {
  document.documentElement.setAttribute('data-theme', themeId);
}

function saveTheme(themeId) {
  chrome.storage.local.set({ hexdrop_theme: themeId });
}

function applyStoredTheme() {
  chrome.storage.local.get('hexdrop_theme', data => {
    if (data.hexdrop_theme) {
      const theme = THEMES.find(t => t.id === data.hexdrop_theme);
      // Validate user is still entitled to this theme (e.g. they downgraded)
      if (theme && (theme.isFree || isPaid)) {
        applyTheme(data.hexdrop_theme);
      }
    }
  });
}

// ── Bookmarks ───────────────────────────────────────────────────────────────
// Stored in chrome.storage.local under key `hexdrop_bookmarks_<sha1hash>`.
// Each entry: { offset: int, note: string, createdAt: ISO string }
//
// Privacy: only the SHA-1 hash of the file is stored — never the file content
// or filename. This means if the user opens the same file again, their
// bookmarks load. If the file changes by even one byte, hash differs and
// bookmarks won't match — by design, prevents stale bookmarks against
// modified files.

function injectBookmarksUI() {
  const statusbar = document.getElementById('statusbar');
  if (!statusbar) return;

  // Bookmark button (appears in status bar when a byte is selected)
  const bookmarkBtn = document.createElement('button');
  bookmarkBtn.id = 'bookmarkBtn';
  bookmarkBtn.style.display = 'none';
  bookmarkBtn.textContent = '⚑ Bookmark';
  bookmarkBtn.title = isPaid ? 'Save this offset as a bookmark' : 'Bookmark — Pro feature';
  bookmarkBtn.addEventListener('click', () => {
    if (!isPaid) { extpay.openPaymentPage('hexdrop-pro'); return; }
    promptAndSaveBookmark();
  });

  // Bookmarks list button
  const listBtn = document.createElement('button');
  listBtn.id = 'bookmarksListBtn';
  listBtn.textContent = '⚑ Bookmarks';
  listBtn.title = isPaid ? 'Show bookmarks for this file' : 'Bookmarks — Pro feature';
  listBtn.addEventListener('click', () => {
    if (!isPaid) { extpay.openPaymentPage('hexdrop-pro'); return; }
    toggleBookmarksPanel();
  });

  // Insert near the existing copy buttons
  const copyHexBtn = document.getElementById('copyHexBtn');
  if (copyHexBtn) {
    statusbar.insertBefore(bookmarkBtn, copyHexBtn);
  } else {
    statusbar.appendChild(bookmarkBtn);
  }
  statusbar.appendChild(listBtn);

  // Bookmarks panel (hidden by default)
  const panel = document.createElement('div');
  panel.id = 'bookmarksPanel';
  panel.innerHTML = `
    <div class="bookmarks-header">
      <span class="bookmarks-title">BOOKMARKS</span>
      <button id="bookmarksPanelClose" title="Close">✕</button>
    </div>
    <div class="bookmarks-body" id="bookmarksList">
      <div class="bookmarks-empty">No bookmarks for this file yet. Select a byte and click ⚑ Bookmark to save one.</div>
    </div>
  `;
  document.body.appendChild(panel);
  document.getElementById('bookmarksPanelClose').addEventListener('click', () => {
    panel.classList.remove('open');
  });
}

// Public API used by hexdrop.js when a byte is selected/deselected
window.hexdropProShowBookmarkBtn = function(show) {
  const btn = document.getElementById('bookmarkBtn');
  if (btn) btn.style.display = (show && isPaid) ? '' : 'none';
};

// Public API used by hexdrop.js when a file is loaded
// Called as: window.hexdropProSetFile(fileBytes)
window.hexdropProSetFile = async function(bytes) {
  if (!isPaid || !bytes) {
    currentFileHash = null;
    refreshBookmarksPanel();
    return;
  }
  try {
    const buf = await crypto.subtle.digest('SHA-1', bytes);
    const hashArr = Array.from(new Uint8Array(buf));
    currentFileHash = hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
    refreshBookmarksPanel();
  } catch (err) {
    console.warn('[HexDrop Pro] hash failed:', err);
    currentFileHash = null;
  }
};

// Save bookmark — called from button click. Reads selection from window state.
function promptAndSaveBookmark() {
  if (!currentFileHash) {
    alert('No file loaded.');
    return;
  }
  // Read the currently-selected offset from the global hexdrop.js state.
  // hexdrop.js exposes `selectedStart` (a const at module scope). We can't
  // access it directly from here, but the offset is also visible in the
  // status bar at #offsetInfo as text "Offset: 0x3C (60)".
  const offsetEl = document.getElementById('offsetInfo');
  const txt = offsetEl ? offsetEl.textContent : '';
  const m = txt.match(/\((\d+)\)/);
  if (!m) {
    alert('Select a byte first.');
    return;
  }
  const offset = parseInt(m[1], 10);
  const note = prompt('Note for this bookmark (optional):', '') || '';
  saveBookmark(offset, note);
}

function saveBookmark(offset, note) {
  if (!currentFileHash) return;
  const key = `hexdrop_bookmarks_${currentFileHash}`;
  chrome.storage.local.get(key, data => {
    const list = data[key] || [];
    list.push({ offset, note, createdAt: new Date().toISOString() });
    chrome.storage.local.set({ [key]: list }, () => {
      refreshBookmarksPanel();
    });
  });
}

function deleteBookmark(index) {
  if (!currentFileHash) return;
  const key = `hexdrop_bookmarks_${currentFileHash}`;
  chrome.storage.local.get(key, data => {
    const list = data[key] || [];
    list.splice(index, 1);
    chrome.storage.local.set({ [key]: list }, () => {
      refreshBookmarksPanel();
    });
  });
}

function toggleBookmarksPanel() {
  const panel = document.getElementById('bookmarksPanel');
  if (panel) panel.classList.toggle('open');
  refreshBookmarksPanel();
}

function refreshBookmarksPanel() {
  const list = document.getElementById('bookmarksList');
  if (!list) return;
  if (!isPaid) {
    list.innerHTML = '<div class="bookmarks-empty">Bookmarks unlock with HexDrop Pro ($4.99).</div>';
    return;
  }
  if (!currentFileHash) {
    list.innerHTML = '<div class="bookmarks-empty">Open a file to see its bookmarks.</div>';
    return;
  }
  const key = `hexdrop_bookmarks_${currentFileHash}`;
  chrome.storage.local.get(key, data => {
    const items = data[key] || [];
    if (items.length === 0) {
      list.innerHTML = '<div class="bookmarks-empty">No bookmarks for this file yet. Select a byte and click ⚑ Bookmark to save one.</div>';
      return;
    }
    list.innerHTML = items.map((b, i) => `
      <div class="bookmark-row">
        <button class="bookmark-jump" data-offset="${b.offset}" title="Jump to this offset">
          0x${b.offset.toString(16).toUpperCase().padStart(8, '0')}
          <span class="bookmark-dec">(${b.offset})</span>
        </button>
        <span class="bookmark-note">${escapeHtml(b.note) || '<em>no note</em>'}</span>
        <button class="bookmark-del" data-index="${i}" title="Delete bookmark">✕</button>
      </div>
    `).join('');

    // Wire jump buttons — set the jump input + click jump
    list.querySelectorAll('.bookmark-jump').forEach(btn => {
      btn.addEventListener('click', () => {
        const offset = parseInt(btn.dataset.offset, 10);
        const jumpInput = document.getElementById('jumpInput');
        const jumpBtn = document.getElementById('jumpBtn');
        const jumpMode = document.getElementById('jumpMode');
        if (jumpInput && jumpBtn) {
          // Force HEX mode and paste
          if (jumpMode && jumpMode.textContent === 'DEC') jumpMode.click();
          jumpInput.value = offset.toString(16).toUpperCase();
          jumpBtn.click();
        }
      });
    });

    // Wire delete buttons
    list.querySelectorAll('.bookmark-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.dataset.index, 10);
        deleteBookmark(index);
      });
    });
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
