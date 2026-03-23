# Knowledge

Technical record: decisions we made, things we learned the hard way, and conventions we discovered. Kept separate from PLAN so the action plan stays easy to follow.

---

## Decisions

### Architecture: Platform, editor, sync, languages

**Platform: Tauri (Rust + web frontend)**

- Native macOS window with a web-based editor inside.
- ~10 MB app footprint vs ~150 MB for Electron.
- Rust backend handles file I/O; Tauri provides most filesystem commands out of the box, so the amount of Rust we actually write is minimal.
- **Rejected alternatives:**
  - **Electron** — Same performance profile we're escaping from NotePlan.
  - **Native Swift/AppKit** — NSTextView is painful for rich markdown editing. Building a performant live-preview editor on AppKit would be a project unto itself.
  - **Local web app** — No native window integration, no filesystem access without a server component. Ends up reinventing Tauri poorly.

**Editor engine: CodeMirror 6**

- Viewport-based rendering — only the visible portion of a document is in the DOM, so large files stay fast. This directly addresses the NotePlan performance problem.
- CM6's decoration system supports "live preview" cleanly: markdown syntax (e.g. `**`, `[[`, `#`) is hidden via replace decorations everywhere *except* the line the cursor is on. This is the same approach Obsidian uses.
- TypeScript-native, which matches the frontend language choice.
- **Rejected alternative:**
  - **ProseMirror** — Uses a rich document model (schema-defined nodes and marks). Our source of truth is markdown on disk. ProseMirror would require constant round-tripping between its internal model and markdown, and the "hide syntax except at cursor" behavior is unnatural in its paradigm.

**Starting point: Greenfield**

- **Rejected alternatives:**
  - **SilverBullet** — Deeply coupled to a client-server architecture (Deno backend, HTTP/WebSocket for everything). Decoupling it into a desktop app would take as long as building from scratch.
  - **Zettlr** — Electron-based, which is what we're moving away from.
- Our feature set is well-defined enough (see FEATURES.md) that we don't need an existing codebase for scaffolding.

**Sync: Piggyback on iCloud Drive**

Documented in detail in FEATURES.md under "Sync strategy." In short: we read/write NotePlan's existing markdown files on disk, and iCloud Drive handles cross-machine sync. No sync engine to build.

**Languages**

- **Frontend:** TypeScript — CM6 is TS-native, and it's the natural language for the web layer inside Tauri.
- **Backend:** Rust, via Tauri — but we lean heavily on Tauri's built-in commands. The amount of custom Rust should be small, at least initially.

### Architecture layers

The app has four layers. Layers 1–2 produce a working prototype (editor that can open and save markdown files). Layers 3–4 turn it into a useful daily driver.

- **Layer 1: Tauri shell** — Native macOS window hosting a webview. Filesystem access (read, write, watch for changes). File-watcher events pushed to the frontend so external edits (e.g. iCloud sync arriving) are picked up live.
- **Layer 2: CM6 editor** — Markdown editing with live preview (selective syntax hiding via CM6 decorations). Custom syntax extensions for Daymark/NotePlan-specific elements: task checkboxes, `>date` scheduling, `@mentions`, `#hashtags`, `[[wiki-links]]`. This layer alone, wired to Tauri's FS commands, is a functional (if bare-bones) markdown editor.
- **Layer 3: Note index** — In-memory index of all notes: titles, links, backlinks, mentions, tags. Built on startup by scanning the notes directory; incrementally updated as files change. Powers backlinks panel, search, mention renaming, and the compact calendar.
- **Layer 4: UI chrome** — Folder tree / sidebar navigation, compact calendar widget, backlink panel, search UI, note templates.

### @Mentions (identity, click, autocomplete, sidebar, rename, delete)

Discussed and decided 2026-02-24. #Hashtags will follow the same patterns.

**Identity:** `@` followed by a letter, then letters, digits, `_`, `/`, `-`. Regex: `@[A-Za-z][A-Za-z0-9_/\-]*`. Word boundary only; trailing punctuation ends the mention. Case-insensitive matching, case-preserving display. Any single letter or longer token is valid. Name collisions deferred.

