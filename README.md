# Daymark

A markdown note editor built with [Tauri](https://tauri.app/) and [CodeMirror 6](https://codemirror.net/), designed to work with [NotePlan](https://noteplan.co/)'s on-disk file format. Daymark reads and writes the same `.txt` files NotePlan uses, so the two apps can coexist on the same notes directory.

## Why

NotePlan's editor gets slow on large notes, search is clunky, and some workflows (like prepping for a 1:1 by gathering @mentions) require too many manual steps. Daymark aims to fix these pain points while keeping full compatibility with NotePlan's files and sync.

## Status

Early development. Phase 1 (walking skeleton) is complete — the editor opens, edits, and saves NotePlan daily notes with live preview. See `planning/PLAN.md` for the full roadmap.

## Vibe-coded

This project is heavily AI-assisted. The majority of the code was generated through conversation with LLMs. Review accordingly.

## Tech stack

- **Shell:** Tauri 2 (Rust)
- **Editor:** CodeMirror 6 (TypeScript)
- **Build:** Vite + TypeScript
- **Sync:** Piggybacks on NotePlan's existing iCloud/CloudKit sync by reading the same files on disk

## Development

```bash
npm install
npm run tauri dev
```

## License

[MIT](LICENSE)
