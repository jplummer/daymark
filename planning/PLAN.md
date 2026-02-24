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

**Status: Complete.** Walking skeleton works. Edits round-trip to NotePlan. Added date navigation (prev/today/next) and live preview decorations (headings, bold, italic, strikethrough, inline code, wiki-links, task checkboxes). Line numbers removed per preference.

### Phase 2: File navigation and watching

**Goal:** Browse and open any note in the NotePlan directory. React to external file changes.

- Build a sidebar file tree showing the NotePlan notes directory.
- Implement file watching (Tauri's `fs.watch` or `notify` crate) so external changes (iCloud sync, NotePlan edits) update the editor.
- Handle the "file changed on disk while open in editor" case gracefully.

**Done when:** You can navigate between notes via the sidebar, and edits made in NotePlan appear in Daymark without restarting.

**Status: Complete.** Sidebar with file tree (note titles, not filenames), Daily/Weekly quick links, Archive/Templates/Trash separated below. Back/forward navigation with Cmd+[/]. Weekly notes show date ranges and support prev/next. Project notes show path breadcrumb with emphasized title. Light/dark mode via system preference. Remix Icons throughout. Drag-to-resize sidebar. External change detection via polling (2s note, 5s directory).

### Phase 3: Note index and links

**Goal:** Wiki-links resolve, backlinks work, mentions and tags are clickable.

- Scan the notes directory on startup to build the in-memory index (title → path, outgoing links, mentions, tags).
- Parse `[[wiki-links]]` in CM6 and make them navigable (click to open the linked note).
- Wiki-link autocomplete: typing `[[` and typing a few characters shows a ranked list of matching notes. Exact matches among active notes first, then active notes that match less well, then archived notes that match. Never show trashed notes in autocomplete (trashed notes should be searchable separately).
- Link resolution: title-based (filename minus `.txt`). Note title can diverge from filename if the H1 is changed — see conventions below.
- Clicking a link to a non-existent note creates a new note in the `Notes/` root.
- Build the backlinks panel (given a note, show all notes that link to it).
- Make `@mentions` and `#hashtags` clickable (navigate to search results).
- Incrementally update the index when files change.

**Done when:** You can click a `[[link]]` to navigate, see backlinks for any note, and click an `@mention` to see all notes containing it.

### Phase 4: Daily/weekly notes and calendar

**Goal:** The daily-driver workflow — open today's note, see the compact calendar, get uncompleted weekly items surfaced.

- Calendar notes (daily and weekly) are auto-created when first navigated to or when something is scheduled into them. A note for a given date may never exist if it's never visited or targeted.
- Implement daily note creation (from template if one exists, otherwise blank) tied to today's date.
- Implement weekly note creation with the same approach. Weekly notes live in `Calendar/YYYY-Wnn.txt`.
- Build the compact calendar widget — shows the current month, highlights dates that have notes with open tasks.
- Surface open tasks from the weekly note in a reference panel at the top of all daily notes in that week. (NotePlan does this; it's useful but could be improved later.)
- Weekly note workflow: written at start of week, reviewing prior week's missed items. Tasks that belong to the week but not a specific day go here. Re-reviewed mid-week or Friday.

**Done when:** Launching Daymark opens today's daily note with weekly items surfaced, and the calendar lets you navigate to any day.

### Phase 5: Tasks and scheduling

**Goal:** Full task management — checkboxes, completion, the `>date` scheduling syntax, carry-forward with `>today`, and synced lines.

- Implement task checkbox toggling in the editor (click or keyboard shortcut to cycle states).
- Parse `>date` syntax and register scheduled items in the note index.
- When opening a daily note, pull in tasks scheduled for that date from other notes. Scheduled tasks appear at the top of the daily note.
- Display scheduled items with a reference back to their source note.
- A task can only be scheduled to one date at a time. Scheduling to a new date replaces the previous `>date`.
- The original task always stays in place in its source note (preserving context). It is never removed or moved — only marked as scheduled.
- Implement `>today` carry-forward. Key difference from `>YYYY-MM-DD`: `>today` tasks roll forward automatically — if not done today, they surface on tomorrow's note, and so on. NotePlan uses a display-only reference panel for this (not written to the daily note file). We should do better: NotePlan's panel lets you drag tasks out, which removes them from the source and destroys context. **Design decision needed:** how do we render carry-forward tasks? Options include writing them into the file as synced lines, or a panel that doesn't allow destructive moves. Discuss before building.
- Implement synced lines: scheduled tasks that appear in a daily/weekly note are live references to their source. Edits in either location propagate to the other.
- Stale tasks (scheduled date passed, still incomplete) are surfaced via the compact calendar's open-item highlighting — the calendar is the nudge to clean up the past.

**Done when:** You can schedule a task in a project note with `>2026-02-25` and it appears at the top of the Feb 25 daily note. You can carry a stale task forward with `>today`. Editing a synced line in the daily note updates the source, and vice versa.

### Phase 6: Search and mention management

**Goal:** Find anything quickly. Rename mentions globally.

- Implement full-text search across all notes (likely using the note index + a simple text search; consider `ripgrep` via Tauri command if performance matters).
- Build search UI that doesn't have NotePlan's click-through problem.
- Implement global mention renaming: rename `@OldName` to `@NewName` across every file that contains it.

**Done when:** Search returns results without accidental navigation, and renaming a mention updates all documents.

### Beyond Phase 6

At this point Daymark should be a functional daily driver. Remaining Priority 1 features (templates with logic, stable links on move) can be tackled as needed. Priority 2 features (theming, timeline, filters, timeblocking, calendar integration) come after.

---

## Discovered: NotePlan File Conventions

Observed during Phase 1 (Setapp version):

- **Storage location:** `~/Library/Containers/co.noteplan.NotePlan-setapp/Data/Library/Application Support/co.noteplan.NotePlan-setapp/` — not in iCloud Drive. The Setapp build uses a sandboxed container, not the `iCloud~co~noteplan~NotePlan3` path documented elsewhere. CloudKit sync is handled by NotePlan internally.
- **File extension:** `.txt`, not `.md`.
- **Daily notes:** `Calendar/YYYYMMDD.txt` — flat directory, no year/month subfolders.
- **Project notes:** `Notes/` directory with subdirectories (e.g. `Notes/Personal/`, `Notes/Invoca/`).
- **Special folders:** `Notes/@Archive`, `Notes/@Templates`, `Notes/@Trash`.
- **Wiki-links:** `[[Note Title]]` — title-only, no folder paths, no aliases (`|`), no section anchors (`#`). Resolve by matching the note filename (minus `.txt`).
- **Title vs filename:** NotePlan uses the H1 (or link text on creation) as the initial filename. If the H1 is later changed, NotePlan offers to update all links. The on-disk filename is NOT updated. This means the filename and the H1/link-text can diverge. We must resolve links by filename for compatibility, but be aware of the divergence.
- **Duplicate titles:** 208 duplicate filenames exist, almost all in `@Archive` and `@Trash`. Active notes should always win over archived/trashed when resolving links.
- **Note creation from links:** Clicking a link to a non-existent note creates a new file in the `Notes/` root. Moving a note to a subfolder does not break links to it (NotePlan resolves by title across all folders).
- **@mentions format:** `@FirstnameLastname` (no space, camelCase). Some have an `@_old/` prefix (e.g. `@_old/NancyJohnson`) — this is a manual workaround for archiving mentions of people who are no longer relevant, because NotePlan's "delete mention" destroys all references.
- **@mention usage pattern:** Tasks like `- Ask @PersonName about X` are written in meeting/project notes. To prep for a 1:1, the user searches for that person's @mentions to find all outstanding tasks involving them. Current NotePlan workflow for this is very cumbersome (search → follow result → copy synced line → paste into person's note → repeat).
- **#hashtags:** Rarely used — only 2 found across all 2025-2026 daily notes. Not a significant part of the current workflow. Support for compatibility but don't prioritize.
- **Priority markers:** `!`, `!!`, `!!!` etc. before task text (e.g. `- ! important task`). NotePlan renders these with increasing visual weight. We should highlight the line with increasing saturation as bangs pile up.
- **@mention autocomplete:** Typing `@` should offer a ranked list of known mentions, best matches first (same pattern as `[[` autocomplete for wiki-links).
- **#hashtags:** Support for compatibility. Parsing is tricky — hashtags can collide with hex colors, Slack channel names, markdown headings, URL fragments. Need careful tokenization.
- **Task states observed so far:**
  - `- task text` — open task (no brackets on disk; NotePlan renders it with a checkbox).
  - `- [x] task text` — done.
  - `- [-] task text` — cancelled.
  - `- [>] task text >YYYY-MM-DD` — scheduled to a specific date.
  - Brackets only appear for non-open states. A plain `- ` line is an open task. More states may exist — catalog as encountered.

### Scheduling syntax (observed from real notes)

Inspected existing NotePlan files to determine on-disk format:

- **Source line (originating note):** `- [>] task text >YYYY-MM-DD` — checkbox state changes to `[>]`, target date appended with `>`.
- **Destination line (target daily note):** `- [ ] task text <YYYY-MM-DD` — open task with `<` back-reference to the originating date.
- **Subtasks:** The entire indented block is scheduled. Each line (parent + children) gets `[>]` and `>date` on source, `[ ]` and `<date` on destination.
- **After completion (non-synced):** Destination becomes `[x]`, but source appears to stay `[>]` in the file. See synced lines section for synced behavior.
- **Auto-task creation:** Typing `- ` (hyphen space) creates an open task. On disk this stays as `- ` (no brackets) — NotePlan renders the checkbox in the UI. `* ` (asterisk space) remains a plain markdown bullet, not a task.
- **`>today` on disk:** Persists literally as `>today` — NOT resolved to a date. This is the key difference from `>YYYY-MM-DD`. Only `>today` tasks roll forward; `>YYYY-MM-DD` tasks are pinned to a specific date.
- **`>today` carry-forward scope:** Only explicitly `>today`-tagged tasks carry forward. Tasks with a specific `>YYYY-MM-DD` whose date has passed do NOT auto-carry — they stay pinned to their target date and are surfaced as stale via the compact calendar.
- **Convenience menu:** Typing `>` in NotePlan offers: `>today` (repeat until completed), `>YYYY-MM-DD` (today's date), `>YYYY-Wnn` (current week), `>YYYY-Qn` (current quarter). Weekly and quarterly scheduling exist — document format when ready to implement.

### Synced lines (observed from real notes)

- **Block ID format:** `^xxxxxx` — 6 alphanumeric characters appended to the end of a line. Displayed as a blue asterisk in NotePlan's UI.
- **On-disk:** Every copy of a synced line has identical text and the same `^blockid`. The line is duplicated across files — no "primary" copy; all are equal peers.
- **Completion propagation:** When a synced line is checked off, NotePlan updates ALL copies in ALL files to `[x]`. This is true sync, not display-time resolution.
- **Line format with both scheduling and sync:** `- [x] task text ^blockid >YYYY-MM-DD`. Block ID comes before `>date`. When a line is both synced and scheduled, the destination copy retains `>date` (NOT `<date`). The `<date` back-reference appears only on non-synced scheduled copies.
- **Distinction:** `<YYYY-MM-DD` = non-synced copy pushed by scheduling. `^blockid` = synced copy. A line can have a block ID and a schedule date, but if it has a block ID it won't have a `<date`.

**Use cases observed:**
1. Workaround for `>today` reference panel — copy a task as a synced line into the daily note so it can be reordered without destroying the source.
2. Cross-referencing tasks across `@mention` notes — sync a "talk to @person" task from one 1:1 note into another.
3. Occasionally syncing reference text (not just tasks) across project notes.

**Design opportunity:** Use cases 1 and 2 are gymnastics — workarounds for missing features. Better `>today` handling and better @mention surfacing could reduce the need for manual synced-line management.

**Resolved:** Block ID assignment — tested by adding a made-up `^test01` to lines in two different daily notes. NotePlan recognized them as synced immediately. Block IDs are purely file-based: NotePlan discovers matching `^blockid` strings by scanning files, no internal database registration needed. We can generate our own block IDs and NotePlan will honor them.

**Open:** Non-task synced lines — confirmed that synced lines work on any line (not just tasks). Same `^blockid` mechanism, same blue asterisk in UI.

## Open Questions

- **Task state syntax:** Open tasks are usually just `- text` (no brackets), but `- [ ] text` also exists in some older notes. Both forms must be treated as open tasks. Brackets appear consistently for done `[x]`, cancelled `[-]`, and scheduled `[>]`. More states may exist.
- **Template format:** How does NotePlan store and apply templates? Inspect `Notes/@Templates/`.
- **Scheduling compatibility:** We must match NotePlan's on-disk format for scheduled tasks so both apps can coexist. NotePlan docs describe intended behavior; real notes reveal actual behavior. When they diverge, match what's in the files.
- **Calendar grid vs. `>today`:** Tasks scheduled with `>today` should only show as open on today's date and the originating date in the compact calendar — NOT on every intervening day. Document this constraint when implementing the calendar.
- **@mention task sync:** There may be value in helping sync or surface tasks across `@mentions` (e.g. see all open tasks tagged with `@PersonName`). Discuss later.
- **iCloud Drive vs Setapp container:** The Setapp version stores files in a sandboxed container and syncs via CloudKit *inside NotePlan's process*. This means the local files only update when NotePlan is running — if NotePlan hasn't been opened, Daymark reads stale data. The App Store / direct-download version uses `~/Library/Mobile Documents/iCloud~co~noteplan~NotePlan3/Documents/`, which syncs at the OS level via iCloud Drive (no dependency on NotePlan running). **Current status:** developing against the Setapp path, which requires NotePlan to have synced recently. **Required before replacing NotePlan:** detect and support both storage locations; prefer the iCloud Drive path when available since it syncs independently.
- **Native file watching not working:** Tauri v2's `watch()` from `@tauri-apps/plugin-fs` didn't fire events for files in the NotePlan Setapp container (`~/Library/Containers/co.noteplan.NotePlan-setapp/...`). Tried both `baseDir: Home` with relative paths and absolute paths via `homeDir()`. No errors thrown, just no events. Currently using polling (readTextFile every 2s, readDir every 5s) as a reliable fallback. Root cause unknown — could be macOS sandbox restrictions on FSEvents for other apps' containers, path resolution issues, or a Tauri plugin bug. Worth revisiting if polling becomes a performance concern.

---

## Archive

Items completed before 2026-02-22 (exact dates not tracked):

- **Phase 1: Walking skeleton — Complete.** Open a markdown file from NotePlan's iCloud directory, edit it with live preview, save it back. Tauri + CM6 stack works end-to-end. Edits round-trip to NotePlan. Added date navigation (prev/today/next) and live preview decorations (headings, bold, italic, strikethrough, inline code, wiki-links, task checkboxes). Line numbers removed per preference. *(pre-tracking)*
- **Weekly notes (resolved)** — Stored in `Calendar/` alongside daily notes. Filename: `YYYY-Wnn.txt` (e.g. `2026-W07.txt`). 144 weekly notes exist (2022–2026). Content is a week plan: tasks for the week not assigned to a specific day. Support `<YYYY-Wnn` back-references (same scheduling mechanism as daily notes). Open tasks from the weekly note are shown in a reference panel at the top of all daily notes in that week. *(pre-tracking)*
- **Scheduling: completion model (resolved)** — For non-synced `>YYYY-MM-DD` tasks, the source stays `[>]` ("delegated") regardless of destination state. Completion status lives only on the `<date` destination copy. The source doesn't need to know if the task was done — `[>]` means "sent elsewhere." The compact calendar only needs to check the target date for open items, not trace back to every source. (Some older notes have `[x]` + `>date` — likely tasks completed early on the source before the scheduled date; the `>date` is an inert artifact.) *(pre-tracking)*

Items completed 2026-02-22:

- **Fix text selection bug** — Live preview no longer rebuilds decorations on every selection event; only when cursor position changes with a collapsed selection.
- **Inline-scoped decorations** — Markdown syntax only reveals for the specific element the cursor is within, not the whole line. Heading font size always applied; only `#` prefix is inline-scoped.
- **External link handling** — Markdown links `[text](url)` show as "text ↗" on non-cursor lines. Bare URLs styled as clickable links. Click opens in default browser via Tauri opener. Ctrl-click (macOS right-click) does not follow.
- **Paste URL → auto-title** — Pasting a bare URL wraps it as `[Fetching title…](url)` and async-fetches the `<title>` tag, replacing the placeholder.
- **Task icons** — All task markup (`- `, `- [ ] `, `- [x] `, `- [-] `, `- [>] `) replaced by Remix Icon circle icons (open, done, cancelled, scheduled). Done tasks mute the entire line. `* ` bullets left as plain markdown.
- **Selection highlight fix** — Replaced `drawSelection()` with native browser selection for reliable visibility over opaque line backgrounds.
- **Phase 2: File watching — Complete.** External change detection via polling (readTextFile every 2s for current note, readDir every 5s for sidebar). Native `watch()` didn't work reliably with NotePlan's Setapp container.