**On disk:** Plain text `@PersonName`. No special syntax beyond the `@` prefix.

**V1 behavior: click = search** — Left-click an @mention anywhere → search in the main window for all lines containing that mention. Done tasks filtered out by default, with a toggle. Future: associate @mention with a specific note so clicking navigates to that note with reference pane. V1 uses search; association layers on later.

**Context menu (right-click):** Search for @MentionName, Search in new window, Copy mention, Remove @ from this line, plus line-level actions.

**Autocomplete:** Typing `@` triggers dropdown. Ranked by frequency then alphabetical. `@_old/` and other `_`-prefixed rank last. No match = no dropdown; new mentions created implicitly by typing.

**Sidebar:** Collapsible section showing all known mentions. Grouped by folder prefix. Clicking a mention = same as clicking in note (search). Reference count per mention.

**Rename (global):** Initiated from sidebar. Changes `@OldName` to `@NewName` across every file. Confirmation dialog with affected file count.

**Delete (non-destructive):** Initiated from sidebar. Strips the `@` prefix from all occurrences, preserving the text. Hard rule: deletion never destroys text content.

**Stale/orphan mentions:** Mention appearing only in archived/trashed files auto-disappears from sidebar. Still findable via search.

**Implementation note:** The current regex in `note-index.ts` uses `\w+` which doesn't match `/` or `-`. Update to `[A-Za-z][A-Za-z0-9_/\-]*` when implementing.

### `>today` carry-forward

Discussed and decided 2026-02-25.

**Panel design:** `>today` tasks appear in a reference panel at the top of today's daily note. Panel is open by default, collapsible. Panel only appears on today's daily note — not past daily notes, not weekly notes. Each entry shows the task text and its source note. `>YYYY-MM-DD` tasks scheduled to today are written into the daily note file, not the panel.

**Interaction:** Check off in panel → propagates to source note. Drag out of panel → creates a synced line (`^blockid`) in the note body at the drop position; task hides from panel; source note's original task is always preserved. Rolling forward: if a `>today` task is not completed by end of day, it reappears in tomorrow's panel. If it was dragged into today's note, the synced line stays in today's note; the task reappears in tomorrow's panel for re-triage.

**Key distinction from NotePlan:** NotePlan's `>today` panel allows dragging tasks out but this *removes* the task from its source note. Daymark's approach: dragging creates a synced line instead, preserving the source.

**Stale tasks:** Tasks with a specific `>YYYY-MM-DD` whose date has passed do NOT appear in the `>today` panel — they are surfaced as stale via the compact calendar's open-item highlighting.

### @Mention reference pane

Discussed and decided 2026-02-25.

**@mention → note association:** Parse line 2 (first line after the H1) for @mentions. Those become the note's tracked associations. Notes without an @mention on line 2 have no reference pane. Multiple @mentions on line 2 supported (one collapsible section per tracked mention).

**Reference pane:** Appears at the bottom of notes with tracked @mentions. One collapsible section per tracked @mention. Collapsed by default. Content ordered: open tasks first, then non-task text references. Grouped by source note. Non-task text as single-line truncated previews.

**Filtering (default toggles, on by default):** Hide completed tasks. Hide content older than 90 days. Date inference: calendar note filename → nearest date heading above @mention → above all dates = most recent → no dates = always shown.

**Context viewing:** Inline expand — click any reference line to expand and show surrounding lines from the source note. Supports text selection and copy.

**Drag from pane:** Standard drag-from-pane behavior (see below). Dragging a reference creates a synced line in the note body; hides the item from the pane. Deleting the synced line causes the item to reappear in the pane.

### Drag-from-pane (common pattern)

Discussed and decided 2026-02-25. Used by both `>today` panel and @mention reference panes.

**Mechanics:** (1) User drags a reference line from any pane into the note body. (2) Daymark creates a synced line at the drop position with a shared `^blockid`. (3) If the source line doesn't already have a `^blockid`, Daymark generates one and writes it to the source file (background write). (4) The dragged item hides from the pane.

