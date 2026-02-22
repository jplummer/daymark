# Daymark — Technical Plan

## Architecture Decisions

These were discussed and decided before implementation began. Rationale is included so future contributors (or future-us) understand the "why."

### Platform: Tauri (Rust + web frontend)

- Native macOS window with a web-based editor inside.
- ~10 MB app footprint vs ~150 MB for Electron.
- Rust backend handles file I/O; Tauri provides most filesystem commands out of the box, so the amount of Rust we actually write is minimal.
- **Rejected alternatives:**
  - **Electron** — Same performance profile we're escaping from NotePlan.
  - **Native Swift/AppKit** — NSTextView is painful for rich markdown editing. Building a performant live-preview editor on AppKit would be a project unto itself.
  - **Local web app** — No native window integration, no filesystem access without a server component. Ends up reinventing Tauri poorly.

### Editor engine: CodeMirror 6

- Viewport-based rendering — only the visible portion of a document is in the DOM, so large files stay fast. This directly addresses the NotePlan performance problem.
- CM6's decoration system supports "live preview" cleanly: markdown syntax (e.g. `**`, `[[`, `#`) is hidden via replace decorations everywhere *except* the line the cursor is on. This is the same approach Obsidian uses.
- TypeScript-native, which matches the frontend language choice.
- **Rejected alternative:**
  - **ProseMirror** — Uses a rich document model (schema-defined nodes and marks). Our source of truth is markdown on disk. ProseMirror would require constant round-tripping between its internal model and markdown, and the "hide syntax except at cursor" behavior is unnatural in its paradigm.

### Starting point: Greenfield

- **Rejected alternatives:**
  - **SilverBullet** — Deeply coupled to a client-server architecture (Deno backend, HTTP/WebSocket for everything). Decoupling it into a desktop app would take as long as building from scratch.
  - **Zettlr** — Electron-based, which is what we're moving away from.
- Our feature set is well-defined enough (see FEATURES.md) that we don't need an existing codebase for scaffolding.

### Sync: Piggyback on iCloud Drive

Documented in detail in FEATURES.md under "Sync strategy." In short: we read/write NotePlan's existing markdown files on disk, and iCloud Drive handles cross-machine sync. No sync engine to build.

### Languages

- **Frontend:** TypeScript — CM6 is TS-native, and it's the natural language for the web layer inside Tauri.
- **Backend:** Rust, via Tauri — but we lean heavily on Tauri's built-in commands. The amount of custom Rust should be small, at least initially.

---

## Architecture Layers

The app has four layers. Layers 1–2 produce a working prototype (editor that can open and save markdown files). Layers 3–4 turn it into a useful daily driver.

### Layer 1: Tauri shell

- Native macOS window hosting a webview.
- Filesystem access (read, write, watch for changes).
- File-watcher events pushed to the frontend so external edits (e.g. iCloud sync arriving) are picked up live.

### Layer 2: CM6 editor

- Markdown editing with live preview (selective syntax hiding via CM6 decorations).
- Custom syntax extensions for Daymark/NotePlan-specific elements:
  - Task checkboxes and completion states
  - `>date` scheduling syntax
  - `@mentions` and `#hashtags`
  - `[[wiki-links]]`
- This layer alone, wired to Tauri's FS commands, is a functional (if bare-bones) markdown editor.

### Layer 3: Note index

- In-memory index of all notes: titles, links, backlinks, mentions, tags.
- Built on startup by scanning the notes directory; incrementally updated as files change (via file-watcher events from Layer 1).
- Powers backlinks panel, search, mention renaming, and the compact calendar (which needs to know which dates have open items).

### Layer 4: UI chrome

- Folder tree / sidebar navigation.
- Compact calendar widget with open-item highlights.
- Backlink panel.
- Search UI (full-text + structured filters).
- Note templates.

---

## Implementation Phases

### Phase 1: Walking skeleton

**Goal:** Open a markdown file from NotePlan's iCloud directory, edit it with live preview, and save it back. Prove the Tauri + CM6 stack works end-to-end.

