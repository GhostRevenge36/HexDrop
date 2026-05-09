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
  { id: 'custom',    name: 'Custom… 🎨',      isDefault: false, isFree: false, isCustom: true },
];

// ── State ────────────────────────────────────────────────────────────────────
let isPaid = false;
let currentFileHash = null;     // SHA-1 of currently loaded file (set by hexdrop.js when file loads)
let currentFileBytes = null;    // Reference to fileBytes Uint8Array (for hash calculator)
let currentSelection = { start: -1, end: -1 };  // Current byte selection range, or {-1,-1} for none

// ── On load: check Pro status ────────────────────────────────────────────────
extpay.getUser().then(user => {
  isPaid = !!user.paid;
  applyProStateAttribute();
  initProUI();
  applyStoredTheme();
  if (!isPaid) startPaidStatePolling();
}).catch(err => {
  // Network error or ExtensionPay unreachable — degrade gracefully to free
  console.warn('[HexDrop Pro] ExtPay check failed, defaulting to free:', err);
  isPaid = false;
  applyProStateAttribute();
  initProUI();
  applyStoredTheme();
  startPaidStatePolling();
});

// Set <html data-pro="active|free"> so CSS can swap badges in the Quick
// Reference panel and anywhere else that needs to react to Pro state.
function applyProStateAttribute() {
  document.documentElement.setAttribute('data-pro', isPaid ? 'active' : 'free');
}

// ── UI: inject Pro button + bookmarks panel into viewer toolbar ─────────────
function initProUI() {
  injectProButton();
  injectBookmarksUI();
  injectHashUI();
  injectAnnotationsUI();
  injectDiffUI();
  injectValueDecoderUI();
  injectStructuresUI();

  // ExtPay's onPaid listener only fires in the context where its background
  // poll runs (background.js). It does NOT fire in extension pages like the
  // viewer. We register it anyway as a belt-and-suspenders, but the real
  // mechanism is the chrome.storage.onChanged watcher below — which fires on
  // the viewer the moment the background writes the updated paid state.
  extpay.onPaid.addListener(() => transitionToPaid());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.extensionpay_user) return;
    const newVal = changes.extensionpay_user.newValue;
    const oldVal = changes.extensionpay_user.oldValue;
    const newPaid = !!(newVal && newVal.paidAt);
    const oldPaid = !!(oldVal && oldVal.paidAt);
    if (newPaid && !oldPaid) {
      transitionToPaid();
    } else if (!newPaid && oldPaid) {
      transitionToFree();  // user reset their license / chargeback / dev reset
    }
  });
}

// Atomically transition the entire UI to the Pro / unlocked state. Idempotent —
// safe to call multiple times. Shows the toast only on a true transition.
function transitionToPaid() {
  const wasJustUpgraded = !isPaid;
  isPaid = true;
  applyProStateAttribute();
  updateProButtonLabel();
  rebuildProMenu();
  refreshAllProTooltips();
  refreshBookmarksPanel();
  refreshHashPanel();
  refreshAnnotationsPanel();
  repaintAnnotations();
  updateAnnotateBtnVisibility();
  stopPaidStatePolling();  // No need to poll once paid
  if (wasJustUpgraded) showProUnlockedToast();
}

// ── Paid-state failsafes ────────────────────────────────────────────────────
// The chrome.storage.onChanged listener catches the normal happy path (background
// confirms purchase → writes storage → viewer reacts). These are belt-and-
// suspenders backups so a customer is NEVER left looking at locked UI after
// a successful purchase, no matter what timing or messaging quirk occurs.

let paidCheckInterval = null;
let paidCheckBusy = false;

function refreshPaidStateIfNeeded() {
  if (isPaid || paidCheckBusy) return;
  paidCheckBusy = true;
  extpay.getUser().then(user => {
    if (user.paid && !isPaid) transitionToPaid();
  }).catch(() => {
    // Silent fail — network blip, ExtPay down, etc. Next poll will retry.
  }).finally(() => {
    paidCheckBusy = false;
  });
}

function startPaidStatePolling() {
  if (paidCheckInterval) return;
  // Every 15s while not paid. Stops automatically once isPaid flips to true.
  // Cost: ~4 ExtensionPay API calls per minute while a free user is in the
  // viewer; zero calls once paid.
  paidCheckInterval = setInterval(refreshPaidStateIfNeeded, 15000);
}

function stopPaidStatePolling() {
  if (paidCheckInterval) {
    clearInterval(paidCheckInterval);
    paidCheckInterval = null;
  }
}

// Re-check the moment the user returns to the viewer tab — they almost
// certainly just came back from completing the purchase on extensionpay.com.
window.addEventListener('focus', () => refreshPaidStateIfNeeded());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshPaidStateIfNeeded();
});

// Reverse transition — used if dev resets license in test mode, or a real
// user's subscription/license is revoked. Repaint everything to free state.
function transitionToFree() {
  if (!isPaid) return;
  isPaid = false;
  applyProStateAttribute();
  updateProButtonLabel();
  rebuildProMenu();
  refreshAllProTooltips();
  refreshBookmarksPanel();
  refreshHashPanel();
  refreshAnnotationsPanel();
  cachedAnnotations = [];
  repaintAnnotations();
  updateAnnotateBtnVisibility();
  // Reset to default (Amber) theme since paid themes are no longer valid
  applyTheme('amber');
}

// Build the inner HTML of the Pro menu dropdown. Called both at init and
// after a mid-session purchase to refresh the locked/unlocked state.
// Visible label for the Pro toolbar button. Kept consistent width across
// states so the toolbar layout doesn't shift.
function proButtonLabel() {
  return isPaid ? '★ Pro' : '⬢ Pro';
}

function buildProMenuHTML() {
  return `
    <div class="pro-menu-section">
      <div class="pro-menu-title">${isPaid ? 'THEMES' : 'THEMES (PRO)'}</div>
      ${THEMES.map(t => `
        <button class="pro-theme-btn" data-theme="${t.id}">
          ${t.name}${t.isDefault ? ' (default)' : ''}${!t.isFree && !isPaid ? ' 🔒' : ''}
        </button>
      `).join('')}
    </div>
    ${isPaid ? `
      <div class="pro-menu-section pro-active-section">
        <div class="pro-menu-title">PRO IS ACTIVE ★</div>
        <div class="pro-menu-hint">All themes, bookmarks, hashes, annotations, diff mode, and pattern wildcards are unlocked.</div>
      </div>
    ` : `
      <div class="pro-menu-section pro-upgrade-section">
        <div class="pro-menu-title">UPGRADE TO PRO</div>
        <button id="upgradeProBtn" class="pro-upgrade-btn">Unlock all features — $4.99</button>
        <div class="pro-menu-hint">Themes · Bookmarks · Hashes · Annotations · Diff mode · Wildcards · One-time payment · Lifetime</div>
      </div>
    `}
  `;
}

// Wire event handlers on theme buttons and the upgrade button. Idempotent —
// safe to call after rebuilding the menu HTML.
function wireProMenuButtons(wrap, proMenu) {
  wrap.querySelectorAll('.pro-theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const themeId = btn.dataset.theme;
      const theme = THEMES.find(t => t.id === themeId);
      if (!theme.isFree && !isPaid) {
        extpay.openPaymentPage('hexdrop-pro');
        return;
      }
      if (theme.isCustom) {
        proMenu.classList.remove('open');
        openCustomThemeModal();
        return;
      }
      applyTheme(themeId);
      saveTheme(themeId);
      proMenu.classList.remove('open');
    });
  });
  const upBtn = wrap.querySelector('#upgradeProBtn');
  if (upBtn) {
    upBtn.addEventListener('click', () => extpay.openPaymentPage('hexdrop-pro'));
  }
}

function injectProButton() {
  const toolbar = document.querySelector('.toolbar-right');
  if (!toolbar) return;

  const wrap = document.createElement('div');
  wrap.className = 'pro-wrap';
  wrap.innerHTML = `
    <button id="proBtn" class="pro-toolbar-btn" title="${isPaid ? 'HexDrop Pro is active' : 'Unlock Pro features for $4.99'}">
      ${proButtonLabel()}
    </button>
    <div class="pro-menu" id="proMenu">${buildProMenuHTML()}</div>
  `;
  const helpBtn = document.getElementById('helpBtn');
  if (helpBtn) toolbar.insertBefore(wrap, helpBtn);
  else toolbar.appendChild(wrap);

  const proBtn = document.getElementById('proBtn');
  const proMenu = document.getElementById('proMenu');
  proBtn.addEventListener('click', () => proMenu.classList.toggle('open'));
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) proMenu.classList.remove('open');
  });

  wireProMenuButtons(wrap, proMenu);
}

// Rebuild the Pro menu after a mid-session purchase
function rebuildProMenu() {
  const proMenu = document.getElementById('proMenu');
  const wrap = proMenu?.parentElement;
  if (!proMenu || !wrap) return;
  proMenu.innerHTML = buildProMenuHTML();
  wireProMenuButtons(wrap, proMenu);
}

function updateProButtonLabel() {
  const btn = document.getElementById('proBtn');
  if (btn) {
    btn.innerHTML = proButtonLabel();
    btn.title = isPaid ? 'HexDrop Pro is active' : 'Unlock Pro features for $4.99';
    btn.classList.toggle('is-paid', isPaid);
  }
}