**Pane contents:** The pane always shows all references matching its filters, minus any that already exist as synced lines in the current note. Dragging out → item disappears from pane. Deleting the synced line → item reappears in pane.

**Non-task lines:** Non-task text references are also draggable. Same `^blockid` mechanism.

### Unified context menu

Discussed and decided 2026-02-25.

**Problem:** NotePlan has three separate context menus (scheduling arrow, right-click on lines, synced-line menu on drag handle). Fragmented and hard to discover.

**Solution:** One right-click context menu on any line. Task-specific actions appear conditionally. Sections separated by dividers. Right-click a task or checklist line: Schedule (submenu), Complete/Open/Cancel (state-dependent), Copy Synced Line, Format (submenu), Cut/Copy/Paste/Paste as Plain Text. Right-click a non-task line: Copy Synced Line, Format, Cut/Copy/Paste/Paste as Plain Text.

**Task action rules:** Open task → Schedule, Complete, Cancel. Done task → Open, Cancel. Cancelled → Schedule, Complete, Open. Scheduled → Schedule (reschedule), Complete, Cancel. (Same state rules for checklist lines.)

**Schedule submenu (as implemented, 2026-03):** Task actions appear first, then a **SCHEDULE** heading. Primary rows label the **exact markdown token** side by side with the human label (wide flyout so rows do not wrap): **Today** `>today`, **Tomorrow** `>YYYY-MM-DD`, **This week** / **Next week** as **`>YYYY-Www`** (weekly calendar note, not a single day). **Custom date** opens a nested compact month grid (week numbers shown) to pick a day. Early design also mentioned relative shortcuts (+1d, +3d, …); those are not in the current menu.

**Left-click task or checklist icon:** Toggles open/done where the line uses `[ ]` / `[x]`. Separate from the context menu; most frequent interaction, one click. **Right-click and Ctrl/Cmd-click** on the icon must open the context menu only (no toggle)—see Learnings.

**CM6 note:** Task/checklist markers are replace widgets. The editor must still receive `contextmenu` events on the widget so the line menu runs when right-clicking the icon; see Learnings.

---

## Learnings

Things we made work after hitting issues. "We tried X, it broke because Y; fix was Z."

- **Enter/Backspace and list continuation** — lang-markdown gives the wrong context for Enter on list/blockquote lines (it inserts a new line without continuing the list). We handle Enter (and Backspace) in the main editor keymap so list/blockquote continuation and marker-only-line clearing work correctly. Enter on line with text continues the marker (bullet → `* `, ordered → next number, task → `- [ ] `, blockquote → `> `); Enter on marker-only line clears the line; Backspace on marker-only line clears the whole line.
- **Blockquote on empty line** — Empty line after a blockquote was mis-parsed. We added a guard in both the tree path and the regex fallback so blockquote decorations don't spill onto the next line.
- **Native file watching** — Tauri v2's `watch()` from `@tauri-apps/plugin-fs` didn't fire events for files in the NotePlan Setapp container. No errors thrown, just no events. Root cause unknown (sandbox restrictions, path resolution, or plugin bug). We use polling (readTextFile every 2s for current note, readDir every 5s for directory) as a reliable fallback. See Open questions in PLAN for phases that might revisit this.
- **Re-read on foreground** — When the app is backgrounded, macOS App Nap throttles (or pauses) `setInterval` timers. When the user switches back to Daymark, the 2s poll may not fire immediately, so they can see stale content for a few seconds. Add a `visibilitychange` or window `focus` handler that triggers an immediate re-read of the current note when the app becomes visible again.
- **Tree vs regex fallback in live preview** — When the CM6 syntax tree is stale (e.g. right after indent), `syntaxTree(state)` doesn't yet reflect the edit and decorations can disappear. We run a regex-based fallback when `tree.length < doc.length` (or equivalent) so decorations stay visible. Tradeoff: brief flicker possible when switching between tree and regex; acceptable for now. Reduce or eliminate regex fallback in Phase 3b if we fix tree staleness.
- **Task/checklist icon widget: context menu + toggle** — By default CM6 `WidgetType` ignores pointer events on the DOM node (`ignoreEvent` → true), so `mousedown` on the task icon can toggle via a listener on the widget. But **`contextmenu` was ignored too**, so CodeMirror did not treat the event as belonging to the editor, **`domEventHandlers.contextmenu` never ran**, and right-click on the icon failed. **Fix:** In `MarkerWidget.ignoreEvent`, return **`false` for `contextmenu`** on task/checklist widgets so the editor handles the event. On icon `mousedown`, only toggle for **primary button** (`button === 0`) **without** `ctrlKey` / `metaKey` so macOS Ctrl-click does not flip state; **`taskMarkerClickHandler`** uses the same rules (`live-preview.ts`).

