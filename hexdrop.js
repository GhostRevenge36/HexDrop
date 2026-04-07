'use strict';

// ── Windows-1252 lookup for 0x80–0x9F (undefined slots → null) ───────────────
const CP1252_HIGH = [
  '\u20AC', null,    '\u201A', '\u0192', '\u201E', '\u2026', '\u2020', '\u2021',
  '\u02C6', '\u2030', '\u0160', '\u2039', '\u0152', null,    '\u017D', null,
  null,    '\u2018', '\u2019', '\u201C', '\u201D', '\u2022', '\u2013', '\u2014',
  '\u02DC', '\u2122', '\u0161', '\u203A', '\u0153', null,    '\u017E', '\u0178'
];
function cp1252Char(b) {
  if (b >= 0x20 && b < 0x7F)  return String.fromCharCode(b);   // standard ASCII
  if (b >= 0x80 && b <= 0x9F) return CP1252_HIGH[b - 0x80];    // CP1252 extras (may be null)
  if (b >= 0xA0)               return String.fromCharCode(b);   // Latin-1 upper half
  return null;                                                   // control characters
}

// ── State ────────────────────────────────────────────────────────────────────
const PAGE_BYTES = 16384; // bytes rendered per page
let fileBytes = null;     // Uint8Array of full file
let fileName  = '';
let colCount  = 16;
let encoding  = 'utf8';
let page      = 0;
let totalPages = 0;

let selectedStart = -1;
let selectedEnd   = -1;
let searchMatches = [];
let activeMatch   = -1;

// ── Element refs ─────────────────────────────────────────────────────────────
const dropzone    = document.getElementById('dropzone');
const fileInput   = document.getElementById('fileInput');
const toolbar     = document.getElementById('toolbar');
const searchbar   = document.getElementById('searchbar');
const viewer      = document.getElementById('viewer');
const statusbar   = document.getElementById('statusbar');
const hexTable    = document.getElementById('hexTable');
const filenameEl  = document.getElementById('filename');
const filesizeEl  = document.getElementById('filesize');
const colsSel     = document.getElementById('cols');
const encodingSel = document.getElementById('encoding');
const exportBtn   = document.getElementById('exportBtn');
const searchInput = document.getElementById('searchInput');
const searchInfo  = document.getElementById('searchInfo');
const prevMatchBtn = document.getElementById('prevMatch');
const nextMatchBtn = document.getElementById('nextMatch');
const clearSearch = document.getElementById('clearSearch');
const offsetInfo  = document.getElementById('offsetInfo');
const selInfo     = document.getElementById('selectionInfo');
const byteInfo    = document.getElementById('byteInfo');
const pageInfoEl  = document.getElementById('pageInfo');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const jumpInput   = document.getElementById('jumpInput');
const jumpBtn     = document.getElementById('jumpBtn');
const jumpMode    = document.getElementById('jumpMode');
const searchMode  = document.getElementById('searchMode');

// ── Jump mode state (HEX or DEC address) ─────────────────────────────────────
let jumpIsHex = true;
jumpMode.addEventListener('click', () => {
  jumpIsHex = !jumpIsHex;
  jumpMode.textContent = jumpIsHex ? 'HEX' : 'DEC';
  jumpMode.title = jumpIsHex
    ? 'Currently: Hex address (e.g. 1C). Click to switch to Decimal.'
    : 'Currently: Decimal address (e.g. 28). Click to switch to Hex.';
  jumpInput.placeholder = jumpIsHex ? 'e.g. 1C' : 'e.g. 28';
});

// ── Search mode state (HEX or DEC value) ──────────────────────────────────────
let searchIsHex = true;
searchMode.addEventListener('click', () => {
  searchIsHex = !searchIsHex;
  searchMode.textContent = searchIsHex ? 'HEX' : 'DEC';
  searchMode.title = searchIsHex
    ? 'Currently: Hex values (e.g. 4D 5A). Click to switch to Decimal.'
    : 'Currently: Decimal values (e.g. 77 90). Click to switch to Hex.';
  searchInput.placeholder = searchIsHex
    ? 'Hex bytes (e.g. 4D 5A) or ASCII text…'
    : 'Decimal byte values (e.g. 128 or 77 90 0)…';
  searchInput.value = '';
  doSearch();
});
const copyHexBtn  = document.getElementById('copyHexBtn');
const copyTextBtn = document.getElementById('copyTextBtn');