// Update tooltips on all status-bar / toolbar Pro-gated buttons. Called after
// purchase so users see "Save bookmark" instead of "Bookmark — Pro feature".
function refreshAllProTooltips() {
  const tips = isPaid ? {
    bookmarkBtn:        'Save this offset as a bookmark',
    bookmarksListBtn:   'Show bookmarks for this file',
    hashesBtn:          'Show file & selection hashes (SHA-1, SHA-256, CRC32)',
    annotateBtn:        'Annotate this byte range',
    annotationsListBtn: 'Show annotations for this file',
    diffModeBtn:        'Diff Mode — compare two files side-by-side',
    valueDecoderBtn:    'Decode selected bytes as int / uint / float (LE + BE)',
    structuresBtn:      'Apply a structure template to decode bytes as named fields',
    changedScanBtn:     'Find bytes that changed between two file states',
  } : {
    bookmarkBtn:        'Bookmark — Pro feature',
    bookmarksListBtn:   'Bookmarks — Pro feature',
    hashesBtn:          'Hashes — Pro feature',
    annotateBtn:        'Annotations — Pro feature',
    annotationsListBtn: 'Annotations — Pro feature',
    diffModeBtn:        'Diff Mode — Pro feature',
    valueDecoderBtn:    'Value Decoder — Pro feature',
    structuresBtn:      'Structure Templates — Pro feature',
    changedScanBtn:     'Changed-bytes Scan — Pro feature',
  };
  for (const id in tips) {
    const el = document.getElementById(id);
    if (el) el.title = tips[id];
  }
}

// One-time celebratory toast when ExtPay confirms a successful purchase
function showProUnlockedToast() {
  const toast = document.createElement('div');
  toast.className = 'pro-unlocked-toast';
  toast.innerHTML = `
    <div class="pro-toast-title">★ HEXDROP PRO UNLOCKED</div>
    <div class="pro-toast-body">All features active — themes, bookmarks, hashes, annotations, diff mode, and wildcard search.</div>
  `;
  document.body.appendChild(toast);
  // Trigger entrance transition on next frame
  requestAnimationFrame(() => toast.classList.add('open'));
  setTimeout(() => {
    toast.classList.remove('open');
    setTimeout(() => toast.remove(), 350);
  }, 5500);
}

// ── Themes ──────────────────────────────────────────────────────────────────
// CSS var keys that custom themes drive (subset of the full preset palette;
// the rest are derived mathematically from these primary colors).
const CUSTOM_THEME_VARS = ['bg', 'bg2', 'bg3', 'bg4', 'accent', 'accent2',
  'accent-dim', 'accent-glow', 'accent-sel', 'accent-match',
  'text', 'dim', 'ghost', 'border', 'border-hi', 'even', 'hover', 'match-active'];

function applyTheme(themeId) {
  // Always clear any inline custom-theme overrides when switching to a preset.
  // Inline CSS vars persist across data-theme changes otherwise.
  if (themeId !== 'custom') {
    for (const v of CUSTOM_THEME_VARS) {
      document.documentElement.style.removeProperty(`--${v}`);
    }
  }
  document.documentElement.setAttribute('data-theme', themeId);
}

function saveTheme(themeId) {
  chrome.storage.local.set({ hexdrop_theme: themeId });
}

function applyStoredTheme() {
  chrome.storage.local.get(['hexdrop_theme', 'hexdrop_custom_palette'], data => {
    if (data.hexdrop_theme) {
      const theme = THEMES.find(t => t.id === data.hexdrop_theme);
      // Validate user is still entitled to this theme (e.g. they downgraded)
      if (theme && (theme.isFree || isPaid)) {
        if (theme.isCustom && data.hexdrop_custom_palette) {
          applyCustomPalette(data.hexdrop_custom_palette);
        } else {
          applyTheme(data.hexdrop_theme);
        }
      }
    }
  });
}

// ── Custom theme: color math + palette derivation ──────────────────────────