---

## Discovered

Conventions we observed (NotePlan file format, scheduling, synced lines). Settled facts, not open questions.

### NotePlan file conventions

Observed during Phase 1 (Setapp version).

- **Storage location:** Setapp build uses `~/Library/Containers/co.noteplan.NotePlan-setapp/Data/Library/Application Support/co.noteplan.NotePlan-setapp/` — not iCloud Drive. CloudKit sync is handled by NotePlan internally. App Store version uses `~/Library/Mobile Documents/iCloud~co~noteplan~NotePlan3/Documents/` which syncs at the OS level.
- **File extension:** `.txt`, not `.md`.
- **Daily notes:** `Calendar/YYYYMMDD.txt` — flat directory.
- **Project notes:** `Notes/` with subdirectories. Special folders: `Notes/@Archive`, `Notes/@Templates`, `Notes/@Trash`.
- **Wiki-links:** `[[Note Title]]` — title-only, no folder paths, no aliases, no section anchors. Resolve by matching the note filename (minus `.txt`).
- **Title vs filename:** NotePlan uses H1 (or link text on creation) as initial filename. If H1 is later changed, NotePlan offers to update all links; the on-disk filename is NOT updated. Filename and H1 can diverge. We resolve links by filename for compatibility.
- **Duplicate titles:** Many duplicates in @Archive and @Trash. Active notes win over archived/trashed when resolving links.
- **Note creation from links:** Clicking a link to a non-existent note creates a new file in `Notes/` root.
- **@mentions format:** `@FirstnameLastname` (camelCase). Some have `@_old/` prefix for archiving. Usage pattern: tasks like `- Ask @PersonName about X` in meeting notes; user searches for @mentions to prep for 1:1s.
- **#hashtags:** Rarely used. Support for compatibility; careful tokenization (collision with hex colors, Slack channels, headings, URL fragments).
- **Priority markers:** `!`, `!!`, `!!!` before task text. NotePlan renders with increasing visual weight.
- **Task states observed:** `- text` = open (no brackets on disk); `- [x]` = done; `- [-]` = cancelled; `- [>] ... >YYYY-MM-DD` = scheduled. Brackets only for non-open states.
- **Checklist items (`+`):** Lines starting with `+` and checkbox markup (`+ [ ]`, `+ [x]`, `+ [>]`, etc.) get the same live-preview icons and **task context menu** (complete, cancel, schedule, reopen) as `-` tasks. They are **excluded from task-style review aggregates**—surfaces that count or list incomplete work only treat `-` lines, not checklists (`isChecklistListLineText` in `live-preview.ts`).

### Scheduling syntax (on-disk format)

- **Source line:** `- [>] task text >YYYY-MM-DD`
- **Destination line (non-synced):** `- [ ] task text <YYYY-MM-DD`
- **Subtasks:** Entire indented block scheduled; each line gets `[>]` and `>date` on source, `[ ]` and `<date` on destination.
- **Auto-task:** Typing `- ` creates an open task (stays as `- ` on disk). `* ` remains plain bullet.
- **Tab indentation:** Structural; creates subtasks, nested bullets, block hierarchy.
- **`>today` on disk:** Persists literally as `>today` — NOT resolved to a date. Only `>today` tasks roll forward; `>YYYY-MM-DD` tasks are pinned.
- **`>today` carry-forward scope:** Only explicitly `>today`-tagged tasks carry forward. Past-due `>YYYY-MM-DD` tasks do NOT auto-carry; surfaced as stale via calendar.
- **Weekly schedule tag:** `>YYYY-Www` (e.g. `>2026-W12`) targets the weekly calendar note `Calendar/YYYY-Www.txt`, same as NotePlan. The schedule UI’s “this week” / “next week” actions write this token, not a day-level `>YYYY-MM-DD`.
- **Schedule calendar grid — first day of week:** Implemented as `CALENDAR_WEEK_STARTS_ON` in `task-schedule.ts` (default **Sunday**). Not user-configurable yet; when Settings exists, expose it (see PLAN.md Someday).