// ── File loading ─────────────────────────────────────────────────────────────
function loadFile(file) {
  const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
  if (file.size > MAX_BYTES) {
    alert(`"${file.name}" is ${fmtSize(file.size)}.\nHexDrop supports files up to 100 MB.`);
    return;
  }
  fileName = file.name;
  const reader = new FileReader();
  reader.onerror = () => {
    alert(`Could not read "${file.name}".\nThe file may be locked or inaccessible.`);
  };
  reader.onload = e => {
    fileBytes = new Uint8Array(e.target.result);
    page = 0;
    totalPages = Math.max(1, Math.ceil(fileBytes.length / PAGE_BYTES));
    searchMatches = [];
    activeMatch = -1;
    selectedStart = -1;
    selectedEnd = -1;

    filenameEl.textContent = fileName;
    filenameEl.title = fileName; // show full name on hover when truncated
    filesizeEl.textContent = fmtSize(fileBytes.length);
    toolbar.style.display = 'flex';
    searchbar.style.display = 'flex';
    statusbar.style.display = 'flex';
    dropzone.style.display  = 'none';
    viewer.style.display    = 'block';

    render();
  };
  reader.readAsArrayBuffer(file);
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  t.addEventListener('animationend', () => t.remove());
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function render() {
  // Handle empty file
  if (fileBytes.length === 0) {
    hexTable.innerHTML = '<div class="empty-msg">File is empty (0 bytes)</div>';
    pageInfoEl.textContent = '';
    prevPageBtn.disabled = true;
    nextPageBtn.disabled = true;
    updateStatus();
    return;
  }

  const cols = colCount;
  const start = page * PAGE_BYTES;
  const end   = Math.min(start + PAGE_BYTES, fileBytes.length);
  const slice = fileBytes.slice(start, end);

  // build match offset set for fast lookup
  // matches are sorted by offset so we can skip and break early
  const matchOffsets = new Set();
  const activeOffsets = new Set();
  for (let mi = 0; mi < searchMatches.length; mi++) {
    const m = searchMatches[mi];
    if (m.offset + m.len <= start) continue; // match ends before this page
    if (m.offset >= end) break;              // match starts after this page; all subsequent do too
    for (let k = 0; k < m.len; k++) {
      const abs = m.offset + k;
      if (abs >= start && abs < end) {
        if (mi === activeMatch) activeOffsets.add(abs - start);
        else matchOffsets.add(abs - start);
      }
    }
  }

  const selMin = selectedStart === -1 ? -1 : (Math.min(selectedStart, selectedEnd) - start);
  const selMax = selectedStart === -1 ? -1 : (Math.max(selectedStart, selectedEnd) - start);

  const rows = [];
  for (let i = 0; i < slice.length; i += cols) {
    const absAddr = start + i;
    const rowBytes = slice.subarray(i, i + cols);
    const even = ((absAddr / cols) % 2 === 0);

    // Address column
    const addrStr = absAddr.toString(16).toUpperCase().padStart(8, '0');

    // Hex bytes
    let hexHtml = '';
    for (let j = 0; j < cols; j++) {
      if (j === cols / 2) hexHtml += `<span class="gap"></span>`;
      if (j < rowBytes.length) {
        const b = rowBytes[j];
        const relIdx = i + j;
        const cls = byteClass(b, relIdx, selMin, selMax, matchOffsets, activeOffsets);
        hexHtml += `<span class="byte ${cls}" data-i="${start + relIdx}">${b.toString(16).toUpperCase().padStart(2,'0')}</span>`;
      } else {
        hexHtml += `<span class="byte">&nbsp;&nbsp;</span>`;
      }
    }

    // ASCII column — encoding-aware
    const ascHtml = buildAsciiHtml(rowBytes, i, start, selMin, selMax, matchOffsets, activeOffsets);

    rows.push(`
      <div class="hex-row${even ? ' even' : ''}">
        <span class="addr">${addrStr}</span>
        <div class="hex-bytes">${hexHtml}</div>
        <div class="ascii-col">${ascHtml}</div>
      </div>`);
  }

  // Column offset header
  const isWide = (encoding === 'utf16le' || encoding === 'utf16be');
  let headerHex = '', headerAsc = '';
  for (let j = 0; j < cols; j++) {
    if (j === cols / 2) headerHex += `<span class="gap"></span>`;
    headerHex += `<span class="byte col-hdr">${j.toString(16).toUpperCase().padStart(2,'0')}</span>`;
  }
  const ascHdrFmt = j => cols > 16
    ? j.toString(16).toUpperCase().padStart(2, '0')
    : (j & 0xF).toString(16).toUpperCase();
  if (isWide) {
    for (let j = 0; j < cols; j += 2)
      headerAsc += `<span class="achar wide col-hdr">${ascHdrFmt(j)}</span>`;
  } else {
    for (let j = 0; j < cols; j++)
      headerAsc += `<span class="achar col-hdr">${ascHdrFmt(j)}</span>`;
  }
  const header = `<div class="hex-row hdr-row">
    <span class="addr col-hdr">Offset</span>
    <div class="hex-bytes">${headerHex}</div>
    <div class="ascii-col">${headerAsc}</div>
  </div>`;

  hexTable.innerHTML = header + rows.join('');

  // Pagination
  pageInfoEl.textContent = `Page ${page + 1} / ${totalPages}`;
  prevPageBtn.disabled = (page === 0);
  nextPageBtn.disabled = (page >= totalPages - 1);

  updateStatus();
}

function byteClass(b, relIdx, selMin, selMax, matchOffsets, activeOffsets) {
  const classes = [];
  if (activeOffsets.has(relIdx)) classes.push('match-active');
  else if (matchOffsets.has(relIdx)) classes.push('match');
  if (selMin !== -1 && relIdx >= selMin && relIdx <= selMax) classes.push('selected');
  if (b === 0) classes.push('null');
  else if (b >= 0x20 && b < 0x7f) classes.push('printable');
  else if (b > 0x7f) classes.push('high');
  return classes.join(' ');
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Merge highlight classes for multi-byte characters (pick highest priority)
function mergeClasses(a, b) {
  for (const p of ['match-active', 'match', 'selected']) {
    if (a.includes(p) || b.includes(p)) return p;
  }
  if (a.includes('null') && b.includes('null')) return 'null';
  if (a.includes('printable') || b.includes('printable')) return 'printable';
  if (a.includes('high') || b.includes('high')) return 'high';
  return '';
}

// Build encoding-aware ASCII column HTML for one row
function buildAsciiHtml(rowBytes, rowRelStart, pageStart, selMin, selMax, matchOffsets, activeOffsets) {
  const bytes = Array.from(rowBytes);
  let html = '';

  if (encoding === 'utf16le' || encoding === 'utf16be') {
    // Two bytes → one wide character cell; four bytes for surrogate pairs
    for (let j = 0; j < bytes.length; j += 2) {
      const b0 = bytes[j];
      const b1 = (j + 1 < bytes.length) ? bytes[j + 1] : 0;
      const cu0 = (encoding === 'utf16le') ? (b0 | (b1 << 8)) : ((b0 << 8) | b1);
      const ri0 = rowRelStart + j;
      const ri1 = rowRelStart + j + 1;
      const cls0 = byteClass(b0, ri0, selMin, selMax, matchOffsets, activeOffsets);
      const cls1 = (j + 1 < bytes.length) ? byteClass(b1, ri1, selMin, selMax, matchOffsets, activeOffsets) : '';
      const cls  = mergeClasses(cls0, cls1);

      // Surrogate pair: high surrogate 0xD800–0xDBFF followed by low 0xDC00–0xDFFF
      if (cu0 >= 0xD800 && cu0 <= 0xDBFF && j + 3 < bytes.length) {
        const b2 = bytes[j + 2], b3 = bytes[j + 3];
        const cu1 = (encoding === 'utf16le') ? (b2 | (b3 << 8)) : ((b2 << 8) | b3);
        if (cu1 >= 0xDC00 && cu1 <= 0xDFFF) {
          const cp   = 0x10000 + ((cu0 - 0xD800) << 10) + (cu1 - 0xDC00);
          const ch   = escHtml(String.fromCodePoint(cp));
          const ri2  = rowRelStart + j + 2, ri3 = rowRelStart + j + 3;
          const cls2 = byteClass(b2, ri2, selMin, selMax, matchOffsets, activeOffsets);
          const cls3 = byteClass(b3, ri3, selMin, selMax, matchOffsets, activeOffsets);
          const cls23 = mergeClasses(cls2, cls3);
          html += `<span class="achar wide ${cls}" data-i="${pageStart + ri0}">${ch}</span>`;
          html += `<span class="achar wide cont ${cls23}" data-i="${pageStart + ri2}">▸▸</span>`;
          j += 2; // consume extra 2 bytes (loop adds 2 more)
          continue;
        }
      }

      let ch;
      if      (cu0 === 0)                                              ch = '<span class="w16-null">∅</span>';
      else if (cu0 === 0x000A || cu0 === 0x000D)                      ch = '↵';
      else if (cu0 >= 0x20 && cu0 < 0xFFFE && cu0 !== 0x7F
               && !(cu0 >= 0xD800 && cu0 <= 0xDFFF))                  ch = escHtml(String.fromCodePoint(cu0));
      else                                                             ch = '·';

      html += `<span class="achar wide ${cls}" data-i="${pageStart + ri0}">${ch}</span>`;
    }

  } else if (encoding === 'utf8') {
    // Variable-length UTF-8 sequences
    let j = 0;
    while (j < bytes.length) {
      const b = bytes[j];
      let seqLen = 1;
      if      ((b & 0xF8) === 0xF0 && b <= 0xF4) seqLen = 4;
      else if ((b & 0xF0) === 0xE0)               seqLen = 3;
      else if ((b & 0xE0) === 0xC0 && b >= 0xC2)  seqLen = 2;
      seqLen = Math.min(seqLen, bytes.length - j);

      const ri  = rowRelStart + j;
      const cls = byteClass(b, ri, selMin, selMax, matchOffsets, activeOffsets);

      let ch;
      if (seqLen === 1) {
        ch = (b >= 0x20 && b < 0x7F) ? escHtml(String.fromCharCode(b)) : '·';
      } else {
        try {
          const dec = new TextDecoder('utf-8', { fatal: true });
          const s   = dec.decode(new Uint8Array(bytes.slice(j, j + seqLen)));
          ch = s.length ? escHtml(String.fromCodePoint(s.codePointAt(0))) : '·';
        } catch { ch = '·'; seqLen = 1; }
      }

      const extraCls = seqLen > 1 ? ' u8lead' : '';
      html += `<span class="achar${extraCls} ${cls}" data-i="${pageStart + ri}">${ch}</span>`;

      // Dim continuation bytes (▸ marker, still selectable)
      for (let k = 1; k < seqLen; k++) {
        const cri  = rowRelStart + j + k;
        const ccls = byteClass(bytes[j + k], cri, selMin, selMax, matchOffsets, activeOffsets);
        html += `<span class="achar cont ${ccls}" data-i="${pageStart + cri}">▸</span>`;
      }
      j += seqLen;
    }

  } else if (encoding === 'cp1252') {
    // Windows-1252: Latin-1 + printable chars in 0x80–0x9F range
    for (let j = 0; j < bytes.length; j++) {
      const b   = bytes[j];
      const ri  = rowRelStart + j;
      const cls = byteClass(b, ri, selMin, selMax, matchOffsets, activeOffsets);
      const c   = cp1252Char(b);
      let extra = '';
      if (b >= 0x80 && b <= 0x9F && c) extra = ' lat';  // highlight CP1252 extras
      else if (b >= 0xA0 && c)         extra = ' lat';  // highlight extended Latin
      const ch  = c ? escHtml(c) : '·';
      html += `<span class="achar${extra} ${cls}" data-i="${pageStart + ri}">${ch}</span>`;
    }

  } else {
    // ASCII (default): 0x20–0x7E printable only
    for (let j = 0; j < bytes.length; j++) {
      const b   = bytes[j];
      const ri  = rowRelStart + j;
      const cls = byteClass(b, ri, selMin, selMax, matchOffsets, activeOffsets);
      const ch  = (b >= 0x20 && b < 0x7F) ? escHtml(String.fromCharCode(b)) : '·';
      html += `<span class="achar ${cls}" data-i="${pageStart + ri}">${ch}</span>`;
    }
  }
  return html;
}

// ── Selection ─────────────────────────────────────────────────────────────────
let mouseDown = false;
let anchorIdx = -1;

hexTable.addEventListener('mousedown', e => {
  const t = e.target.closest('[data-i]');
  if (!t) return;
  anchorIdx = +t.dataset.i;
  selectedStart = anchorIdx;
  selectedEnd   = anchorIdx;
  mouseDown = true;
  render();
  e.preventDefault();
});

hexTable.addEventListener('mousemove', e => {
  if (!mouseDown) return;
  const t = e.target.closest('[data-i]');
  if (!t) return;
  selectedEnd = +t.dataset.i;
  render();
});

window.addEventListener('mouseup', () => { mouseDown = false; });

// ── Status bar update ─────────────────────────────────────────────────────────
function updateStatus() {
  if (selectedStart === -1) {
    offsetInfo.textContent = 'Offset: —';
    selInfo.textContent = '';
    byteInfo.textContent = '';
    copyHexBtn.style.display = 'none';
    copyTextBtn.style.display = 'none';
    return;
  }
  const lo = Math.min(selectedStart, selectedEnd);
  const hi = Math.max(selectedStart, selectedEnd);
  offsetInfo.textContent = `Offset: 0x${lo.toString(16).toUpperCase()} (${lo})`;
  const len = hi - lo + 1;
  if (len > 1) {
    selInfo.textContent = `Selected: ${len} bytes (0x${len.toString(16).toUpperCase()})`;
    const sel = fileBytes.slice(lo, hi + 1);
    byteInfo.textContent = tryDecode(sel);
  } else {
    const b = fileBytes[lo];
    const ch = (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '·';
    byteInfo.textContent = `Hex: 0x${b.toString(16).toUpperCase().padStart(2,'0')}  |  Char: '${ch}'  |  Dec: ${b}`;
    selInfo.textContent = '';
  }
  copyHexBtn.style.display = '';
  copyTextBtn.style.display = '';
}

function tryDecode(bytes) {
  try {
    const label = encoding === 'utf8'    ? 'utf-8'       :
                  encoding === 'utf16le' ? 'utf-16le'    :
                  encoding === 'utf16be' ? 'utf-16be'    :
                  encoding === 'cp1252'  ? 'windows-1252':
                  /* ascii */              'windows-1252'; // ASCII is a subset; TextDecoder has no strict ASCII label
    const dec = new TextDecoder(label, { fatal: true });
    const s   = dec.decode(bytes);
    return `→ "${s.length > 60 ? s.slice(0, 60) + '…' : s}"`;
  } catch { return ''; }
}

// ── KMP search ────────────────────────────────────────────────────────────────
const MAX_SEARCH_RESULTS = 50000;

function kmpSearch(haystack, needle) {
  const results = [];
  if (!needle.length) return results;
  // Build failure table
  const fail = new Int32Array(needle.length);
  for (let i = 1, k = 0; i < needle.length; i++) {
    while (k > 0 && needle[k] !== needle[i]) k = fail[k - 1];
    if (needle[k] === needle[i]) k++;
    fail[i] = k;
  }
  // Search — stop early if cap is reached to avoid building a huge array
  for (let i = 0, k = 0; i < haystack.length; i++) {
    while (k > 0 && needle[k] !== haystack[i]) k = fail[k - 1];
    if (needle[k] === haystack[i]) k++;
    if (k === needle.length) {
      results.push({ offset: i - needle.length + 1, len: needle.length });
      k = fail[k - 1];
      if (results.length >= MAX_SEARCH_RESULTS) break;
    }
  }
  return results;
}

// ── Search ────────────────────────────────────────────────────────────────────
function doSearch() {
  const q = searchInput.value.trim();
  searchMatches = [];
  activeMatch = -1;
  if (!q || !fileBytes) { searchInfo.textContent = ''; render(); return; }

  let pattern;

  if (!searchIsHex) {
    // DEC mode: space-separated decimal byte values 0–255
    const decTokens = q.replace(/\s+/g, ' ').split(' ').map(t => t.trim()).filter(Boolean);
    const allDec = decTokens.every(t => /^\d+$/.test(t));
    if (!allDec) {
      searchInfo.textContent = 'DEC mode: enter numbers 0–255';
      render();
      return;
    }
    const vals = decTokens.map(t => parseInt(t, 10));
    if (vals.some(v => v < 0 || v > 255)) {
      searchInfo.textContent = 'Values must be 0–255';
      render();
      return;
    }
    pattern = new Uint8Array(vals);
  } else {
    // HEX / ASCII mode
    // Detect hex pattern: tokens like "4D 5A" or "4D5A"
    const hexTokens = q.replace(/\s+/g, ' ').split(' ').map(t => t.trim()).filter(Boolean);
    const isHex = hexTokens.every(t => /^[0-9a-fA-F]{1,2}$/.test(t));
    if (isHex && hexTokens.some(t => t.length === 2)) {
      pattern = new Uint8Array(hexTokens.map(t => parseInt(t, 16)));
    } else {
      // ASCII / text search
      const enc = new TextEncoder();
      pattern = enc.encode(q);
    }
  }

  searchMatches = kmpSearch(fileBytes, pattern);

  const capped = searchMatches.length >= MAX_SEARCH_RESULTS;
  const count  = searchMatches.length;
  if (!count) {
    searchInfo.textContent = 'No matches';
    render();
  } else {
    searchInfo.textContent = capped
      ? `${count.toLocaleString()}+ matches`
      : `${count.toLocaleString()} match${count > 1 ? 'es' : ''}`;
    jumpToMatch(0);
  }
}

function jumpToMatch(idx) {
  if (!searchMatches.length) return;
  activeMatch = ((idx % searchMatches.length) + searchMatches.length) % searchMatches.length;
  const m = searchMatches[activeMatch];
  const targetPage = Math.floor(m.offset / PAGE_BYTES);
  if (page !== targetPage) { page = targetPage; }
  render();
  // Scroll to the row containing the match
  const rowEl = hexTable.querySelector(`[data-i="${m.offset}"]`);
  if (rowEl) rowEl.closest('.hex-row')?.scrollIntoView({ block: 'center' });
  searchInfo.textContent = `${activeMatch + 1} / ${searchMatches.length}`;
}

searchInput.addEventListener('input', doSearch);
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); jumpToMatch(activeMatch + (e.shiftKey ? -1 : 1)); }
  if (e.key === 'Escape') { searchInput.value = ''; doSearch(); }
});