function hexToRgb(hex) {
  const m = /^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function rgbToHex(r, g, b) {
  const c = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}

function shiftLightness(hex, deltaL) {
  const { r, g, b } = hexToRgb(hex);
  const hsl = rgbToHsl(r, g, b);
  hsl.l = Math.max(0, Math.min(1, hsl.l + deltaL));
  const rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

function alphaRgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

// Build a full 18-variable palette from 3 user-chosen primary colors.
// Background variants step lighter; accent darkens for dim states; text
// dims for secondary copy. Mirrors the structure of the preset themes.
function deriveCustomPalette({ bg, accent, text }) {
  return {
    bg:             bg,
    bg2:            shiftLightness(bg,  0.012),
    bg3:            shiftLightness(bg,  0.030),
    bg4:            shiftLightness(bg,  0.058),
    accent:         accent,
    accent2:        shiftLightness(accent, -0.08),
    'accent-dim':   shiftLightness(accent, -0.30),
    'accent-glow':  alphaRgba(accent, 0.15),
    'accent-sel':   alphaRgba(accent, 0.22),
    'accent-match': alphaRgba(accent, 0.28),
    text:           text,
    dim:            shiftLightness(text, -0.20),
    ghost:          shiftLightness(text, -0.40),
    border:         shiftLightness(bg,  0.045),
    'border-hi':    shiftLightness(bg,  0.080),
    even:           shiftLightness(bg, -0.012),
    hover:          shiftLightness(bg,  0.030),
    'match-active': accent,
  };
}

// Apply a derived palette by setting inline CSS vars on <html>. Inline styles
// have higher specificity than [data-theme] rules, so the custom palette
// wins as long as the inline styles are present.
function applyCustomPalette(palette) {
  document.documentElement.setAttribute('data-theme', 'custom');
  for (const key of CUSTOM_THEME_VARS) {
    if (palette[key] !== undefined) {
      document.documentElement.style.setProperty(`--${key}`, palette[key]);
    }
  }
}

function saveCustomPalette(primaries) {
  const palette = deriveCustomPalette(primaries);
  chrome.storage.local.set({
    hexdrop_theme: 'custom',
    hexdrop_custom_palette: palette,
    hexdrop_custom_primaries: primaries,
  });
  applyCustomPalette(palette);
}

// ── Custom theme modal ─────────────────────────────────────────────────────

function openCustomThemeModal() {
  if (!isPaid) { extpay.openPaymentPage('hexdrop-pro'); return; }
  let modal = document.getElementById('customThemeModal');
  if (!modal) {
    modal = buildCustomThemeModal();
    document.body.appendChild(modal);
  }
  // Pre-fill with last-saved primaries (or defaults)
  chrome.storage.local.get('hexdrop_custom_primaries', data => {
    const p = data.hexdrop_custom_primaries || { bg: '#0a0a14', accent: '#ff6464', text: '#e0e0f0' };
    modal.querySelector('#ctmBg').value     = p.bg;
    modal.querySelector('#ctmAccent').value = p.accent;
    modal.querySelector('#ctmText').value   = p.text;
    updateCustomThemePreview();
  });
  modal.classList.add('open');
}

function closeCustomThemeModal() {
  const modal = document.getElementById('customThemeModal');
  if (modal) modal.classList.remove('open');
  // If user cancels, revert to the previously-saved theme
  chrome.storage.local.get(['hexdrop_theme', 'hexdrop_custom_palette'], data => {
    if (data.hexdrop_theme === 'custom' && data.hexdrop_custom_palette) {
      applyCustomPalette(data.hexdrop_custom_palette);
    } else if (data.hexdrop_theme) {
      applyTheme(data.hexdrop_theme);
    } else {
      applyTheme('amber');
    }
  });
}

function updateCustomThemePreview() {
  const modal = document.getElementById('customThemeModal');
  if (!modal) return;
  const primaries = {
    bg:     modal.querySelector('#ctmBg').value,
    accent: modal.querySelector('#ctmAccent').value,
    text:   modal.querySelector('#ctmText').value,
  };
  applyCustomPalette(deriveCustomPalette(primaries));
}

// ── Value Decoder ─────────────────────────────────────────────────────────
// Pro feature. When bytes are selected, shows the same byte range decoded as
// every common numeric type (int8/16/32/64 signed+unsigned, float32/64) in
// both little-endian and big-endian. Critical tool for reverse engineering
// binary file formats — modders read this constantly.
//
// All computation local; no storage; no network.

function injectValueDecoderUI() {
  const statusbar = document.getElementById('statusbar');
  if (!statusbar) return;

  const btn = document.createElement('button');
  btn.id = 'valueDecoderBtn';
  btn.textContent = 'Σ Decode';
  btn.title = isPaid ? 'Decode selected bytes as int / uint / float (LE + BE)' : 'Value Decoder — Pro feature';
  btn.addEventListener('click', () => {
    if (!isPaid) { extpay.openPaymentPage('hexdrop-pro'); return; }
    toggleValueDecoderPanel();
  });
  statusbar.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'valueDecoderPanel';
  panel.innerHTML = `
    <div class="vd-header">
      <span class="vd-title">VALUE DECODER</span>
      <button id="valueDecoderClose" title="Close">✕</button>
    </div>
    <div class="vd-body" id="valueDecoderBody">
      <div class="vd-empty">Select bytes in the hex grid to decode them as numeric values.</div>
    </div>
  `;
  document.body.appendChild(panel);
  document.getElementById('valueDecoderClose').addEventListener('click', () => {
    panel.classList.remove('open');
  });
}

function toggleValueDecoderPanel() {
  const panel = document.getElementById('valueDecoderPanel');
  if (!panel) return;
  // Close other Pro panels (mutually exclusive)
  document.getElementById('bookmarksPanel')?.classList.remove('open');
  document.getElementById('hashPanel')?.classList.remove('open');
  document.getElementById('annotationsPanel')?.classList.remove('open');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) refreshValueDecoderPanel();
}

function refreshValueDecoderPanel() {
  const body = document.getElementById('valueDecoderBody');
  if (!body) return;
  if (!isPaid) {
    body.innerHTML = '<div class="vd-empty">Value decoder unlocks with HexDrop Pro ($4.99).</div>';
    return;
  }
  if (!currentFileBytes) {
    body.innerHTML = '<div class="vd-empty">Open a file to use the value decoder.</div>';
    return;
  }
  const sel = currentSelection;
  if (sel.start < 0) {
    body.innerHTML = '<div class="vd-empty">Select bytes in the hex grid to decode them.</div>';
    return;
  }
  const lo = sel.start;
  const hi = sel.end;
  const len = hi - lo + 1;
  const slice = currentFileBytes.slice(lo, hi + 1);

  // Build a DataView starting at byte 0 of the slice for clean reads
  const buf = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
  const view = new DataView(buf);

  // Helper: render a row only if the type fits in the current selection
  const row = (typeName, leVal, beVal, requiredBytes) => {
    const fits = len >= requiredBytes;
    if (!fits) return '';
    return `
      <div class="vd-row">
        <span class="vd-type">${typeName}</span>
        <span class="vd-value vd-le" title="${leVal}">${leVal}</span>
        <span class="vd-value vd-be" title="${beVal}">${beVal}</span>
      </div>
    `;
  };

  let html = `
    <div class="vd-info">${len} byte${len === 1 ? '' : 's'} at offset 0x${lo.toString(16).toUpperCase()} (${lo})</div>
    <div class="vd-row vd-hdr">
      <span class="vd-type">TYPE</span>
      <span class="vd-value">LITTLE-ENDIAN</span>
      <span class="vd-value">BIG-ENDIAN</span>
    </div>
  `;

  // 1-byte types (no endianness)
  if (len >= 1) {
    const u8 = view.getUint8(0);
    const i8 = view.getInt8(0);
    html += `
      <div class="vd-row">
        <span class="vd-type">int8</span>
        <span class="vd-value vd-le" colspan="2">${i8}</span>
        <span class="vd-value vd-na">—</span>
      </div>
      <div class="vd-row">
        <span class="vd-type">uint8</span>
        <span class="vd-value vd-le">${u8}</span>
        <span class="vd-value vd-na">—</span>
      </div>
    `;
  }

  // 2-byte types
  if (len >= 2) {
    html += row('int16',  view.getInt16(0, true),  view.getInt16(0, false),  2);
    html += row('uint16', view.getUint16(0, true), view.getUint16(0, false), 2);
  }

  // 4-byte types
  if (len >= 4) {
    html += row('int32',   view.getInt32(0, true),    view.getInt32(0, false),    4);
    html += row('uint32',  view.getUint32(0, true),   view.getUint32(0, false),   4);
    const f32le = view.getFloat32(0, true);
    const f32be = view.getFloat32(0, false);
    html += row('float32', formatFloat(f32le), formatFloat(f32be), 4);
  }

  // 8-byte types
  if (len >= 8) {
    html += row('int64',   view.getBigInt64(0, true).toString(),    view.getBigInt64(0, false).toString(),    8);
    html += row('uint64',  view.getBigUint64(0, true).toString(),   view.getBigUint64(0, false).toString(),   8);
    const f64le = view.getFloat64(0, true);
    const f64be = view.getFloat64(0, false);
    html += row('float64', formatFloat(f64le), formatFloat(f64be), 8);
  }

  if (len < 1) {
    html += '<div class="vd-empty">Select at least 1 byte.</div>';
  } else if (len > 8) {
    html += '<div class="vd-hint">Only the first 8 bytes are decoded. Select fewer bytes for tighter readings.</div>';
  }

  body.innerHTML = html;
}

function formatFloat(n) {
  if (!isFinite(n)) return String(n);  // Infinity, -Infinity, NaN
  // Format with reasonable precision; trim trailing zeros
  return Number(n.toPrecision(9)).toString();
}

function buildCustomThemeModal() {
  const modal = document.createElement('div');
  modal.id = 'customThemeModal';
  modal.innerHTML = `
    <div class="ctm-backdrop"></div>
    <div class="ctm-box">
      <div class="ctm-title">CUSTOM THEME</div>
      <div class="ctm-hint">Pick 3 primary colors. HexDrop derives the full palette (backgrounds, borders, dim text, accent variations) automatically. Live preview as you choose.</div>

      <div class="ctm-row">
        <label class="ctm-label" for="ctmBg">Background</label>
        <input type="color" id="ctmBg" value="#0a0a14">
        <span class="ctm-hex" id="ctmBgHex">#0a0a14</span>
      </div>
      <div class="ctm-row">
        <label class="ctm-label" for="ctmAccent">Accent / Highlight</label>
        <input type="color" id="ctmAccent" value="#ff6464">
        <span class="ctm-hex" id="ctmAccentHex">#ff6464</span>
      </div>
      <div class="ctm-row">
        <label class="ctm-label" for="ctmText">Text / Foreground</label>
        <input type="color" id="ctmText" value="#e0e0f0">
        <span class="ctm-hex" id="ctmTextHex">#e0e0f0</span>
      </div>

      <div class="ctm-actions">
        <button id="ctmCancel">Cancel</button>
        <button id="ctmSave" class="ctm-primary">Save Theme</button>
      </div>
    </div>
  `;

  // Live preview on every input change
  ['ctmBg', 'ctmAccent', 'ctmText'].forEach(id => {
    const input = modal.querySelector(`#${id}`);
    const hexLbl = modal.querySelector(`#${id}Hex`);
    input.addEventListener('input', () => {
      hexLbl.textContent = input.value;
      updateCustomThemePreview();
    });
  });

  modal.querySelector('.ctm-backdrop').addEventListener('click', closeCustomThemeModal);
  modal.querySelector('#ctmCancel').addEventListener('click', closeCustomThemeModal);
  modal.querySelector('#ctmSave').addEventListener('click', () => {
    const primaries = {
      bg:     modal.querySelector('#ctmBg').value,
      accent: modal.querySelector('#ctmAccent').value,
      text:   modal.querySelector('#ctmText').value,
    };
    saveCustomPalette(primaries);
    modal.classList.remove('open');
  });

  return modal;
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
  // Store bytes reference unconditionally — needed for hash calculator if
  // user upgrades mid-session. Reference, not copy, so memory cost is zero.
  currentFileBytes = bytes || null;
  refreshHashPanel();

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

// Public API used by hexdrop.js when selection changes
// Called as: window.hexdropProSetSelection(loOffset, hiOffset) or (-1, -1) to clear
window.hexdropProSetSelection = function(start, end) {
  currentSelection = { start, end };
  // Only re-render panels that are open (cheap optimization)
  const hashPanel = document.getElementById('hashPanel');
  if (hashPanel && hashPanel.classList.contains('open')) {
    refreshHashPanel();
  }
  const decPanel = document.getElementById('valueDecoderPanel');
  if (decPanel && decPanel.classList.contains('open')) {
    refreshValueDecoderPanel();
  }
};

// Public API: returns true if Pro features are unlocked
window.hexdropProIsPaid = function() {
  return isPaid;
};

// Public API: opens the upgrade page (used by Pro-gated UI elements in hexdrop.js)
window.hexdropProShowUpgrade = function() {
  extpay.openPaymentPage('hexdrop-pro');
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

// ── Hash Calculator ────────────────────────────────────────────────────────
// Pro feature. Computes SHA-256, SHA-1, and CRC32 of the full file and any
// selected byte range. Web Crypto handles SHA-* asynchronously; CRC32 is a
// custom implementation since the Web Crypto API doesn't expose it.
//
// Privacy: hashes are computed locally in the browser. No bytes leave the
// device. Hashes are never persisted to chrome.storage.
//
// Performance: SHA-256/SHA-1 on a 100MB file = ~200ms via Web Crypto.
// CRC32 in JS = ~500ms on 100MB. We show a "Calculating…" state during.

// Standard CRC-32 (IEEE 802.3, polynomial 0xEDB88320 reflected). Cached lookup table.
let CRC32_TABLE = null;
function buildCrc32Table() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  CRC32_TABLE = t;
}
function crc32(bytes) {
  if (!CRC32_TABLE) buildCrc32Table();
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  }
  return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

// Compute SHA-1 + SHA-256 + CRC32 for a byte range. Returns Promise of object.
async function computeHashes(bytes) {
  const [sha1Buf, sha256Buf] = await Promise.all([
    crypto.subtle.digest('SHA-1',   bytes),
    crypto.subtle.digest('SHA-256', bytes),
  ]);
  const toHex = buf => Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    sha1:   toHex(sha1Buf),
    sha256: toHex(sha256Buf),
    crc32:  crc32(bytes),
  };
}

function injectHashUI() {
  const statusbar = document.getElementById('statusbar');
  if (!statusbar) return;

  // Hashes button (always visible in status bar; Pro-gated on click)
  const hashBtn = document.createElement('button');
  hashBtn.id = 'hashesBtn';
  hashBtn.textContent = '# Hashes';
  hashBtn.title = isPaid ? 'Show file & selection hashes (SHA-1, SHA-256, CRC32)' : 'Hashes — Pro feature';
  hashBtn.addEventListener('click', () => {
    if (!isPaid) { extpay.openPaymentPage('hexdrop-pro'); return; }
    toggleHashPanel();
  });
  statusbar.appendChild(hashBtn);

  // Hash panel (slides in from right, mutually exclusive with bookmarks panel)
  const panel = document.createElement('div');
  panel.id = 'hashPanel';
  panel.innerHTML = `
    <div class="hash-header">
      <span class="hash-title">HASHES</span>
      <button id="hashPanelClose" title="Close">✕</button>
    </div>
    <div class="hash-body" id="hashBody">
      <div class="hash-empty">Open a file to see its hashes.</div>
    </div>
  `;
  document.body.appendChild(panel);
  document.getElementById('hashPanelClose').addEventListener('click', () => {
    panel.classList.remove('open');
  });
}

function toggleHashPanel() {
  const panel = document.getElementById('hashPanel');
  if (!panel) return;
  // Close bookmarks panel if open (mutually exclusive)
  const bookmarksPanel = document.getElementById('bookmarksPanel');
  if (bookmarksPanel) bookmarksPanel.classList.remove('open');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) refreshHashPanel();
}