- Initialize a Tauri project with a TypeScript frontend.
- Embed CodeMirror 6 with basic markdown support (syntax highlighting, keybindings).
- Wire up Tauri FS commands: open file, save file.
- Add live preview decorations (hide markdown syntax except on cursor line).
- Point it at a real NotePlan file and verify round-trip editing works without corrupting the file.

**Done when:** You can open a NotePlan daily note, edit it with live preview, save, and confirm NotePlan sees the changes.

### Phase 2: File navigation and watching

**Goal:** Browse and open any note in the NotePlan directory. React to external file changes.

- Build a sidebar file tree showing the NotePlan notes directory.
- Implement file watching (Tauri's `fs.watch` or `notify` crate) so external changes (iCloud sync, NotePlan edits) update the editor.
- Handle the "file changed on disk while open in editor" case gracefully.

**Done when:** You can navigate between notes via the sidebar, and edits made in NotePlan appear in Daymark without restarting.

### Phase 3: Note index and links

**Goal:** Wiki-links resolve, backlinks work, mentions and tags are clickable.

- Scan the notes directory on startup to build the in-memory index (title → path, outgoing links, mentions, tags).
- Parse `[[wiki-links]]` in CM6 and make them navigable (click to open the linked note).
- Build the backlinks panel (given a note, show all notes that link to it).
- Make `@mentions` and `#hashtags` clickable (navigate to search results).
- Incrementally update the index when files change.

**Done when:** You can click a `[[link]]` to navigate, see backlinks for any note, and click an `@mention` to see all notes containing it.

### Phase 4: Daily/weekly notes and calendar

**Goal:** The daily-driver workflow — open today's note, see the compact calendar, get uncompleted weekly items surfaced.

- Implement daily note creation (from template if one exists, otherwise blank) tied to today's date.
- Implement weekly note creation with the same approach.
- Build the compact calendar widget — shows the current month, highlights dates that have notes with open tasks.
- Surface uncompleted items from the weekly note at the top of the daily note.

**Done when:** Launching Daymark opens today's daily note with weekly rollover items, and the calendar lets you navigate to any day.

### Phase 5: Tasks and scheduling

**Goal:** Full task management — checkboxes, completion, the `>date` scheduling syntax, carry-forward with `>today`, and synced lines.

- Implement task checkbox toggling in the editor (click or keyboard shortcut to cycle states).
- Parse `>date` syntax and register scheduled items in the note index.
- When opening a daily note, pull in tasks scheduled for that date from other notes.
- Display scheduled items with a reference back to their source note.
- Implement `>today` carry-forward: applying `>today` to an incomplete task in a past daily note reschedules it to today.
- Implement synced lines: scheduled tasks that appear in a daily/weekly note are live references to their source. Edits in either location propagate to the other.

**Done when:** You can schedule a task in a project note with `>2026-02-25` and it appears in the Feb 25 daily note. You can carry a stale task forward with `>today`. Editing a synced line in the daily note updates the source, and vice versa.

### Phase 6: Search and mention management

**Goal:** Find anything quickly. Rename mentions globally.

- Implement full-text search across all notes (likely using the note index + a simple text search; consider `ripgrep` via Tauri command if performance matters).
- Build search UI that doesn't have NotePlan's click-through problem.
- Implement global mention renaming: rename `@OldName` to `@NewName` across every file that contains it.

**Done when:** Search returns results without accidental navigation, and renaming a mention updates all documents.

### Beyond Phase 6

At this point Daymark should be a functional daily driver. Remaining Priority 1 features (templates with logic, stable links on move) can be tackled as needed. Priority 2 features (theming, timeline, filters, timeblocking, calendar integration) come after.

---

## Open Questions

- **NotePlan file conventions:** We need to document the directory structure, filename patterns, and any front-matter conventions NotePlan uses. This should happen during Phase 1 as we inspect real files.
- **Task state syntax:** NotePlan uses more than just `- [ ]` / `- [x]`. Need to catalog the full set of states (cancelled, scheduled, etc.) and their syntax.
- **Template format:** How does NotePlan store and apply templates? Need to inspect the template files before implementing in Phase 4+.