// Ctrl+F / Cmd+F focuses search; Page Up/Down navigates pages
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && fileBytes) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  if (!fileBytes) return;
  const active = document.activeElement;
  if (active === searchInput || active === jumpInput) return;
  if (e.key === 'PageDown') { e.preventDefault(); if (page < totalPages - 1) { page++; render(); } }
  if (e.key === 'PageUp')   { e.preventDefault(); if (page > 0) { page--; render(); } }
});
nextMatchBtn.addEventListener('click', () => jumpToMatch(activeMatch + 1));
prevMatchBtn.addEventListener('click', () => jumpToMatch(activeMatch - 1));
clearSearch.addEventListener('click', () => { searchInput.value = ''; doSearch(); });

// ── Jump to offset ─────────────────────────────────────────────────────────────
function jumpToOffset() {
  if (!fileBytes) return;
  const raw = jumpInput.value.trim();
  // Always parse as hex when mode is HEX, or when user typed 0x prefix.
  const forceHex = /^0x/i.test(raw);
  const val = (jumpIsHex || forceHex)
    ? parseInt(raw.replace(/^0x/i, ''), 16)
    : parseInt(raw, 10);
  if (isNaN(val) || val < 0 || val >= fileBytes.length) {
    jumpInput.classList.add('invalid');
    setTimeout(() => jumpInput.classList.remove('invalid'), 600);
    return;
  }
  page = Math.floor(val / PAGE_BYTES);
  selectedStart = val;
  selectedEnd   = val;
  render();
  const rowEl = hexTable.querySelector(`[data-i="${val}"]`);
  if (rowEl) rowEl.closest('.hex-row')?.scrollIntoView({ block: 'center' });
}
jumpBtn.addEventListener('click', jumpToOffset);
jumpInput.addEventListener('keydown', e => { if (e.key === 'Enter') jumpToOffset(); });

