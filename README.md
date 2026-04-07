# HexDrop — Hex Viewer & Binary File Inspector

I built this because I kept needing to look inside binary files while modding games — save files, pak archives, config blobs — and every tool I tried was either way too heavy or required a full install just to peek at a few bytes.

So I made a Chrome extension. Drop any file on the tab, see hex and ASCII side by side. No install. No upload. Nothing leaves your machine. Just open it and go.

---

## What It Does

- **Drop any file** — instantly see hex and ASCII side by side, no setup needed
- **Click any byte** — see exactly what it is: hex value, decimal, and the character it represents
- **Search by hex or text** — finds matches across the whole file fast, even at 50,000+ results on 100MB files
- **Search by decimal too** — useful when you remember a number but not the hex equivalent
- **Jump to any offset** — go straight to byte 0x3C or byte 60, whichever way you think about it
- **Switch encodings** — UTF-8 (emoji included), UTF-16 LE/BE with full surrogate pair support, Windows-1252, ASCII
- **Change column width** — 8, 16, or 32 bytes per row depending on what you're looking at
- **Export what you need** — full hex dump, hex only, decoded text, or open as PDF
- **Handles big files** — pages through up to 100MB without the browser choking

**Zero permissions requested. Zero network calls. Everything runs locally in your browser.**

---

## Who It's For

Honestly, anyone who needs to look inside a file without spinning up a full hex editor:

- Game modders digging through save files, pak archives, and config binaries
- Reverse engineers analyzing executables or file formats
- Developers debugging binary protocols or custom file formats  
- CTF players who need a quick look at unknown files
- Security researchers — works completely offline, nothing gets sent anywhere

---

## Install

**Chrome Web Store:** Pending review — link will be added once approved.

**Load it yourself right now (takes about 60 seconds):**

1. Download or clone this repo
2. Open Chrome and go to `chrome://extensions`
3. Turn on **Developer Mode** in the top right corner
4. Click **Load unpacked** and select this folder
5. Done — the HexDrop icon appears in your toolbar

---

## How I Built It

Pure vanilla JavaScript. No frameworks, no build system, no dependencies at all. Just open the files and it works.

| Thing | How it's done |
|-------|--------------|
| Search | KMP algorithm — O(n+m), handles huge files without slowing down |
| Large files | Paged rendering, 16KB at a time — no memory issues |
| UTF-16 | Full surrogate pair support built in |
| Windows-1252 | Complete 0x80–0x9F character lookup table |
| Export | Built with Blob arrays so even big files export cleanly |
| Permissions | None requested — the extension does nothing it doesn't tell you about |

---

## Project Structure

```
hexdrop/
  manifest.json         — MV3 manifest, zero permissions
  popup.html / popup.js — the toolbar popup that opens the viewer
  viewer.html           — the actual hex viewer UI
  hexdrop.js            — all the viewer logic (~1,200 lines)
  style.css             — amber terminal theme
  icons/                — 16, 32, 48, 128px icons
  screenshots/          — store screenshots
  test-files/           — sample files I used for testing
  icon-generator.html   — the canvas tool I used to make the icons
```

---

## License

MIT — use it however you want.