async function refreshHashPanel() {
  const body = document.getElementById('hashBody');
  if (!body) return;
  if (!isPaid) {
    body.innerHTML = '<div class="hash-empty">Hashes unlock with HexDrop Pro ($4.99).</div>';
    return;
  }
  if (!currentFileBytes) {
    body.innerHTML = '<div class="hash-empty">Open a file to see its hashes.</div>';
    return;
  }

  // Render skeleton with loading state
  const sel = currentSelection;
  const hasSel = sel.start >= 0 && sel.end >= sel.start;
  const selLen = hasSel ? (sel.end - sel.start + 1) : 0;
  const fileLen = currentFileBytes.length;

  body.innerHTML = `
    <div class="hash-section">
      <div class="hash-section-title">FULL FILE <span class="hash-dim">(${fileLen.toLocaleString()} bytes)</span></div>
      <div id="hashFullRows" class="hash-rows"><div class="hash-loading">Calculating…</div></div>
    </div>
    ${hasSel ? `
      <div class="hash-section">
        <div class="hash-section-title">SELECTION <span class="hash-dim">(${selLen.toLocaleString()} bytes at 0x${sel.start.toString(16).toUpperCase()})</span></div>
        <div id="hashSelRows" class="hash-rows"><div class="hash-loading">Calculating…</div></div>
      </div>
    ` : `
      <div class="hash-section">
        <div class="hash-section-title">SELECTION</div>
        <div class="hash-empty-mini">Select a byte range in the hex grid to hash a region.</div>
      </div>
    `}
  `;

  // Compute full-file hashes
  computeHashes(currentFileBytes).then(h => {
    const rows = document.getElementById('hashFullRows');
    if (rows) rows.innerHTML = renderHashRows(h);
    wireHashCopyButtons(rows);
  }).catch(err => {
    const rows = document.getElementById('hashFullRows');
    if (rows) rows.innerHTML = `<div class="hash-error">Failed: ${escapeHtml(err.message || String(err))}</div>`;
  });

  // Compute selection hashes if range exists
  if (hasSel) {
    const slice = currentFileBytes.slice(sel.start, sel.end + 1);
    computeHashes(slice).then(h => {
      const rows = document.getElementById('hashSelRows');
      if (rows) rows.innerHTML = renderHashRows(h);
      wireHashCopyButtons(rows);
    }).catch(err => {
      const rows = document.getElementById('hashSelRows');
      if (rows) rows.innerHTML = `<div class="hash-error">Failed: ${escapeHtml(err.message || String(err))}</div>`;
    });
  }
}

function renderHashRows(h) {
  return `
    <div class="hash-row">
      <span class="hash-algo">SHA-256</span>
      <span class="hash-value" title="${h.sha256}">${h.sha256}</span>
      <button class="hash-copy" data-value="${h.sha256}" title="Copy SHA-256">📋</button>
    </div>
    <div class="hash-row">
      <span class="hash-algo">SHA-1</span>
      <span class="hash-value" title="${h.sha1}">${h.sha1}</span>
      <button class="hash-copy" data-value="${h.sha1}" title="Copy SHA-1">📋</button>
    </div>
    <div class="hash-row">
      <span class="hash-algo">CRC32</span>
      <span class="hash-value">${h.crc32}</span>
      <button class="hash-copy" data-value="${h.crc32}" title="Copy CRC32">📋</button>
    </div>
  `;
}

function wireHashCopyButtons(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll('.hash-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.value;
      navigator.clipboard.writeText(v).then(() => {
        const original = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = original; }, 900);
      });
    });
  });
}

// ── Annotated Regions ──────────────────────────────────────────────────────
// Pro feature. User selects a byte range, picks a color + label, and the
// region is highlighted in the hex grid every time it's rendered.
//
// Storage: chrome.storage.local under key `hexdrop_annotations_<sha1hash>`.
// Each entry: { start: int, end: int, label: string, color: string, createdAt: ISO }
//
// Privacy: same model as bookmarks — only the SHA-1 hash of the file is the
// key. The annotation labels themselves stay local. File content never stored.
//
// Render integration: hexdrop.js calls window.hexdropProAfterRender(start, end)
// after every render. We query the rendered byte cells in the visible page
// range and apply background colors via inline style (cheap; ~1000 cells max).

const ANNOTATION_COLORS = [
  { id: 'red',    name: 'Red',    bg: 'rgba(220, 60, 60, 0.35)',   border: '#dc3c3c' },
  { id: 'orange', name: 'Orange', bg: 'rgba(240, 140, 40, 0.35)',  border: '#f08c28' },
  { id: 'yellow', name: 'Yellow', bg: 'rgba(220, 200, 40, 0.35)',  border: '#dcc828' },
  { id: 'green',  name: 'Green',  bg: 'rgba(60, 200, 80, 0.35)',   border: '#3cc850' },
  { id: 'blue',   name: 'Blue',   bg: 'rgba(60, 140, 220, 0.35)',  border: '#3c8cdc' },
  { id: 'purple', name: 'Purple', bg: 'rgba(180, 80, 220, 0.35)',  border: '#b450dc' },
];

// Cache of annotations for the current file (avoid storage hit on every render)
let cachedAnnotations = [];

function injectAnnotationsUI() {
  const statusbar = document.getElementById('statusbar');
  if (!statusbar) return;

  // "+ Annotate" button — appears when a byte range is selected (Pro-gated)
  const annotateBtn = document.createElement('button');
  annotateBtn.id = 'annotateBtn';
  annotateBtn.style.display = 'none';
  annotateBtn.textContent = '+ Annotate';
  annotateBtn.title = isPaid ? 'Annotate this byte range' : 'Annotations — Pro feature';
  annotateBtn.addEventListener('click', () => {
    if (!isPaid) { extpay.openPaymentPage('hexdrop-pro'); return; }
    promptAndSaveAnnotation();
  });
  statusbar.appendChild(annotateBtn);

  // "🏷 Annotations" button — always visible, opens panel
  const listBtn = document.createElement('button');
  listBtn.id = 'annotationsListBtn';
  listBtn.textContent = '🏷 Annotations';
  listBtn.title = isPaid ? 'Show annotations for this file' : 'Annotations — Pro feature';
  listBtn.addEventListener('click', () => {
    if (!isPaid) { extpay.openPaymentPage('hexdrop-pro'); return; }
    toggleAnnotationsPanel();
  });
  statusbar.appendChild(listBtn);

  // Annotations panel (slides in from right; mutually exclusive with bookmarks/hash)
  const panel = document.createElement('div');
  panel.id = 'annotationsPanel';
  panel.innerHTML = `
    <div class="ann-header">
      <span class="ann-title">ANNOTATIONS</span>
      <button id="annotationsPanelClose" title="Close">✕</button>
    </div>
    <div class="ann-body" id="annotationsList">
      <div class="ann-empty">Open a file and select a byte range, then click + Annotate.</div>
    </div>
  `;
  document.body.appendChild(panel);
  document.getElementById('annotationsPanelClose').addEventListener('click', () => {
    panel.classList.remove('open');
  });

  // Annotation creation modal (hidden by default)
  const modal = document.createElement('div');
  modal.id = 'annModal';
  modal.innerHTML = `
    <div class="ann-modal-backdrop"></div>
    <div class="ann-modal-box">
      <div class="ann-modal-title">NEW ANNOTATION</div>
      <div class="ann-modal-range" id="annModalRange"></div>
      <input type="text" id="annModalLabel" placeholder="Label (e.g. PE header, magic bytes)" maxlength="80">
      <div class="ann-modal-colors" id="annModalColors"></div>
      <div class="ann-modal-actions">
        <button id="annModalCancel">Cancel</button>
        <button id="annModalSave" class="ann-modal-primary">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Render color swatches
  const colorsEl = modal.querySelector('#annModalColors');
  colorsEl.innerHTML = ANNOTATION_COLORS.map((c, i) => `
    <button class="ann-color-swatch ${i === 0 ? 'selected' : ''}" data-color="${c.id}"
            style="background: ${c.bg}; border-color: ${c.border};" title="${c.name}"></button>
  `).join('');
  colorsEl.querySelectorAll('.ann-color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      colorsEl.querySelectorAll('.ann-color-swatch').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  modal.querySelector('#annModalCancel').addEventListener('click', closeAnnotationModal);
  modal.querySelector('.ann-modal-backdrop').addEventListener('click', closeAnnotationModal);
  modal.querySelector('#annModalSave').addEventListener('click', confirmAnnotationModal);
  modal.querySelector('#annModalLabel').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmAnnotationModal();
    if (e.key === 'Escape') closeAnnotationModal();
  });
}

function toggleAnnotationsPanel() {
  const panel = document.getElementById('annotationsPanel');
  if (!panel) return;
  // Close other Pro panels (mutually exclusive)
  document.getElementById('bookmarksPanel')?.classList.remove('open');
  document.getElementById('hashPanel')?.classList.remove('open');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) refreshAnnotationsPanel();
}

function promptAndSaveAnnotation() {
  if (!currentFileHash) { alert('No file loaded.'); return; }
  const sel = currentSelection;
  if (sel.start < 0 || sel.end < sel.start) {
    alert('Select a byte range first.');
    return;
  }
  const modal = document.getElementById('annModal');
  if (!modal) return;
  const len = sel.end - sel.start + 1;
  modal.querySelector('#annModalRange').textContent =
    `Range: 0x${sel.start.toString(16).toUpperCase()} → 0x${sel.end.toString(16).toUpperCase()} (${len} byte${len === 1 ? '' : 's'})`;
  modal.querySelector('#annModalLabel').value = '';
  // Reset color selection to first
  modal.querySelectorAll('.ann-color-swatch').forEach((b, i) => {
    b.classList.toggle('selected', i === 0);
  });
  modal.classList.add('open');
  setTimeout(() => modal.querySelector('#annModalLabel').focus(), 50);
}

function closeAnnotationModal() {
  document.getElementById('annModal')?.classList.remove('open');
}

function confirmAnnotationModal() {
  const modal = document.getElementById('annModal');
  if (!modal) return;
  const label = modal.querySelector('#annModalLabel').value.trim();
  const selectedSwatch = modal.querySelector('.ann-color-swatch.selected');
  const colorId = selectedSwatch ? selectedSwatch.dataset.color : 'red';
  const sel = currentSelection;
  if (sel.start < 0) { closeAnnotationModal(); return; }
  saveAnnotation(sel.start, sel.end, label, colorId);
  closeAnnotationModal();
}

function saveAnnotation(start, end, label, colorId) {
  if (!currentFileHash) return;
  const key = `hexdrop_annotations_${currentFileHash}`;
  chrome.storage.local.get(key, data => {
    const list = data[key] || [];
    list.push({ start, end, label, color: colorId, createdAt: new Date().toISOString() });
    chrome.storage.local.set({ [key]: list }, () => {
      cachedAnnotations = list;
      refreshAnnotationsPanel();
      repaintAnnotations();
    });
  });
}

function deleteAnnotation(index) {
  if (!currentFileHash) return;
  const key = `hexdrop_annotations_${currentFileHash}`;
  chrome.storage.local.get(key, data => {
    const list = data[key] || [];
    list.splice(index, 1);
    chrome.storage.local.set({ [key]: list }, () => {
      cachedAnnotations = list;
      refreshAnnotationsPanel();
      repaintAnnotations();
    });
  });
}

function refreshAnnotationsPanel() {
  const list = document.getElementById('annotationsList');
  if (!list) return;
  if (!isPaid) {
    list.innerHTML = '<div class="ann-empty">Annotations unlock with HexDrop Pro ($4.99).</div>';
    return;
  }
  if (!currentFileHash) {
    list.innerHTML = '<div class="ann-empty">Open a file to see its annotations.</div>';
    return;
  }
  const key = `hexdrop_annotations_${currentFileHash}`;
  chrome.storage.local.get(key, data => {
    const items = data[key] || [];
    cachedAnnotations = items;
    if (items.length === 0) {
      list.innerHTML = '<div class="ann-empty">No annotations for this file yet. Select bytes and click + Annotate.</div>';
      return;
    }
    list.innerHTML = items.map((a, i) => {
      const color = ANNOTATION_COLORS.find(c => c.id === a.color) || ANNOTATION_COLORS[0];
      const len = a.end - a.start + 1;
      return `
        <div class="ann-row" style="border-left: 3px solid ${color.border};">
          <div class="ann-row-top">
            <button class="ann-jump" data-start="${a.start}" title="Jump to this annotation">
              0x${a.start.toString(16).toUpperCase().padStart(8, '0')}
              <span class="ann-len">(${len}B)</span>
            </button>
            <button class="ann-del" data-index="${i}" title="Delete annotation">✕</button>
          </div>
          <div class="ann-label">${escapeHtml(a.label) || '<em>no label</em>'}</div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.ann-jump').forEach(btn => {
      btn.addEventListener('click', () => {
        const start = parseInt(btn.dataset.start, 10);
        const jumpInput = document.getElementById('jumpInput');
        const jumpBtn = document.getElementById('jumpBtn');
        const jumpMode = document.getElementById('jumpMode');
        if (jumpInput && jumpBtn) {
          if (jumpMode && jumpMode.textContent === 'DEC') jumpMode.click();
          jumpInput.value = start.toString(16).toUpperCase();
          jumpBtn.click();
        }
      });
    });
    list.querySelectorAll('.ann-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.dataset.index, 10);
        if (confirm('Delete this annotation?')) deleteAnnotation(index);
      });
    });
  });
}