// ── Copy to clipboard ─────────────────────────────────────────────────────────
function copySelection(asHex) {
  if (selectedStart === -1 || !fileBytes) return;
  const lo  = Math.min(selectedStart, selectedEnd);
  const hi  = Math.max(selectedStart, selectedEnd);
  const sel = fileBytes.slice(lo, hi + 1);

  // Warn before producing a giant string — hex output is 3× the byte count
  const COPY_WARN = 1024 * 1024; // 1 MB
  if (asHex && sel.length > COPY_WARN) {
    if (!confirm(`Copy ${fmtSize(sel.length)} as hex text (~${fmtSize(sel.length * 3)})?\nThis may take a moment.`)) return;
  }

  let text;
  if (asHex) {
    text = Array.from(sel).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  } else {
    const label = encoding === 'utf8'    ? 'utf-8'        :
                  encoding === 'utf16le' ? 'utf-16le'     :
                  encoding === 'utf16be' ? 'utf-16be'     :
                  encoding === 'cp1252'  ? 'windows-1252' :
                                           'windows-1252';
    try { text = new TextDecoder(label, { fatal: false }).decode(sel); }
    catch { text = Array.from(sel).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join(''); }
  }

  const done = () => showToast('Copied!');
  navigator.clipboard.writeText(text).then(done).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    done();
  });
}
copyHexBtn.addEventListener('click', () => copySelection(true));
copyTextBtn.addEventListener('click', () => copySelection(false));

