# HexDrop — Hex Viewer & Binary File Inspector

A Chrome extension for viewing any file as hex, ASCII, and decoded text. Built for developers, game modders, reverse engineers, and CTF players. Runs 100% offline — nothing leaves your device.

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Pending%20Review-yellow)](https://chromewebstore.google.com)
![Manifest Version](https://img.shields.io/badge/Manifest-V3-blue)
![Zero Permissions](https://img.shields.io/badge/Permissions-None-brightgreen)
![No Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen)

---

## Features

- **Drop any file** — drag and drop to instantly view hex + ASCII side by side
- **Byte-level inspection** — click any byte to see its hex, decimal, and character value
- **Search** — find hex patterns or ASCII strings using KMP algorithm (handles 50,000+ matches on 100MB files)
- **DEC mode search** — search by decimal byte value, not just hex
- **Jump to address** — navigate directly to any byte offset in hex or decimal
- **Multi-encoding support** — UTF-8 (with emoji), UTF-16 LE/BE (surrogate pairs), Windows-1252, ASCII
- **Column width** — switch between 8, 16, and 32 bytes per row
- **Export** — Hex Dump, Hex Only, Decoded Text, or Save as PDF
- **Paged rendering** — handles files up to 100MB without freezing (16KB pages)
- **Zero permissions** — no tabs, no host access, no browsing history, no network calls

---

## Screenshots

> Coming soon — see Chrome Web Store listing

---

## Technical Highlights

| Feature | Implementation |
|---------|---------------|
| Search algorithm | KMP (Knuth-Morris-Pratt) — O(n+m) |
| Large file handling | Paged virtual rendering, 16KB/page |
| UTF-16 | Full surrogate pair support |
| Windows-1252 | Complete 0x80–0x9F lookup table |
| Export | Blob array construction (avoids single giant string join) |
| Manifest | Version 3, zero permissions |

---

## Install

**Chrome Web Store:** Pending review — link will be updated on approval.

**Load unpacked (for developers):**
1. Download or clone this repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer Mode** (top right)
4. Click **Load unpacked** → select this folder

---

## Project Structure

```
hexdrop/
  manifest.json       — MV3 manifest, zero permissions
  popup.html/js       — extension popup (opens viewer)
  viewer.html         — full-screen hex viewer UI
  hexdrop.js          — all viewer logic (~1,200 lines)
  style.css           — amber phosphor terminal theme
  icons/              — 16, 32, 48, 128px icons
  screenshots/        — store screenshots
  test-files/         — sample binary files for testing
  icon-generator.html — canvas-based icon generation tool
```

---

## Built With

Pure vanilla JavaScript. Zero dependencies. Zero frameworks. Zero build steps.

---

## License

MIT