// Called by hexdrop.js after each render. Applies annotation backgrounds to
// the visible byte cells. Cheap: O(annotations × visible_bytes) but both
// are small in practice (annotations <100, visible bytes <1024 per page).
window.hexdropProAfterRender = function(pageStart, pageEnd) {
  if (!isPaid || cachedAnnotations.length === 0) return;
  for (const ann of cachedAnnotations) {
    if (ann.end < pageStart || ann.start >= pageEnd) continue;
    const color = ANNOTATION_COLORS.find(c => c.id === ann.color) || ANNOTATION_COLORS[0];
    const lo = Math.max(ann.start, pageStart);
    const hi = Math.min(ann.end, pageEnd - 1);
    for (let off = lo; off <= hi; off++) {
      const cells = document.querySelectorAll(`[data-i="${off}"]`);
      cells.forEach(cell => {
        cell.style.backgroundColor = color.bg;
        cell.style.boxShadow = `inset 0 -1px 0 ${color.border}`;
        if (ann.label) cell.title = ann.label;
      });
    }
  }
};

// Force a repaint of annotations (called after add/delete or when paid state changes)
function repaintAnnotations() {
  // Trigger hexdrop.js render() indirectly by clicking nothing — actually
  // simpler: just call our after-render directly with the visible page range.
  // We need to know what's currently rendered. Read from the DOM.
  const cells = document.querySelectorAll('.byte[data-i]');
  if (cells.length === 0) return;
  let minOff = Infinity, maxOff = -Infinity;
  cells.forEach(c => {
    const i = parseInt(c.dataset.i, 10);
    if (i < minOff) minOff = i;
    if (i > maxOff) maxOff = i;
  });
  if (isFinite(minOff)) {
    // Clear existing annotation styles first (so deleted ones disappear)
    cells.forEach(c => {
      c.style.backgroundColor = '';
      c.style.boxShadow = '';
      // Don't clobber the title if it was set by something else; but
      // annotations are the only thing that sets cell.title currently.
      c.title = '';
    });
    window.hexdropProAfterRender(minOff, maxOff + 1);
  }
}

// Show/hide the "+ Annotate" button based on selection state
function updateAnnotateBtnVisibility() {
  const btn = document.getElementById('annotateBtn');
  if (!btn) return;
  const sel = currentSelection;
  const hasRange = sel.start >= 0 && sel.end >= sel.start;
  btn.style.display = (hasRange && isPaid) ? '' : 'none';
}

// Hook into the existing selection-change pathway by wrapping the original
// hexdropProSetSelection. We already defined it earlier — extend it now.
const _originalSetSelection = window.hexdropProSetSelection;
window.hexdropProSetSelection = function(start, end) {
  _originalSetSelection(start, end);
  updateAnnotateBtnVisibility();
};

// Load annotations when a file is loaded
const _originalSetFile = window.hexdropProSetFile;
window.hexdropProSetFile = async function(bytes) {
  await _originalSetFile(bytes);
  // Load annotations for the new file
  if (isPaid && currentFileHash) {
    chrome.storage.local.get(`hexdrop_annotations_${currentFileHash}`, data => {
      cachedAnnotations = data[`hexdrop_annotations_${currentFileHash}`] || [];
      refreshAnnotationsPanel();
      repaintAnnotations();
    });
  } else {
    cachedAnnotations = [];
    refreshAnnotationsPanel();
  }
};

// ── Diff Mode ───────────────────────────────────────────────────────────────
// Pro feature. Side-by-side comparison of two files. Byte-by-byte alignment
// (no LCS — keeps v1 simple). Diff bytes highlighted in red. Paged at 16KB
// per side for performance with large files. Sync-scrolled.
//
// Self-contained: loaded files are not added to the main viewer's state.
// Privacy: no bytes leave the device. Files are read locally via FileReader.

const DIFF_PAGE_BYTES = 16 * 1024;
const DIFF_COLS = 16;
let diffFileA = { name: '', bytes: null };
let diffFileB = { name: '', bytes: null };
let diffPage = 0;
let diffOffsets = [];        // offsets where files differ (computed lazily, capped)
let activeDiffIdx = -1;      // currently focused diff index within diffOffsets
let diffViewMode = 'sxs';    // 'sxs' (side-by-side) or 'changes' (list)
const DIFF_MAX_FOUND = 100000;