// ── Export ─────────────────────────────────────────────────────────────────────
const exportMenu = document.getElementById('exportMenu');
const EXPORT_WARN = 5 * 1024 * 1024; // 5 MB

// Toggle dropdown
exportBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (!fileBytes) return;
  exportMenu.classList.toggle('open');
});

// Close on click outside
document.addEventListener('click', () => exportMenu.classList.remove('open'));

// Shared download helper — avoids repeated blob/anchor boilerplate
function downloadText(chunks, suffix, type = 'text/plain') {
  const blob = new Blob(chunks, { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') + suffix;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Option 1: Hex Dump (address + hex bytes + ASCII — industry standard) ──────
document.getElementById('exportDump').addEventListener('click', () => {
  exportMenu.classList.remove('open');
  if (!fileBytes) return;
  if (fileBytes.length > EXPORT_WARN) {
    if (!confirm(`Export ${fmtSize(fileBytes.length)} as hex dump?\nThe output file will be roughly 4× the file size.`)) return;
  }
  const cols = colCount;
  const lines = [];
  for (let i = 0; i < fileBytes.length; i += cols) {
    const addr     = i.toString(16).toUpperCase().padStart(8, '0');
    const rowBytes = fileBytes.slice(i, Math.min(i + cols, fileBytes.length));
    const hex      = Array.from(rowBytes).map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
    const asc      = Array.from(rowBytes).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
    lines.push(`${addr}  ${hex.padEnd(cols * 3 - 1)}  ${asc}\n`);
  }
  downloadText(lines, '_hexdump.txt');
  showToast('Hex Dump exported');
});

// ── Option 2: Hex Only (raw bytes as hex — paste into scripts / tools) ─────────
document.getElementById('exportHex').addEventListener('click', () => {
  exportMenu.classList.remove('open');
  if (!fileBytes) return;
  if (fileBytes.length > EXPORT_WARN) {
    if (!confirm(`Export ${fmtSize(fileBytes.length)} as hex text?\nThis may take a moment.`)) return;
  }
  const lines = [];
  for (let i = 0; i < fileBytes.length; i += 16) {
    const row = fileBytes.slice(i, Math.min(i + 16, fileBytes.length));
    lines.push(Array.from(row).map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ') + '\n');
  }
  downloadText(lines, '_hex.txt');
  showToast('Hex Only exported');
});

// ── Option 3: Decoded Text (readable strings in current encoding) ──────────────
document.getElementById('exportText').addEventListener('click', () => {
  exportMenu.classList.remove('open');
  if (!fileBytes) return;
  const label = encoding === 'utf8'    ? 'utf-8'        :
                encoding === 'utf16le' ? 'utf-16le'     :
                encoding === 'utf16be' ? 'utf-16be'     :
                encoding === 'cp1252'  ? 'windows-1252' :
                                         'windows-1252';
  let text;
  try {
    text = new TextDecoder(label, { fatal: false }).decode(fileBytes);
  } catch {
    text = Array.from(fileBytes).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
  }
  const encSuffix = { utf8:'utf8', utf16le:'utf16le', utf16be:'utf16be', cp1252:'cp1252', ascii:'ascii' }[encoding] || 'txt';
  downloadText([text], `_decoded_${encSuffix}.txt`);
  const encLabel = { utf8:'UTF-8', utf16le:'UTF-16 LE', utf16be:'UTF-16 BE', cp1252:'Windows-1252', ascii:'ASCII' }[encoding] || encoding;
  showToast(`Decoded Text exported (${encLabel})`);
});

// ── Option 4: Save as PDF (print-ready hex dump via browser print dialog) ──────
document.getElementById('exportPdf').addEventListener('click', () => {
  exportMenu.classList.remove('open');
  if (!fileBytes) return;

  const PDF_WARN = 2 * 1024 * 1024; // 2 MB — PDFs from large files can be huge
  if (fileBytes.length > PDF_WARN) {
    if (!confirm(`Generate PDF for ${fmtSize(fileBytes.length)}?\nLarge files produce many pages — consider exporting a specific range instead.`)) return;
  }

  const cols = colCount;
  const rows = [];
  for (let i = 0; i < fileBytes.length; i += cols) {
    const addr     = i.toString(16).toUpperCase().padStart(8, '0');
    const rowBytes = fileBytes.slice(i, Math.min(i + cols, fileBytes.length));
    const hex      = Array.from(rowBytes).map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
    const asc      = Array.from(rowBytes).map(b => (b >= 0x20 && b < 0x7f)
      ? b === 60 ? '&lt;' : b === 62 ? '&gt;' : b === 38 ? '&amp;' : String.fromCharCode(b)
      : '<span class="dot">·</span>').join('');
    const gap      = cols > 8 ? hex.slice(0, cols * 1.5 - 1) : hex; // mid-gap for wide rows
    rows.push(`<tr><td class="addr">${addr}</td><td class="hex">${hex}</td><td class="asc">${asc}</td></tr>`);
  }

  const encName = { utf8:'UTF-8', utf16le:'UTF-16 LE', utf16be:'UTF-16 BE', cp1252:'Windows-1252', ascii:'ASCII' }[encoding] || encoding;
  const now     = new Date().toLocaleString();
  const safeFileName = fileName.replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>HexDrop — ${safeFileName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Courier New', Courier, monospace;
    font-size: 10px;
    color: #1a1a1a;
    background: #fff;
    padding: 18px 20px;
  }
  .doc-header {
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 2px solid #1a1a1a;
  }
  .doc-title {
    font-size: 15px;
    font-weight: bold;
    letter-spacing: 0.04em;
    margin-bottom: 4px;
  }
  .doc-meta {
    font-size: 9px;
    color: #555;
    letter-spacing: 0.03em;
  }
  .doc-meta span { margin-right: 18px; }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 10px;
    line-height: 1.55;
  }
  thead tr {
    border-bottom: 1px solid #aaa;
  }
  thead td {
    font-weight: bold;
    padding: 2px 6px 4px;
    color: #555;
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  tbody tr:nth-child(even) { background: #f5f5f5; }
  td { padding: 1px 6px; white-space: pre; vertical-align: top; }
  td.addr { color: #555; width: 90px; }
  td.hex  { color: #1a1a1a; letter-spacing: 0.05em; }
  td.asc  { color: #333; border-left: 1px solid #ddd; padding-left: 10px; letter-spacing: 0.03em; }
  .dot    { color: #bbb; }
  .doc-footer {
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid #ccc;
    font-size: 8px;
    color: #999;
    letter-spacing: 0.04em;
  }
  @media print {
    body { padding: 0; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="doc-header">
  <div class="doc-title">HexDrop — ${safeFileName}</div>
  <div class="doc-meta">
    <span>Size: ${fmtSize(fileBytes.length)} (${fileBytes.length.toLocaleString()} bytes)</span>
    <span>Encoding: ${encName}</span>
    <span>Columns: ${cols}</span>
    <span>Exported: ${now}</span>
  </div>
</div>
<table>
  <thead><tr><td>Offset</td><td>Hex Bytes</td><td>ASCII</td></tr></thead>
  <tbody>${rows.join('')}</tbody>
</table>
<div class="doc-footer">Generated by HexDrop &mdash; No data leaves your device</div>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) { showToast('Allow popups to save PDF'); return; }
  win.document.write(html);
  win.document.close();
  // Small delay lets the page render before the print dialog opens
  setTimeout(() => { win.focus(); win.print(); }, 400);
  showToast('PDF — choose Save as PDF in the dialog');
});

// ── Controls ──────────────────────────────────────────────────────────────────
colsSel.addEventListener('change', () => { colCount = +colsSel.value; render(); });
encodingSel.addEventListener('change', () => { encoding = encodingSel.value; render(); });
prevPageBtn.addEventListener('click', () => { if (page > 0) { page--; render(); } });
nextPageBtn.addEventListener('click', () => { if (page < totalPages - 1) { page++; render(); } });

// ── Drag & drop ───────────────────────────────────────────────────────────────
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});
dropzone.addEventListener('click', e => {
  // Don't double-trigger when the label inside the dropzone is clicked
  if (!e.target.closest('label')) fileInput.click();
});

// Allow dragging a new file onto the viewer area after a file is already loaded
// (the dropzone is hidden at that point, so we handle it at the window level)
window.addEventListener('dragover', e => { if (fileBytes) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!fileBytes) return; // dropzone handles the first load
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
  fileInput.value = ''; // allow re-selecting the same file
});

// ── Help overlay ───────────────────────────────────────────────────────────────
const helpOverlay = document.getElementById('helpOverlay');
const helpClose   = document.getElementById('helpClose');
const helpGotIt   = document.getElementById('helpGotIt');
const helpNoShow  = document.getElementById('helpNoShow');
const helpBtn     = document.getElementById('helpBtn');
const HELP_KEY    = 'hexdrop_help_seen';

function showHelp() {
  helpOverlay.classList.add('visible');
}
function hideHelp() {
  if (helpNoShow.checked) {
    localStorage.setItem(HELP_KEY, '1');
  }
  helpOverlay.classList.remove('visible');
}

helpClose.addEventListener('click', hideHelp);
helpGotIt.addEventListener('click', hideHelp);
helpBtn.addEventListener('click', () => {
  helpNoShow.checked = false; // reset checkbox when manually opened
  showHelp();
});
// Close on click outside the panel
helpOverlay.addEventListener('click', e => {
  if (e.target === helpOverlay) hideHelp();
});

// Show on first open only
if (!localStorage.getItem(HELP_KEY)) {
  showHelp();
}
