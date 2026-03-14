# Daymark

A markdown note editor built with [Tauri](https://tauri.app/) and [CodeMirror 6](https://codemirror.net/), designed to work with [NotePlan](https://noteplan.co/)'s on-disk file format. Daymark reads and writes the same `.txt` files NotePlan uses, so the two apps can coexist on the same notes directory.

## Why

NotePlan's editor gets slow on large notes, search is clunky, and some workflows (like prepping for a 1:1 by gathering @mentions) require too many manual steps. Daymark aims to fix these pain points while keeping full compatibility with NotePlan's files and sync.

## Status

Early development. Phase 1 (walking skeleton) and Phase 2 (file navigation) are complete. The editor opens, edits, and saves NotePlan daily notes with live preview; you can navigate between notes via the sidebar and use date navigation on calendar notes.

## Implemented

- Walking skeleton: Tauri + CodeMirror 6, open/save NotePlan `.txt` files, live preview (headings, bold, italic, strikethrough, inline code, wiki-links, task checkboxes)
- Date navigation: prev/today/next on daily notes; weekly notes with date ranges and prev/next
- File navigation: sidebar file tree (note titles), Daily/Weekly quick links, Archive/Templates/Trash, back/forward (Cmd+[/]), drag-to-resize sidebar
- External change detection via polling (edits in NotePlan appear in Daymark)
- Live preview refinements: inline-scoped syntax reveal, task icons (Remix), external links open in browser, paste URL → auto-fetch title, angle-bracket autolink `<url>`
- Editor list and blockquote: Enter/Backspace continue or clear list/blockquote; numbered lists (basic); all marker types (task, bullet, ordered, checklist, blockquote)
- Light/dark mode via system preference; Remix Icons throughout

## Vibe-coded

This project is heavily AI-assisted. The majority of the code was generated through conversation with LLMs. Review accordingly.

## Tech stack

- **Shell:** Tauri 2 (Rust)
- **Editor:** CodeMirror 6 (TypeScript)
- **Build:** Vite + TypeScript
- **Sync:** Piggybacks on NotePlan's existing iCloud/CloudKit sync by reading the same files on disk

## How to run Daymark

**Start (development):** From the project root:
```bash
npm install
npm run tauri dev
```
The app window opens; Vite runs the frontend and Tauri runs the shell.

**Stop:** Close the app window, or press `Ctrl+C` in the terminal where `npm run tauri dev` is running.

**Build for production:** `npm run tauri build` (output in `src-tauri/target/release/`).

## Development

## License

[MIT](LICENSE)
