# Changelog

Notable changes to Daymark. For fine-grained history, use `git log`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions match [package.json](package.json) unless a release is tagged separately.

## [Unreleased]

### Added

- `CHANGELOG.md` and a filled-in README **Development** section (tests, planning doc pointers, Vite-only dev).

## [0.1.0]

### Added

- Tauri 2 app with CodeMirror 6: open, edit, and save NotePlan `.txt` files with live preview (headings, emphasis, code, wiki-links, tasks, links).
- Sidebar file tree, Daily/Weekly shortcuts, archive/templates/trash areas, back/forward navigation, resizable sidebar, persisted open/closed state.
- Date navigation on daily and weekly calendar notes; refresh when the calendar day changes.
- Polling-based reload when files change outside the app (e.g. NotePlan).
- List and blockquote editing: Enter/Backspace continuation and clearing; ordered lists with live preview alignment to the syntax tree.
- Vitest coverage for ordered-list filtering and list keymap behavior (`npm test`).
- System light/dark appearance; Remix Icons in the UI.

### Changed

- Live preview increasingly driven by the CM6 syntax tree (headings, blockquotes, lists/tasks) instead of regex-only paths.

### Fixed

- Various live preview and layout issues (nested ordered segments, hidden-text width, checkbox flicker, `<url>` autolinks after indent).