function injectDiffUI() {
  // Diff Mode button on the toolbar (next to ⬢ Pro)
  const toolbarRight = document.querySelector('.toolbar-right');
  if (!toolbarRight) return;

  const diffBtn = document.createElement('button');
  diffBtn.id = 'diffModeBtn';
  diffBtn.className = 'pro-toolbar-btn';
  diffBtn.textContent = '⇄ Diff';
  diffBtn.title = isPaid ? 'Diff Mode — compare two files side-by-side' : 'Diff Mode — Pro feature';
  diffBtn.addEventListener('click', () => {
    if (!isPaid) { extpay.openPaymentPage('hexdrop-pro'); return; }
    openDiffModal();
  });
  // Insert before the help button so it sits next to ⬢ Pro
  const helpBtn = document.getElementById('helpBtn');
  if (helpBtn) toolbarRight.insertBefore(diffBtn, helpBtn);
  else toolbarRight.appendChild(diffBtn);

  // Diff modal (full-screen overlay)
  const modal = document.createElement('div');
  modal.id = 'diffModal';
  modal.innerHTML = `
    <div class="diff-modal-header">
      <span class="diff-modal-title">DIFF MODE</span>
      <span class="diff-modal-spacer"></span>
      <button id="diffModalClose" title="Close diff mode (Esc)">✕ Close</button>
    </div>
    <div class="diff-modal-controls">
      <div class="diff-file-picker">
        <span class="diff-file-label">FILE A:</span>
        <button id="diffPickA">Choose file…</button>
        <span class="diff-file-name" id="diffNameA">—</span>
        <input type="file" id="diffInputA" style="display:none">
      </div>
      <div class="diff-file-picker">
        <span class="diff-file-label">FILE B:</span>
        <button id="diffPickB">Choose file…</button>
        <span class="diff-file-name" id="diffNameB">—</span>
        <input type="file" id="diffInputB" style="display:none">
      </div>
    </div>
    <div class="diff-modal-info" id="diffInfo">Pick both files to begin comparison.</div>
    <div class="diff-modal-tabs" id="diffTabs" style="display:none">
      <button class="diff-tab active" data-view="sxs"     title="Show both files side-by-side with diff highlights">⇄ Side-by-Side</button>
      <button class="diff-tab"         data-view="changes" title="Show ONLY the bytes that changed (cheat-engine style)">Δ Changes Only</button>
      <button class="diff-tab diff-tab-action" id="diffExportPatch" title="Export differences as a binary patch file">⇩ Export Patch</button>
    </div>
    <div class="diff-modal-nav" id="diffNav" style="display:none">
      <button id="diffPrev" title="Previous diff">◀ PREV DIFF</button>
      <button id="diffNext" title="Next diff">NEXT DIFF ▶</button>
      <span class="diff-page-info" id="diffPageInfo"></span>
      <button id="diffPagePrev" title="Previous page">◀ PAGE</button>
      <button id="diffPageNext" title="Next page">PAGE ▶</button>
    </div>
    <div class="diff-modal-grids" id="diffGrids"></div>
  `;
  document.body.appendChild(modal);

  // Wire close
  modal.querySelector('#diffModalClose').addEventListener('click', closeDiffModal);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeDiffModal();
  });

  // Wire file pickers
  modal.querySelector('#diffPickA').addEventListener('click', () => modal.querySelector('#diffInputA').click());
  modal.querySelector('#diffPickB').addEventListener('click', () => modal.querySelector('#diffInputB').click());
  modal.querySelector('#diffInputA').addEventListener('change', e => loadDiffFile(e.target.files[0], 'A'));
  modal.querySelector('#diffInputB').addEventListener('change', e => loadDiffFile(e.target.files[0], 'B'));

  // Wire navigation
  modal.querySelector('#diffPrev').addEventListener('click', () => jumpToDiff(-1));
  modal.querySelector('#diffNext').addEventListener('click', () => jumpToDiff(1));
  modal.querySelector('#diffPagePrev').addEventListener('click', () => {
    if (diffPage > 0) { diffPage--; renderDiffGrids(); }
  });
  modal.querySelector('#diffPageNext').addEventListener('click', () => {
    const totalBytes = Math.max(diffFileA.bytes?.length || 0, diffFileB.bytes?.length || 0);
    const totalPages = Math.max(1, Math.ceil(totalBytes / DIFF_PAGE_BYTES));
    if (diffPage < totalPages - 1) { diffPage++; renderDiffGrids(); }
  });

  // Wire view-mode tabs
  modal.querySelectorAll('.diff-tab[data-view]').forEach(tab => {
    tab.addEventListener('click', () => {
      diffViewMode = tab.dataset.view;
      modal.querySelectorAll('.diff-tab[data-view]').forEach(t =>
        t.classList.toggle('active', t.dataset.view === diffViewMode));
      // PAGE/DIFF nav only makes sense in side-by-side view
      const nav = modal.querySelector('#diffNav');
      if (nav) nav.style.display = (diffViewMode === 'sxs' && diffOffsets.length > 0) ? '' : 'none';
      renderDiffGrids();
    });
  });

  // Wire patch export
  modal.querySelector('#diffExportPatch').addEventListener('click', exportDiffPatch);
}

function openDiffModal() {
  const modal = document.getElementById('diffModal');
  if (modal) modal.classList.add('open');
}

function closeDiffModal() {
  const modal = document.getElementById('diffModal');
  if (modal) modal.classList.remove('open');
  // Don't clear loaded files — user may reopen
}

function loadDiffFile(file, slot) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const bytes = new Uint8Array(e.target.result);
    if (slot === 'A') {
      diffFileA = { name: file.name, bytes };
      document.getElementById('diffNameA').textContent = `${file.name} (${bytes.length.toLocaleString()} bytes)`;
    } else {
      diffFileB = { name: file.name, bytes };
      document.getElementById('diffNameB').textContent = `${file.name} (${bytes.length.toLocaleString()} bytes)`;
    }
    if (diffFileA.bytes && diffFileB.bytes) {
      computeDiffOffsets();
      diffPage = 0;
      activeDiffIdx = -1;
      // Reveal tabs once both files loaded
      const tabs = document.getElementById('diffTabs');
      if (tabs) tabs.style.display = '';
      renderDiffGrids();
    }
  };
  reader.onerror = () => alert(`Failed to read ${slot === 'A' ? 'File A' : 'File B'}.`);
  reader.readAsArrayBuffer(file);
}

function computeDiffOffsets() {
  diffOffsets = [];
  const a = diffFileA.bytes;
  const b = diffFileB.bytes;
  const minLen = Math.min(a.length, b.length);
  // Differences within overlapping range
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) {
      diffOffsets.push(i);
      if (diffOffsets.length >= DIFF_MAX_FOUND) break;
    }
  }
  // Tail-only-in-one is also a diff (each "missing" byte counts as a diff)
  if (diffOffsets.length < DIFF_MAX_FOUND) {
    const longer = (a.length > b.length) ? a : b;
    for (let i = minLen; i < longer.length; i++) {
      diffOffsets.push(i);
      if (diffOffsets.length >= DIFF_MAX_FOUND) break;
    }
  }
  const info = document.getElementById('diffInfo');
  const nav = document.getElementById('diffNav');
  const capped = diffOffsets.length >= DIFF_MAX_FOUND;
  info.textContent = capped
    ? `${diffOffsets.length.toLocaleString()}+ differences found (capped)`
    : `${diffOffsets.length.toLocaleString()} difference${diffOffsets.length === 1 ? '' : 's'} found`;
  if (a.length !== b.length) {
    info.textContent += ` · sizes differ: A=${a.length.toLocaleString()}B, B=${b.length.toLocaleString()}B`;
  }
  nav.style.display = (diffOffsets.length > 0 || a.length !== b.length) ? '' : 'none';
}