### Synced lines

- **Block ID format:** `^xxxxxx` — 6 alphanumeric characters at end of line.
- **On-disk:** Every copy has identical text and the same `^blockid`. No "primary" copy; all are equal peers.
- **Completion propagation:** When a synced line is checked off, NotePlan updates ALL copies in ALL files to `[x]`.
- **Line format with scheduling and sync:** `- [x] task text ^blockid >YYYY-MM-DD`. Block ID before `>date`. Destination copy retains `>date` (not `<date`). `<date` back-reference only on non-synced scheduled copies.
- **Distinction:** `<YYYY-MM-DD` = non-synced copy pushed by scheduling. `^blockid` = synced copy. A line can have block ID and schedule date; if it has block ID it won't have `<date`.
- **Block ID assignment:** Purely file-based. NotePlan discovers matching `^blockid` strings by scanning files; no internal database. We can generate our own block IDs and NotePlan will honor them.
- **Non-task synced lines:** Synced lines work on any line (not just tasks). Same `^blockid` mechanism.

### CM6: ordered list `Four3)` bug

- **Symptom:** After paste / Enter / Shift-Tab on nested ordered lists, typing body text produced `Four3) ` (body before the marker).
- **Cause:** `Decoration.replace` on the marker is atomic; the caret can land at **markerFrom** (first digit). While `cursorInsideOrderedMarker` shows the raw marker for editing, **input still inserts before that digit** — selection `dispatch` after Tab/Shift-Tab/Enter was not enough to stop it.
- **Mitigation:** `orderedListBodyInsertFilter` in `live-preview.ts` (`EditorState.transactionFilter`) rewrites pure inserts that start at `markerFrom` to insert at `markerTo` instead, and shifts the mapped selection by `(markerTo - markerFrom)`. Single ASCII digit inserts are not redirected so changing the list number at the first digit still works.
- **Indent unit:** Inserts that match `indentUnit` (e.g. a single tab from Tab on a list line) are not redirected, because with no leading whitespace `markerFrom` equals `line.from` and redirecting would move structural indent after the marker. `tabOnHeadingOrListLine` also tags its insert with `userEvent: 'input.indent'` (same as CodeMirror’s `indentMore`); the filter skips redirect when `tr.isUserEvent('input.indent')` so Tab still works if string equality ever mismatches.
- **Automated tests:** `npm test` runs Vitest. `src/live-preview.ordered-filter.test.ts` uses Node (`EditorState` + transaction filter). `src/editor-list-keymap.test.ts` uses **happy-dom** (`@vitest-environment` in file) + `EditorView` for Tab / Shift-Tab / Enter / Backspace handlers from `editor-list-keymap.ts`. Full paste flows or Tauri shell still need Playwright or manual runs.
- **Vertical arrow / hidden indent:** Replace decorations for “hidden” syntax used `display:none`, so those spans had **zero width** in layout. `moveVertically` + `posAtCoords` (goal column) then skipped indented lines above a top-level line. **Fix:** `HiddenWidget` renders the same `sliceDoc(from,to)` text with `opacity:0` + `white-space:pre` (class `cm-live-preview-hidden-text`) so horizontal extent matches the document for measurement.
- **Nested ordered lists:** Numbering at indent level L restarts at 1 when a **shallower** line (indent &lt; L) appears between two lines at level L (e.g. each top-level `3) …` block gets its own `1)` nested child, not `2)`, `3)` continuing from earlier nests). Implemented via `indentBreaksBetween` in `renumberRunSequential`, `expectedNumberAtLevel`, `renumberRunFromEdit`, and `getNextOrderedMarkerInRun`.
