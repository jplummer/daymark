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

### Phase 3a: Note index, links, and navigation

**Goal:** Wiki-links resolve, backlinks work, mentions and tags are clickable, autocomplete works.

*Sources: PLAN.md Phase 3, FEATURES.md P1 (links, backlinks, @mentions, #hashtags), IDEAS.md (autocomplete polish, cmd-click links).*

**Index & data layer**
- Scan notes directory on startup → build in-memory index (title → path, outgoing links, mentions, tags).
- Incremental index updates when files change (via polling events from Phase 2).

**Link resolution & navigation**
- Wiki-link resolution: title-based (filename minus `.txt`); active notes win over archived/trashed for duplicates.
- Wiki-link click-to-navigate (click `[[link]]` → open linked note).
- Click non-existent link → create new note in `Notes/` root.
- Cmd-click / context menu to open a link in a new window.
- Backlinks panel (given a note, show all notes that link to it).

**Autocomplete**
- Wiki-link autocomplete: typing `[[` shows ranked matches (exact active > partial active > archived; never trashed).
- Autocomplete polish: icons (file icon for notes, folder icon for context), visual divider between active and archived sections.
- @mention autocomplete: typing `@` shows ranked mentions (by frequency then alphabetical; `_`-prefixed last).

**@mentions & #hashtags**
- @mention click → search (V1 behavior per § Design Decisions: @Mentions).
- #hashtag click → search.
- Careful hashtag parsing (avoid false positives: hex colors, Slack channels, headings, URL fragments).

**Sidebar**
- Folder index view: clicking a folder shows a note listing in the editor area (title + first line preview).

**Done when:** You can click a `[[link]]` to navigate, see backlinks for any note, click an `@mention` to see all notes containing it, type `[[` or `@` for autocomplete, and click a folder to see its contents.

### Phase 3b: Editor rendering and gutter

**Goal:** CM6 rendering is robust and framework-aligned. Editor supports folding and drag-to-reorder. Typography and spacing are refined.

*Sources: IDEAS.md (CM6 refactors, heading folding, left gutter, numbered lists, style pass, proportional fonts), FEATURES.md P1 (auto-task creation, priority markers, drag to reorder).*

**CM6 foundation (do first — before adding more syntax support)**
- ⚠️ CM6 syntax tree refactor: replace regex-based live preview with Lezer parse tree via `syntaxTree(state)`.
- ⚠️ CM6 theme refactor: replace CSS overrides + `!important` with `EditorView.theme()` extension. Eliminates fragile `calc()` offsets.

**Content type rendering**
- Auto-task creation: typing `- ` (hyphen space) → `- [ ] ` (open task); `* ` stays plain bullet.
- Priority markers (`!`/`!!`/`!!!`) rendering with increasing visual saturation.
- Better numbered lists (indent adjusts to widest number in list).

**Gutter infrastructure**
- Left gutter area for controls (nothing in content area protrudes into padding).
- Heading folding via gutter chevrons (fold/collapse text under headings).
- Drag to reorder via gutter drag handles (tasks, lines, selections within a note).

**Typography & style**
- Fine style adjustments pass: text size, line-height, line margin, bullet centering, marker-to-text gap, heading spacing, blockquote bar position.
- Proportional fonts: SF Pro / system sans-serif for body, serif (New York) for headings, monospace for code only.

**Done when:** Live preview uses the CM6 syntax tree (not regex). Headings can be folded. Lines can be dragged to reorder. Typography feels polished and intentional.

### Phase 4: Daily/weekly notes and calendar

**Goal:** The daily-driver workflow — open today's note, see the compact calendar, get uncompleted weekly items surfaced.

*Sources: PLAN.md Phase 4, FEATURES.md P1 (daily/weekly notes, compact calendar).*

- Calendar notes (daily and weekly) are auto-created when first navigated to or when something is scheduled into them. A note for a given date may never exist if it's never visited or targeted.
- Daily note creation from template if one exists, otherwise blank.
- Weekly note creation (`Calendar/YYYY-Wnn.txt`), same approach.
- Compact calendar widget: shows current month, highlights dates that have notes with open tasks.
- Surface open tasks from the weekly note in a reference panel at the top of daily notes for that week.
- Weekly note workflow: written at start of week; tasks for the week not assigned to a specific day. Re-reviewed mid-week or Friday.

**Done when:** Launching Daymark opens today's daily note with weekly items surfaced, and the calendar lets you navigate to any day.

### Phase 5: Tasks and scheduling

**Goal:** Full task management — checkboxes, scheduling, carry-forward, synced lines, and the unified context menu.

*Sources: PLAN.md Phase 5, FEATURES.md P1 (tasks, scheduling, carry-forward, synced lines, task context menu, click-to-toggle), IDEAS.md (schedule to weekly, convenience shortcuts). Design decisions from 2026-02-25 conversation.*

#### Task interaction
- Left-click task icon = toggle between done and open (most frequent interaction, one click).
- Unified right-click context menu on any line (see § Design Decisions: Unified Context Menu).
- Schedule submenu: Today, tomorrow, relative shortcuts (+1d, +1w, etc.), this week, next week, calendar picker with days and weeks.

#### Scheduling engine
- Parse `>YYYY-MM-DD` syntax, register scheduled items in note index.
- Scheduled tasks pulled into target daily note at top, with `<YYYY-MM-DD` back-reference to source.
- Single-date scheduling constraint: scheduling to a new date replaces the previous `>date`.
- Original task always preserved in source note (marked `[>]`), never removed or moved.
- Schedule to weekly notes (`>YYYY-Wnn`).
- Scheduling convenience shortcuts (`>tomorrow`, `>+1d`, `>+3d`, `>+1w`, `>+1m` → auto-convert to concrete date on entry).

#### `>today` carry-forward (see § Design Decisions: `>today` Carry-Forward)
- `>today` panel at top of today's daily note (open by default, collapsible).
- Panel shows `>today`-tagged tasks from other notes, with source note indicated.
- Panel only on today's daily note (not past daily notes, not weekly notes).
- Drag from panel → synced line in note body, hides from panel.
- Check off in panel → propagates to source.
- Task rolls forward daily until completed — reappears in each new day's panel.

#### Synced lines (see also § Discovered: Synced Lines conventions)
- Block ID format: `^xxxxxx` (6 alphanumeric characters).
- All copies share same `^blockid`; completion propagation updates ALL copies in ALL files.
- Edit propagation: edits to any copy propagate to all others.
- Drag from any pane generates `^blockid` on source line if not present (background write to source file).
- Pane shows all matching references minus those already synced in current note.
- Deleting synced line from note → item reappears in pane.

#### Stale task surfacing
- Tasks with past `>YYYY-MM-DD` still open → surfaced by compact calendar highlighting (not `>today` panel).

#### Note actions (task-dependent)
- Move all open tasks (to another date).
- Move completed tasks to bottom.

**Done when:** You can schedule a task with `>2026-02-25` and it appears in the Feb 25 daily note. `>today` tasks appear in today's panel and roll forward. Dragging from the panel creates synced lines. Editing a synced line updates all copies. Right-click context menu provides all task and line actions.

### Phase 6: Search and mention management

**Goal:** Find anything quickly. Rename mentions globally. @mention reference pane for 1:1 prep.

*Sources: PLAN.md Phase 6, FEATURES.md P1 (search, mention renaming), IDEAS.md (@mention association, reference pane, trashed note search). Design decisions from 2026-02-25 conversation.*

#### Search
- Full-text search across all notes (consider `ripgrep` via Tauri command if performance matters).
- Search UI that doesn't have NotePlan's click-through problem.
- Trashed note search (searchable for recovery, never in autocomplete or link resolution).

#### Mention management
- Global mention rename: `@OldName` → `@NewName` across all files, confirmation dialog with affected file count.
- Mention delete: strip `@` from all occurrences, preserve text (non-destructive).

#### @mention reference pane (see § Design Decisions: @Mention Reference Pane)
- @mention → note association: parse line 2 (first line after H1) for @mentions.
- Reference pane at bottom of associated notes, collapsed by default, one section per tracked @mention.
- Content ordered: open tasks first, then non-task text references; grouped by source note.
- Default filters (toggles, on by default): hide completed tasks, hide content older than 90 days.
- Date inference for 90-day filter: calendar note filename → nearest date heading above @mention → above all dates = most recent (reverse-chron) → no dates = always shown.
- Non-task text as single-line truncated previews.
- Inline expand: click to show surrounding lines from source, supports text selection/copy.
- Drag from pane → synced line in note body, hides from pane (standard drag-from-pane behavior).

**Done when:** Search returns results without accidental navigation. Renaming a mention updates all documents. Person notes show a reference pane with filtered, grouped @mention results. Dragging from the pane creates synced lines.

### Beyond Phase 6

At this point Daymark should be a functional daily driver. Remaining work organized by area.

#### App chrome
- Top bar layout design (prerequisite for menus — decide where date/title, back/forward, menus, date navigation go).
- Format menu: markdown formatting for all content types. Full inventory in IDEAS.md § Editor & Rendering. Image and file attachment support later.
- Note actions menu — initial set: Open in new window, Keep window on top, Show note in Finder, Show note in sidebar.
- Note actions menu — later: View revisions.
- Share menu (contents TBD).
- Settings panel (syntax highlighting, colors, notes directory, sync settings).
- App icon (note + calendar motif).
- Dock icon behavior (single icon, not per-window).

#### Remaining Priority 1 features
- Note templates with logic (conditional/dynamic content).
- Stable links on move (moving a note into a folder must not break links to/from it).

#### Sidebar enhancements
- Sidebar context menus:
  - **Note:** Open in new window, Show in Finder, Copy link, Duplicate, Rename, Archive, Move to trash.
  - **Folder:** New subfolder, New note, Open in new window, Show in Finder, Copy link, Rename, Archive, Move to trash.
  - **Blank area (no target):** New folder, New note, Refresh.
- Drag and drop in sidebar (files into folders, folders into folders; ⚠️ update wiki-links on move).
- Move note while keeping it open.

#### Priority 2 features
- Theming (custom color schemes, dark/light mode).
- Filters (overdue tasks, by project, by tag).
- Vertical calendar / timeline view.
- TimeBlocking (drag tasks onto timeline).
- Calendar integration (Google Calendar / system calendar events inline).

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
- **Tab indentation:** Any content (tasks, bullets, plain text, headings) can be indented with Tab and outdented with Shift+Tab. NotePlan uses tabs on disk. Indentation is structural — it creates subtasks, nested bullets, and block hierarchy.
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

## Design Decisions: @Mentions

Discussed and decided 2026-02-24. #Hashtags will follow the same patterns; @mentions are the priority because they're heavily used.

### Identity

- **Character set:** `@` followed by a letter, then letters, digits, `_`, `/`, `-`. Regex: `@[A-Za-z][A-Za-z0-9_/\-]*`. The `/` allows folder-like prefixes (e.g. `@_old/PersonName`, `@work/PersonName`).
- **Word boundary:** Mentions only start at word boundaries. `email@PersonName` is not a mention. Trailing punctuation (`.`, `,`, `:`, etc.) ends the mention — `@PersonName.` parses as mention `@PersonName` + period.
- **Case:** Case-insensitive matching, case-preserving display. `@angelicabunyi` and `@AngelicaBunyi` resolve to the same mention. Most-frequent form is canonical.
- **No disallowed names:** Any single letter or longer token is valid (`@A`, `@Office`, `@AngelicaBunyi`). `@` alone (nothing following) is not a mention.
- **Name collisions:** Deferred. Manual disambiguation (e.g. `@JohnSmithMarketing`) if needed.

### On disk

Plain text `@PersonName`. No special syntax beyond the `@` prefix. Unchanged from NotePlan.

### V1 behavior: click = search

- **Left-click** an @mention anywhere → search in the main window for all lines containing that mention. Done tasks filtered out by default, with a toggle to include them.
- Clicking in a secondary window also searches in the main window.
- When search occurs, the sidebar @mentions section opens and the target mention is selected.
- **Future exploration:** Associate an @mention with a specific note (e.g. link `@AngelicaBunyi` to `[[Angelica Bunyi, UX Designer]]`) so clicking navigates directly to the person's note with a reference pane. Current workflow: user opens the person's note manually, clicks the @mention written at the top of that note to search, sweeps over results to prep for 1:1s. The association would automate this. V1 uses search; association layers on later. See IDEAS.md § @Mentions for exploration notes.

### Context menu (right-click)

- Search for @MentionName (same as left-click, explicit)
- Search for @MentionName in new window
- Copy mention
- Remove @ from this line (degrades this one occurrence to plain text)
- Plus line-level actions (task actions, synced line actions, etc.) — designed separately

### Autocomplete

- Typing `@` triggers autocomplete dropdown.
- Ranked by frequency (mentions appearing in more active notes rank higher), then alphabetical.
- `@_old/` and other `_`-prefixed mentions rank last but still included.
- Selecting inserts the full `@MentionName`.
- No match = no dropdown. New mentions are created implicitly by typing them; they enter the index on save.

### Editor formatting

- Styled with a subtle background tint and distinct color (reference: NotePlan theme uses `#d87001` with ~12% opacity background).
- The `@` stays visible — it's part of the readable text, not hidden like `[[` brackets.
- Fine-tuning deferred to a styling pass.

### Sidebar: mentions list

- Collapsible section in the left sidebar showing all known mentions.
- Grouped by folder prefix (`@_old/`, `@work/`, etc.). Unprefixed mentions at top. Each group collapsible. `_`-prefixed groups auto-dimmed as inactive.
- Clicking a mention in the sidebar = same as clicking in a note (search in main window, mention selected).
- Reference count shown per mention.

### Rename (global)

- Initiated from the sidebar (not from right-click context menu in the editor).
- Changes `@OldName` to `@NewName` across every file containing it.
- Confirmation dialog showing affected file count before executing.
- Empty name not allowed — the rename field rejects it.

### Delete (non-destructive)

- Initiated from the sidebar.
- Strips the `@` prefix from all occurrences, preserving the text. `@SeanStorlie` → `SeanStorlie` everywhere.
- Confirmation: "This will remove @ from N occurrences across M files. The text will be preserved."
- The mention disappears from the sidebar. **Hard rule: deletion never destroys text content.**

### Stale/orphan mentions

- A mention appearing only in archived/trashed files auto-disappears from the sidebar.
- Still findable via search.

### Discovery/indexing

- Scan-derived from all files. No separate registry.
- Performance monitored — incremental indexing or caching added if scanning becomes slow.
- **Implementation note:** The current regex in `note-index.ts` uses `\w+` which doesn't match `/` or `-`. Update to `[A-Za-z][A-Za-z0-9_/\-]*` when implementing.

---

## Design Decisions: `>today` Carry-Forward

Discussed and decided 2026-02-25.

### Panel design

- `>today` tasks appear in a reference panel at the top of today's daily note.
- Panel is open by default, collapsible.
- Panel only appears on today's daily note — not past daily notes, not weekly notes. Today's note is "home base" for the day's work.
- Each entry shows the task text and its source note.
- `>YYYY-MM-DD` tasks scheduled to today are written into the daily note file, not the panel. The panel is exclusively for `>today`-tagged tasks.

### Interaction

- **Check off in panel:** Toggles the task to done; propagates to the source note.
- **Drag out of panel:** Creates a synced line (`^blockid`) in the note body at the drop position. The task hides from the panel (so it's not shown twice). The source note's original task is always preserved — dragging is non-destructive.
- **Rolling forward:** If a `>today` task is not completed by end of day, it reappears in tomorrow's panel. If it was dragged into today's note, the synced line stays in today's note; the task reappears in tomorrow's panel for re-triage.

### Key distinction from NotePlan

NotePlan's `>today` panel allows dragging tasks out, but this *removes* the task from its source note, destroying context. Daymark's approach: dragging creates a synced line instead, preserving the source. Same UX feel, no information loss.

### Stale tasks

Tasks with a specific `>YYYY-MM-DD` whose date has passed do NOT appear in the `>today` panel — they are surfaced as stale via the compact calendar's open-item highlighting. Only explicitly `>today`-tagged tasks use the rolling panel.

---

## Design Decisions: @Mention Reference Pane

Discussed and decided 2026-02-25.

### @mention → note association

- Parse line 2 (the first line after the H1) for @mentions. Any @mentions found there are the note's tracked associations.
- Notes without an @mention on line 2 have no association and no reference pane.
- No special syntax needed — just @mentions in regular markdown text (e.g., `**See also @BrittanyChoy, [Lattice link](url)**`).
- Multiple @mentions on line 2 are supported (one collapsible section per tracked mention).
- Line 2 is rendered as normal markdown; Daymark quietly notes the @mentions for association purposes.

### Reference pane

- Appears at the bottom of notes with tracked @mentions. One collapsible section per tracked @mention.
- Collapsed by default.
- Content ordered: open tasks first, then non-task text references. Grouped by source note within each section.
- Non-task text shown as single-line truncated previews for compactness.

### Filtering

Default filters (toggles, all on by default):
- **Hide completed tasks** — most @mentions in done tasks are irrelevant for 1:1 prep.
- **Hide content older than 90 days** — uses date inference, no edit tracking needed:
  - Calendar notes: date is the filename.
  - Other notes: nearest date heading (H2, etc.) above the @mention line.
  - Above all date headings: treated as most recent (notes are reverse-chronological).
  - No date headings at all: always shown (never filtered).

### Context viewing

- **Inline expand:** Click any reference line in the pane to expand and show surrounding lines from the source note. Supports text selection and copy. Collapsible.
- Preferred over hover popovers (which are fragile and don't support text selection well).

### Drag from pane

Standard drag-from-pane behavior (see § Design Decisions: Drag-from-Pane):
- Dragging a reference creates a synced line in the note body.
- Hides the item from the pane.
- Deleting the synced line causes the item to reappear in the pane.
- Single task lines only (not subtask blocks).

---

## Design Decisions: Drag-from-Pane (Common Pattern)

Discussed and decided 2026-02-25.

Drag-from-pane is a shared interaction pattern used by both the `>today` panel and @mention reference panes. The behavior is identical in both contexts.

### Mechanics

1. User drags a reference line from any pane into the note body.
2. Daymark creates a synced line at the drop position with a shared `^blockid`.
3. If the source line doesn't already have a `^blockid`, Daymark generates one and writes it to the source file (background write).
4. The dragged item hides from the pane.

### Pane contents

The pane always shows: all references matching its filters, minus any that already exist as synced lines in the current note. This means:
- Dragging out → item disappears from pane (synced copy now exists in note).
- Deleting the synced line → item reappears in pane (no synced copy in note anymore).
- The pane is always a complete, filtered view.

### Non-task lines

Non-task text references are also draggable. NotePlan supports synced lines on any content, not just tasks. Same `^blockid` mechanism.

### `>today` rolling interaction

If a `>today` task is dragged into Monday's note and not completed:
- Tuesday's `>today` panel shows the task again (it rolled forward).
- The synced line remains in Monday's note.
- User decides whether to drag it into Tuesday's note. Checking it off from either Tuesday's panel or Monday's synced line propagates completion to all copies.

---

## Design Decisions: Unified Context Menu

Discussed and decided 2026-02-25.

### Problem

NotePlan has three separate context menus: a scheduling arrow in the gutter, a right-click context menu on lines, and a synced-line menu on the drag handle. This is fragmented and hard to discover.

### Solution

One right-click context menu on any line. Task-specific actions appear conditionally based on task state. Sections separated by dividers.

**Right-click a task line:**

```
Schedule               ▸  (submenu)
Complete / Open / Cancel   (state-dependent, see rules below)
─────────────────────────
Copy Synced Line
Format                 ▸  (submenu: markdown options)
─────────────────────────
Cut
Copy
Paste
Paste as Plain Text
```

**Right-click a non-task line:**

```
Copy Synced Line
Format                 ▸  (submenu: markdown options)
─────────────────────────
Cut
Copy
Paste
Paste as Plain Text
```

### Task action rules

Actions shown depend on current task state:
- **Open task:** Schedule, Complete, Cancel.
- **Done task:** Open (reopen), Cancel.
- **Cancelled task:** Schedule, Complete, Open (reopen).
- **Scheduled task:** Schedule (reschedule), Complete, Cancel.

### Schedule submenu

- `>today` (repeat until completed).
- Tomorrow's date.
- Relative shortcuts: +1d, +3d, +1w, +1m.
- This week (`>YYYY-Wnn`).
- Next week.
- Calendar picker (days and weeks).

### Left-click task icon

Separate from the context menu. Left-clicking the task icon toggles between done and open. This is the most frequent interaction and should be one click.

### Deferred items

- Format submenu contents: populated when the format menu is built (Beyond Phase 6).
- Insert Template: later.
- Insert Table: later.
- Copy wiki link to line: someday/maybe.
- Copy URL to line: someday/maybe.

---

## Open Questions

- **Task state syntax:** Open tasks are usually just `- text` (no brackets), but `- [ ] text` also exists in some older notes. Both forms must be treated as open tasks. Brackets appear consistently for done `[x]`, cancelled `[-]`, and scheduled `[>]`. More states may exist.
- **Template format:** How does NotePlan store and apply templates? Inspect `Notes/@Templates/`.
- **Scheduling compatibility:** We must match NotePlan's on-disk format for scheduled tasks so both apps can coexist. NotePlan docs describe intended behavior; real notes reveal actual behavior. When they diverge, match what's in the files.
- **Calendar grid vs. `>today`:** Tasks scheduled with `>today` should only show as open on today's date and the originating date in the compact calendar — NOT on every intervening day. Document this constraint when implementing the calendar.
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