// Jump to the next/previous individual differing byte, scroll it into view,
// and mark it as the "active" diff (highlighted with a border). Wraps from
// last → first and first → last.
function jumpToDiff(direction) {
  if (diffOffsets.length === 0) return;

  if (activeDiffIdx === -1) {
    // No active yet — pick first or last depending on direction
    activeDiffIdx = (direction > 0) ? 0 : diffOffsets.length - 1;
  } else {
    activeDiffIdx = (activeDiffIdx + direction + diffOffsets.length) % diffOffsets.length;
  }

  const targetOffset = diffOffsets[activeDiffIdx];
  const targetPage = Math.floor(targetOffset / DIFF_PAGE_BYTES);

  if (targetPage !== diffPage) {
    diffPage = targetPage;
    renderDiffGrids();
  } else {
    // Same page — just refresh active highlight
    renderDiffGrids();
  }

  // Scroll the active row into view within the diff grid
  const grids = document.getElementById('diffGrids');
  const activeRow = grids?.querySelector('.diff-row.active-diff');
  if (activeRow) {
    activeRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function renderDiffGrids() {
  const grids = document.getElementById('diffGrids');
  if (!grids) return;
  const a = diffFileA.bytes;
  const b = diffFileB.bytes;
  if (!a || !b) {
    grids.innerHTML = '';
    return;
  }
  if (diffViewMode === 'changes') {
    renderChangesList(grids, a, b);
    return;
  }
  const start = diffPage * DIFF_PAGE_BYTES;
  const endA = Math.min(start + DIFF_PAGE_BYTES, a.length);
  const endB = Math.min(start + DIFF_PAGE_BYTES, b.length);
  const totalBytes = Math.max(a.length, b.length);
  const totalPages = Math.max(1, Math.ceil(totalBytes / DIFF_PAGE_BYTES));

  const activeLabel = (activeDiffIdx >= 0)
    ? `Diff ${activeDiffIdx + 1} / ${diffOffsets.length} @ 0x${diffOffsets[activeDiffIdx].toString(16).toUpperCase()}`
    : '';
  document.getElementById('diffPageInfo').textContent =
    `Page ${diffPage + 1} / ${totalPages}${activeLabel ? '  ·  ' + activeLabel : ''}`;

  const activeOffset = (activeDiffIdx >= 0 && activeDiffIdx < diffOffsets.length)
    ? diffOffsets[activeDiffIdx]
    : -1;

  const rowsHtml = [];
  const rowEnd = Math.max(endA, endB);
  for (let rowStart = start; rowStart < rowEnd; rowStart += DIFF_COLS) {
    const addr = rowStart.toString(16).toUpperCase().padStart(8, '0');
    let aHex = '', bHex = '';
    let rowHasDiff = false;
    let rowHasActive = false;
    for (let j = 0; j < DIFF_COLS; j++) {
      const off = rowStart + j;
      const aByte = (off < a.length) ? a[off] : null;
      const bByte = (off < b.length) ? b[off] : null;
      const isDiff = (aByte !== bByte);
      const isActive = (off === activeOffset);
      if (isDiff) rowHasDiff = true;
      if (isActive) rowHasActive = true;
      let cls = 'diff-byte';
      if (isDiff) cls += ' diff';
      if (isActive) cls += ' active';
      const aStr = aByte === null ? '··' : aByte.toString(16).toUpperCase().padStart(2, '0');
      const bStr = bByte === null ? '··' : bByte.toString(16).toUpperCase().padStart(2, '0');
      aHex += `<span class="${cls}">${aStr}</span>`;
      bHex += `<span class="${cls}">${bStr}</span>`;
    }
    let rowCls = 'diff-row';
    if (rowHasDiff)   rowCls += ' has-diff';
    if (rowHasActive) rowCls += ' active-diff';
    rowsHtml.push(`
      <div class="${rowCls}">
        <span class="diff-addr">${addr}</span>
        <div class="diff-hex">${aHex}</div>
        <div class="diff-hex">${bHex}</div>
      </div>
    `);
  }

  // Header
  let headerHex = '';
  for (let j = 0; j < DIFF_COLS; j++) {
    headerHex += `<span class="diff-byte diff-hdr">${j.toString(16).toUpperCase().padStart(2,'0')}</span>`;
  }

  grids.innerHTML = `
    <div class="diff-row diff-hdr-row">
      <span class="diff-addr diff-hdr">OFFSET</span>
      <div class="diff-hex">${headerHex}</div>
      <div class="diff-hex">${headerHex}</div>
    </div>
    ${rowsHtml.join('')}
  `;

  // Update page button states
  document.getElementById('diffPagePrev').disabled = (diffPage === 0);
  document.getElementById('diffPageNext').disabled = (diffPage >= totalPages - 1);
}

// Cheat-Engine-style "what changed" view. Renders a single column listing
// every changed offset with both byte values, grouped into runs for
// readability. Includes inline numeric interpretations (int16/uint16/int32/
// uint32/float32 LE) for each run when the run is large enough — tells the
// modder "this byte that changed represents an int32 value of 100" so they
// can identify HP, gold, etc. without flipping to the value decoder.
function renderChangesList(grids, a, b) {
  if (diffOffsets.length === 0) {
    grids.innerHTML = `
      <div class="diff-changes-empty">
        No changed bytes. The two files are identical${a.length === b.length ? '' : ' in their overlapping range'}.
      </div>`;
    return;
  }

  // Group consecutive offsets into runs so a 4-byte int change shows as ONE
  // entry instead of 4 single-byte entries — much easier for modders to read.
  const runs = [];
  let runStart = diffOffsets[0];
  let runEnd = diffOffsets[0];
  for (let i = 1; i < diffOffsets.length; i++) {
    if (diffOffsets[i] === runEnd + 1) {
      runEnd = diffOffsets[i];
    } else {
      runs.push({ start: runStart, end: runEnd });
      runStart = diffOffsets[i];
      runEnd = diffOffsets[i];
    }
  }
  runs.push({ start: runStart, end: runEnd });

  const RENDER_CAP = 5000;  // Don't render more than 5K rows — DOM blows up
  const cappedRuns = runs.slice(0, RENDER_CAP);

  let html = `
    <div class="diff-changes-info">
      ${diffOffsets.length.toLocaleString()} changed byte${diffOffsets.length === 1 ? '' : 's'}
      in ${runs.length.toLocaleString()} run${runs.length === 1 ? '' : 's'}
      ${runs.length > RENDER_CAP ? `· showing first ${RENDER_CAP.toLocaleString()}` : ''}
    </div>
    <div class="diff-changes-table">
      <div class="diff-changes-row diff-changes-hdr">
        <span class="dc-offset">OFFSET</span>
        <span class="dc-len">LEN</span>
        <span class="dc-bytes">BEFORE (A)</span>
        <span class="dc-bytes">AFTER (B)</span>
        <span class="dc-decoded">DECODED (LE)</span>
      </div>
  `;

  for (const run of cappedRuns) {
    const len = run.end - run.start + 1;
    const aSlice = a.slice(run.start, Math.min(run.end + 1, a.length));
    const bSlice = b.slice(run.start, Math.min(run.end + 1, b.length));
    const aHex = bytesToHex(aSlice);
    const bHex = bytesToHex(bSlice);
    const decoded = decodeRunForChanges(aSlice, bSlice);

    html += `
      <div class="diff-changes-row">
        <span class="dc-offset">0x${run.start.toString(16).toUpperCase().padStart(8, '0')}</span>
        <span class="dc-len">${len}</span>
        <span class="dc-bytes dc-before">${aHex}</span>
        <span class="dc-bytes dc-after">${bHex}</span>
        <span class="dc-decoded">${decoded}</span>
      </div>
    `;
  }
  html += '</div>';
  grids.innerHTML = html;
}

function bytesToHex(bytes) {
  if (!bytes || bytes.length === 0) return '<em>—</em>';
  return Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

// Pick the most informative interpretation for a run based on its length.
// Returns "old → new" string. Modders typically care about int/uint/float
// interpretations of HP, gold, score, position values.
function decodeRunForChanges(aSlice, bSlice) {
  const minLen = Math.min(aSlice.length, bSlice.length);
  if (minLen === 0) return '—';

  const decode = (slice, len) => {
    if (len === 0) return '—';
    const buf = slice.buffer.slice(slice.byteOffset, slice.byteOffset + Math.min(slice.byteLength, len));
    const v = new DataView(buf);
    if (len >= 4) return `${v.getUint32(0, true)} (u32) · ${formatFloat(v.getFloat32(0, true))} (f32)`;
    if (len >= 2) return `${v.getUint16(0, true)} (u16)`;
    return `${v.getUint8(0)} (u8)`;
  };

  const aDec = decode(aSlice, minLen);
  const bDec = decode(bSlice, minLen);
  return `${aDec} → ${bDec}`;
}

// Patch generation. Outputs a human-readable text format that lists every
// changed byte in the form "OFFSET: OLD -> NEW", easy to apply by hand or
// parse with a tool. Header records source filenames + total diff count.
// ── Structure Templates ────────────────────────────────────────────────────
// Pro feature. User defines a sequence of named typed fields (a "struct"),
// applies it at any byte offset, and sees each field decoded with its
// hex bytes and value. Lite version of 010 Editor's binary templates.
//
// Template DSL (one field per line):
//   <type>[:le|:be]  <name>      # optional comment
//
// Supported types:
//   u8, i8, u16, i16, u32, i32, u64, i64, f32, f64
//   char[N]   (ASCII string, NUL-terminated for display)
//   byte[N]   (raw bytes, shown as hex)
//
// Endianness suffix optional, defaults to little-endian. Lines starting
// with # are comments and ignored.

const STRUCT_PRESETS = {
  png_header: {
    name: 'PNG header',
    text: `# PNG file header (apply at offset 0x00)
char[8] signature
# First IHDR chunk follows immediately
u32:be  ihdr_length
char[4] ihdr_type
u32:be  width
u32:be  height
u8      bit_depth
u8      color_type
u8      compression_method
u8      filter_method
u8      interlace_method
u32:be  ihdr_crc
`,
  },
  bmp_header: {
    name: 'BMP DIB header (BITMAPINFOHEADER)',
    text: `# BMP file header + DIB header (apply at offset 0x00)
char[2] file_signature
u32     file_size
u16     reserved1
u16     reserved2
u32     pixel_data_offset
# BITMAPINFOHEADER follows
u32     dib_header_size
i32     width
i32     height
u16     color_planes
u16     bits_per_pixel
u32     compression
u32     image_size
i32     x_pixels_per_meter
i32     y_pixels_per_meter
u32     colors_used
u32     important_colors
`,
  },
  zip_local: {
    name: 'ZIP local file header',
    text: `# ZIP local file header (apply at start of any local entry — typically 0x00)
char[4] signature
u16     version_needed
u16     general_purpose_bitflag
u16     compression_method
u16     last_mod_time
u16     last_mod_date
u32     crc32
u32     compressed_size
u32     uncompressed_size
u16     filename_length
u16     extra_field_length
`,
  },
  wav_header: {
    name: 'WAV / RIFF header',
    text: `# WAV/RIFF file header (apply at offset 0x00)
char[4] riff_signature
u32     file_size_minus_8
char[4] wave_format
char[4] fmt_chunk_id
u32     fmt_chunk_size
u16     audio_format
u16     num_channels
u32     sample_rate
u32     byte_rate
u16     block_align
u16     bits_per_sample
char[4] data_chunk_id
u32     data_chunk_size
`,
  },
  pe_dos_header: {
    name: 'PE/EXE DOS header',
    text: `# DOS MZ header at the start of every PE/EXE file (apply at offset 0x00)
char[2] mz_signature
u16     bytes_in_last_block
u16     blocks_in_file
u16     num_relocs
u16     header_paragraphs
u16     min_extra_paragraphs
u16     max_extra_paragraphs
u16     ss_initial
u16     sp_initial
u16     checksum
u16     ip_initial
u16     cs_initial
u16     reloc_table_offset
u16     overlay_number
byte[32] reserved
u32     pe_header_offset
`,
  },
};

function injectStructuresUI() {
  const statusbar = document.getElementById('statusbar');
  if (!statusbar) return;

  const btn = document.createElement('button');
  btn.id = 'structuresBtn';
  btn.textContent = '🧩 Structures';
  btn.title = isPaid ? 'Apply a structure template to decode bytes as named fields' : 'Structure Templates — Pro feature';
  btn.addEventListener('click', () => {
    if (!isPaid) { extpay.openPaymentPage('hexdrop-pro'); return; }
    toggleStructuresPanel();
  });
  statusbar.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'structuresPanel';
  panel.innerHTML = `
    <div class="st-header">
      <span class="st-title">STRUCTURE TEMPLATES</span>
      <button id="structuresPanelClose" title="Close">✕</button>
    </div>
    <div class="st-body">
      <div class="st-controls">
        <select id="stPresetSelect" title="Load a built-in template">
          <option value="">— Quick presets —</option>
          ${Object.entries(STRUCT_PRESETS).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('')}
        </select>
        <button id="stApplyBtn" title="Apply template at currently-selected byte offset">▶ Apply at selection</button>
      </div>
      <div class="st-controls-secondary">
        <span id="stOffsetInfo" class="st-dim">Apply offset: select a byte first</span>
      </div>
      <textarea id="stTemplate" spellcheck="false" placeholder="One field per line:
u32:le  width
u32:le  height
char[8] magic
byte[4] padding

Types: u8 i8 u16 i16 u32 i32 u64 i64 f32 f64 char[N] byte[N]
Endian (optional, default LE): :le :be
Lines starting with # are comments."></textarea>
      <div class="st-decoded-header">DECODED FIELDS</div>
      <div class="st-decoded" id="stDecoded">
        <div class="st-empty">Pick a preset or type your own template, select a byte offset, then click ▶ Apply.</div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  document.getElementById('structuresPanelClose').addEventListener('click', () =>
    panel.classList.remove('open'));
  document.getElementById('stApplyBtn').addEventListener('click', applyStructureTemplate);
  document.getElementById('stPresetSelect').addEventListener('change', e => {
    const id = e.target.value;
    if (id && STRUCT_PRESETS[id]) {
      document.getElementById('stTemplate').value = STRUCT_PRESETS[id].text;
    }
  });

  // Auto-update offset hint when selection changes
  setInterval(updateStructureOffsetHint, 250);
}

function updateStructureOffsetHint() {
  const el = document.getElementById('stOffsetInfo');
  if (!el) return;
  const sel = currentSelection;
  if (sel.start >= 0) {
    el.textContent = `Apply at offset 0x${sel.start.toString(16).toUpperCase()} (${sel.start})`;
    el.classList.remove('st-dim');
  } else {
    el.textContent = 'Apply offset: select a byte first';
    el.classList.add('st-dim');
  }
}

function toggleStructuresPanel() {
  const panel = document.getElementById('structuresPanel');
  if (!panel) return;
  // Close other Pro panels
  document.getElementById('bookmarksPanel')?.classList.remove('open');
  document.getElementById('hashPanel')?.classList.remove('open');
  document.getElementById('annotationsPanel')?.classList.remove('open');
  document.getElementById('valueDecoderPanel')?.classList.remove('open');
  panel.classList.toggle('open');
  // Restore last template if any
  if (panel.classList.contains('open')) {
    chrome.storage.local.get('hexdrop_struct_template', data => {
      const ta = document.getElementById('stTemplate');
      if (ta && data.hexdrop_struct_template && !ta.value) {
        ta.value = data.hexdrop_struct_template;
      }
    });
  }
}

// Parse a template line into a field descriptor.
// Returns { type, endian, count, name } or { error: string } on bad line.
function parseStructLine(line) {
  const trimmed = line.replace(/#.*$/, '').trim();
  if (!trimmed) return null;  // Empty / comment-only line
  // Tokens: typeAndEndian + name
  const m = trimmed.match(/^(\S+)\s+(\S+.*)$/);
  if (!m) return { error: `bad line: "${line}"` };
  const typeToken = m[1];
  const name = m[2].trim();

  // Endianness suffix
  let endian = 'le';
  let typePart = typeToken;
  const endMatch = typeToken.match(/^(.+):(le|be)$/i);
  if (endMatch) {
    typePart = endMatch[1];
    endian = endMatch[2].toLowerCase();
  }

  // Array form: char[N] or byte[N]
  const arrMatch = typePart.match(/^(char|byte)\[(\d+)\]$/);
  if (arrMatch) {
    return { type: arrMatch[1], endian, count: parseInt(arrMatch[2], 10), name };
  }

  // Scalar types
  const SCALARS = ['u8','i8','u16','i16','u32','i32','u64','i64','f32','f64'];
  if (SCALARS.includes(typePart.toLowerCase())) {
    return { type: typePart.toLowerCase(), endian, count: 1, name };
  }

  return { error: `unknown type "${typePart}" in line: "${line}"` };
}

function structFieldByteSize(field) {
  switch (field.type) {
    case 'u8': case 'i8': return 1;
    case 'u16': case 'i16': return 2;
    case 'u32': case 'i32': case 'f32': return 4;
    case 'u64': case 'i64': case 'f64': return 8;
    case 'char': case 'byte': return field.count;
    default: return 0;
  }
}

function decodeStructField(field, view, byteOffset) {
  const le = field.endian === 'le';
  switch (field.type) {
    case 'u8':  return view.getUint8(byteOffset);
    case 'i8':  return view.getInt8(byteOffset);
    case 'u16': return view.getUint16(byteOffset, le);
    case 'i16': return view.getInt16(byteOffset, le);
    case 'u32': return view.getUint32(byteOffset, le);
    case 'i32': return view.getInt32(byteOffset, le);
    case 'u64': return view.getBigUint64(byteOffset, le).toString();
    case 'i64': return view.getBigInt64(byteOffset, le).toString();
    case 'f32': return formatFloat(view.getFloat32(byteOffset, le));
    case 'f64': return formatFloat(view.getFloat64(byteOffset, le));
    case 'char': {
      let s = '';
      for (let i = 0; i < field.count; i++) {
        const b = view.getUint8(byteOffset + i);
        if (b === 0) break;
        s += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '·';
      }
      return JSON.stringify(s);
    }
    case 'byte': {
      const arr = [];
      for (let i = 0; i < field.count; i++) {
        arr.push(view.getUint8(byteOffset + i).toString(16).toUpperCase().padStart(2, '0'));
      }
      return arr.join(' ');
    }
  }
  return '?';
}

function applyStructureTemplate() {
  const decoded = document.getElementById('stDecoded');
  if (!decoded) return;
  if (!currentFileBytes) {
    decoded.innerHTML = '<div class="st-error">No file loaded.</div>';
    return;
  }
  if (currentSelection.start < 0) {
    decoded.innerHTML = '<div class="st-error">Select a byte first to set the apply offset.</div>';
    return;
  }
  const tmplText = document.getElementById('stTemplate').value;
  if (!tmplText.trim()) {
    decoded.innerHTML = '<div class="st-error">Template is empty.</div>';
    return;
  }
  // Persist user's template across sessions
  chrome.storage.local.set({ hexdrop_struct_template: tmplText });

  const startOffset = currentSelection.start;
  const lines = tmplText.split('\n');
  const fields = [];
  const errors = [];
  for (const line of lines) {
    const parsed = parseStructLine(line);
    if (parsed === null) continue;
    if (parsed.error) errors.push(parsed.error);
    else fields.push(parsed);
  }

  if (errors.length > 0) {
    decoded.innerHTML = errors.map(e => `<div class="st-error">${escapeHtml(e)}</div>`).join('');
    return;
  }
  if (fields.length === 0) {
    decoded.innerHTML = '<div class="st-error">No valid fields in template.</div>';
    return;
  }

  // Compute total size + check we have enough bytes
  let total = 0;
  for (const f of fields) total += structFieldByteSize(f);
  const remainBytes = currentFileBytes.length - startOffset;
  if (total > remainBytes) {
    decoded.innerHTML = `<div class="st-error">Template needs ${total} bytes but only ${remainBytes} bytes remain after offset 0x${startOffset.toString(16).toUpperCase()}.</div>`;
    return;
  }

  // Build a DataView covering the needed range
  const slice = currentFileBytes.slice(startOffset, startOffset + total);
  const buf = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
  const view = new DataView(buf);

  let fieldOffset = 0;
  let html = `<div class="st-applied-info">Applied at 0x${startOffset.toString(16).toUpperCase()} · ${fields.length} fields · ${total} bytes total</div>`;
  html += `
    <div class="st-row st-row-hdr">
      <span class="st-foffset">OFFSET</span>
      <span class="st-ftype">TYPE</span>
      <span class="st-fname">NAME</span>
      <span class="st-fvalue">VALUE</span>
    </div>
  `;
  for (const f of fields) {
    const size = structFieldByteSize(f);
    const value = decodeStructField(f, view, fieldOffset);
    const absOffset = startOffset + fieldOffset;
    const typeDisplay = (f.count > 1 && (f.type === 'char' || f.type === 'byte'))
      ? `${f.type}[${f.count}]`
      : (f.type + (f.endian === 'be' && size > 1 ? ':be' : ''));
    html += `
      <div class="st-row">
        <button class="st-foffset st-jump" data-offset="${absOffset}" title="Jump to this field">0x${absOffset.toString(16).toUpperCase().padStart(8, '0')}</button>
        <span class="st-ftype">${typeDisplay}</span>
        <span class="st-fname">${escapeHtml(f.name)}</span>
        <span class="st-fvalue" title="${escapeHtml(String(value))}">${escapeHtml(String(value))}</span>
      </div>
    `;
    fieldOffset += size;
  }
  decoded.innerHTML = html;

  // Wire jump-to-field
  decoded.querySelectorAll('.st-jump').forEach(btn => {
    btn.addEventListener('click', () => {
      const off = parseInt(btn.dataset.offset, 10);
      const jumpInput = document.getElementById('jumpInput');
      const jumpBtn = document.getElementById('jumpBtn');
      const jumpMode = document.getElementById('jumpMode');
      if (jumpInput && jumpBtn) {
        if (jumpMode && jumpMode.textContent === 'DEC') jumpMode.click();
        jumpInput.value = off.toString(16).toUpperCase();
        jumpBtn.click();
      }
    });
  });
}

function exportDiffPatch() {
  if (!diffFileA.bytes || !diffFileB.bytes) {
    alert('Load both files in Diff Mode first.');
    return;
  }
  if (diffOffsets.length === 0) {
    alert('No differences to export.');
    return;
  }
  const a = diffFileA.bytes;
  const b = diffFileB.bytes;
  const lines = [
    '# HexDrop binary patch',
    `# Generated: ${new Date().toISOString()}`,
    `# Original (A): ${diffFileA.name}  (${a.length} bytes)`,
    `# Modified (B): ${diffFileB.name}  (${b.length} bytes)`,
    `# Differences: ${diffOffsets.length}`,
    '#',
    '# Format: OFFSET_HEX: OLD_HEX -> NEW_HEX',
    '#   OLD_HEX = "--" if byte exists only in B (B is longer)',
    '#   NEW_HEX = "--" if byte exists only in A (A is longer)',
    '',
  ];
  for (const off of diffOffsets) {
    const oldByte = (off < a.length) ? a[off].toString(16).toUpperCase().padStart(2, '0') : '--';
    const newByte = (off < b.length) ? b[off].toString(16).toUpperCase().padStart(2, '0') : '--';
    lines.push(`${off.toString(16).toUpperCase().padStart(8, '0')}: ${oldByte} -> ${newByte}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a_el = document.createElement('a');
  a_el.href = url;
  // Default filename: <a-stem>_to_<b-stem>.patch
  const stem = name => name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
  a_el.download = `${stem(diffFileA.name) || 'fileA'}_to_${stem(diffFileB.name) || 'fileB'}.patch`;
  document.body.appendChild(a_el);
  a_el.click();
  document.body.removeChild(a_el);
  URL.revokeObjectURL(url);
}
