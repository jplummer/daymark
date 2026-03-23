# Daymark — Technical Plan

## Current focus

- **Editor list behavior — manual pass + optional Playwright later** — **Automated:** `npm test` — `live-preview.ordered-filter.test.ts` (ordered filter + segment renumbering); `editor-list-keymap.test.ts` (happy-dom + `EditorView`: Enter/Backspace continuation, Tab/Shift-Tab on ordered lines). Handlers live in `editor-list-keymap.ts`, wired from `main.ts` via `listLineKeymapExtensions()`. **Still manual:** paste flows, blockquote Enter, full heading+list matrix, Tauri-only behavior — Playwright against `vite preview` if you want E2E.
- **Thoroughly exercise list continuation, Enter, and Backspace** — Enter continues list/blockquote when line has text (bullet → `* `, ordered → next number with segment rules, task → `- [ ] `, checklist → `+ [ ] `, blockquote → `> `); Enter on marker-only line clears the line; Backspace on marker-only line clears the whole line (task, bullet, ordered, checklist, blockquote). Run through all cases and edge cases in the app (`npm run tauri dev`).

---

## Implementation Phases

Design rationale and discovered conventions live in KNOWLEDGE (Decisions, Learnings, Discovered). Here: what to do and in what order.

### Phase 1: Walking skeleton

**Goal:** Open a markdown file from NotePlan's iCloud directory, edit it with live preview, and save it back. Prove the Tauri + CM6 stack works end-to-end.

**Done when:** You can open a NotePlan daily note, edit it with live preview, save, and confirm NotePlan sees the changes.

**Status: Complete.** See Archive.

### Phase 2: File navigation and watching

**Goal:** Browse and open any note in the NotePlan directory. React to external file changes.

**Done when:** You can navigate between notes via the sidebar, and edits made in NotePlan appear in Daymark without restarting.

**Status: Complete.** See Archive.

### Phase 3a: Note index, links, and navigation

**Goal:** Wiki-links resolve, backlinks work, mentions and tags are clickable, autocomplete works.

*Sources: FEATURES.md P1 (links, backlinks, @mentions, #hashtags). See KNOWLEDGE for @mention design.*

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
- @mention click → search (V1 behavior; see KNOWLEDGE § Decisions).
- #hashtag click → search.
- Careful hashtag parsing (avoid false positives: hex colors, Slack channels, headings, URL fragments).

**Sidebar**
- Folder index view: clicking a folder shows a note listing in the editor area (title + first line preview).

**Done when:** You can click a `[[link]]` to navigate, see backlinks for any note, click an `@mention` to see all notes containing it, type `[[` or `@` for autocomplete, and click a folder to see its contents.

### Phase 3b: Editor rendering and gutter

**Goal:** CM6 rendering is robust and framework-aligned. Editor supports folding and drag-to-reorder. Typography and spacing are refined.

*Sources: FEATURES.md P1 (auto-task creation, priority markers, drag to reorder). See KNOWLEDGE for learnings on tree vs regex fallback.*

**CM6 foundation (do first — before adding more syntax support)**
- CM6 syntax tree refactor: replace regex-based live preview with Lezer parse tree via `syntaxTree(state)` where possible; reduce or eliminate regex fallback (see KNOWLEDGE § Learnings).
- CM6 theme refactor: replace CSS overrides + `!important` with `EditorView.theme()` extension.

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

*Sources: FEATURES.md P1 (daily/weekly notes, compact calendar).*

- Calendar notes (daily and weekly) are auto-created when first navigated to or when something is scheduled into them.
- Daily note creation from template if one exists, otherwise blank.
- Weekly note creation (`Calendar/YYYY-Wnn.txt`), same approach.
- Compact calendar widget: shows current month, highlights dates that have notes with open tasks.
- Surface open tasks from the weekly note in a reference panel at the top of daily notes for that week.
- Weekly note workflow: written at start of week; tasks for the week not assigned to a specific day.

**Open:** Template format — how does NotePlan store and apply templates? Inspect `Notes/@Templates/` when building templates. iCloud Drive vs Setapp container — detect and support both storage locations before replacing NotePlan; prefer iCloud Drive path when available (syncs independently). Calendar grid vs `>today` — tasks with `>today` should only show as open on today's date and the originating date in the compact calendar, not on every intervening day.

**Done when:** Launching Daymark opens today's daily note with weekly items surfaced, and the calendar lets you navigate to any day.

### Phase 5: Tasks and scheduling

**Goal:** Full task management — checkboxes, scheduling, carry-forward, synced lines, and the unified context menu.

*Sources: FEATURES.md P1 (tasks, scheduling, carry-forward, synced lines, task context menu). See KNOWLEDGE for carry-forward, synced lines, drag-from-pane, and unified context menu.*

**Open:** Task state syntax — both `- text` (no brackets) and `- [ ] text` must be treated as open tasks. Brackets appear for done `[x]`, cancelled `[-]`, scheduled `[>]`. More states may exist; catalog as encountered. Scheduling compatibility — match NotePlan's on-disk format for scheduled tasks so both apps can coexist. When docs and real files diverge, match what's in the files.

#### Task interaction
- Left-click task icon = toggle between done and open (most frequent interaction, one click).
- Unified right-click context menu on any line (see KNOWLEDGE § Decisions: Unified Context Menu).
- Schedule submenu: Today, tomorrow, relative shortcuts (+1d, +1w, etc.), this week, next week, calendar picker with days and weeks.

#### Scheduling engine
- Parse `>YYYY-MM-DD` syntax, register scheduled items in note index.
- Scheduled tasks pulled into target daily note at top, with `<YYYY-MM-DD` back-reference to source.
- Single-date scheduling constraint: scheduling to a new date replaces the previous `>date`.
- Original task always preserved in source note (marked `[>]`), never removed or moved.
- Schedule to weekly notes (`>YYYY-Wnn`).
- Scheduling convenience shortcuts (`>tomorrow`, `>+1d`, etc. → auto-convert to concrete date on entry).

#### `>today` carry-forward (see KNOWLEDGE)
- `>today` panel at top of today's daily note (open by default, collapsible).
- Panel shows `>today`-tagged tasks from other notes, with source note indicated.
- Panel only on today's daily note. Drag from panel → synced line in note body, hides from panel. Check off in panel → propagates to source. Task rolls forward daily until completed.

#### Synced lines (see KNOWLEDGE § Discovered)
- Block ID format: `^xxxxxx` (6 alphanumeric characters). All copies share same `^blockid`; completion propagation updates ALL copies. Edit propagation: edits to any copy propagate to all others. Drag from any pane generates `^blockid` on source line if not present.

#### Stale task surfacing
- Tasks with past `>YYYY-MM-DD` still open → surfaced by compact calendar highlighting (not `>today` panel).

#### Note actions (task-dependent)
- Move all open tasks (to another date). Move completed tasks to bottom.

**Done when:** You can schedule a task with `>2026-02-25` and it appears in the Feb 25 daily note. `>today` tasks appear in today's panel and roll forward. Dragging from the panel creates synced lines. Editing a synced line updates all copies. Right-click context menu provides all task and line actions.

### Phase 6: Search and mention management

**Goal:** Find anything quickly. Rename mentions globally. @mention reference pane for 1:1 prep.

*Sources: FEATURES.md P1 (search, mention renaming). See KNOWLEDGE for @mention reference pane and drag-from-pane.*

#### Search
- Full-text search across all notes (consider `ripgrep` via Tauri command if performance matters).
- Search UI that doesn't have NotePlan's click-through problem.
- Trashed note search (searchable for recovery, never in autocomplete or link resolution).

#### Mention management
- Global mention rename: `@OldName` → `@NewName` across all files, confirmation dialog with affected file count.
- Mention delete: strip `@` from all occurrences, preserve text (non-destructive).

#### @mention reference pane (see KNOWLEDGE)
- @mention → note association: parse line 2 (first line after H1) for @mentions.
- Reference pane at bottom of associated notes, collapsed by default, one section per tracked @mention.
- Content ordered: open tasks first, then non-task text references; grouped by source note.
- Default filters (toggles, on by default): hide completed tasks, hide content older than 90 days.
- Inline expand: click to show surrounding lines from source, supports text selection/copy.
- Drag from pane → synced line in note body, hides from pane.

**Done when:** Search returns results without accidental navigation. Renaming a mention updates all documents. Person notes show a reference pane with filtered, grouped @mention results. Dragging from the pane creates synced lines.

### Beyond Phase 6

At this point Daymark should be a functional daily driver. Remaining work organized by area.

#### App chrome
- Top bar layout design (prerequisite for menus — decide where date/title, back/forward, menus, date navigation go).
- Format menu: markdown formatting for all content types. Image and file attachment support later.
- Note actions menu — initial set: Open in new window, Keep window on top, Show note in Finder, Show note in sidebar.
- Note actions menu — later: View revisions.
- Share menu (contents TBD).
- Settings panel (syntax highlighting, colors, notes directory, sync settings).
- App icon (note + calendar motif).
- Dock icon behavior (single icon, not per-window).

#### Remaining Priority 1 features
- Note templates with logic (conditional/dynamic content). Open: inspect `Notes/@Templates/` for NotePlan format.
- Stable links on move (moving a note into a folder must not break links to/from it).

#### Sidebar enhancements
- Sidebar context menus (Note, Folder, Blank area — see FEATURES or prior spec).
- Drag and drop in sidebar (files into folders; update wiki-links on move).
- Move note while keeping it open.

#### Priority 2 features
- Theming, filters, vertical calendar / timeline view, TimeBlocking, calendar integration.

---

## Someday / exploratory

Things we might want but aren't committed to. Some need significant investigation before we'd even know if they're worth doing.

- **Local MCP server or agent-accessible API** — Expose tools and content (notes, tasks, calendar) to an agent via a local MCP server or other interface so external tools can read/write Daymark data.
- **Stale tasks review process** — A workflow or view to surface and triage tasks that have been open a long time or are past due.
- **Recently accessed notes** — Quick access to recently opened notes (we have `recentNotePaths`; expose it in the UI, e.g. in sidebar or a "Recent" virtual folder).
- **BYO agent integration** — Integrate with Claude, Gemini, ChatGPT, or other agents (e.g. for summarization, task extraction, or inline assistance). Depends on how we expose data (see MCP / agent-accessible API).
- **Optional periodic notes beyond daily and weekly** — e.g. monthly, quarterly, or custom cadences. NotePlan has daily and weekly; some users want more.
- **Backlinks panel** — Pane showing notes that link to the current note. Explore grouping/filtering to reduce noise (see Smarter backlinks).
- **Default PARA folders** — Projects, Areas, Resources, Archive as default sidebar structure or template.
- **Templates** — Note templates with optional logic for creating new notes (daily, weekly, project kickoff, etc.).
- **Theme editor** — Very low priority. UI to tweak the default theme (colors, fonts) for users who want to adjust without editing CSS.
- **Quick capture from anywhere** — A way to quickly capture tasks and text from anywhere (vague on purpose — expresses the need for low-friction capture outside the main editor).
- **iPhone and iPad app** — VERY LOW priority while we interop with NotePlan. Native or hybrid; would need to share the same note store and sync story.
- **Interop with Obsidian and other note stores** — Ability to interact with Obsidian and other text-and-markdown-based note apps. Neat to think about; might never happen.
- **Caret-shaped back/forward icons** — Current back/forward icons could be more caret-like. Low priority cosmetic.
- **Flexible notes directory** — Long-term, Daymark should be able to point at any folder of markdown files, not just NotePlan's directory. Users should be able to choose `.md` or `.txt` as the file extension (or accept both). For now, targeting NotePlan's exact conventions is the right call, but the architecture should avoid hard-coding assumptions that would make this difficult later.
- **Schedule to quarterly notes** — NotePlan syntax is `>YYYY-Qn` (e.g. `>2026-Q1`). Lower priority.
- **Weekly carry-forward (`>thisweek`?)** — No weekly equivalent to `>today` exists in NotePlan. Could be useful for tasks that should roll week-to-week until done, but not yet clear if needed.
- **Link to a specific section of a note** — `[[Note Title#Section]]` or similar. NotePlan may support this but it's unused. Explore later.
- **Smarter note rename** — NotePlan keeps the old filename when you change a note's H1, then offers to update links. Could we rename the file too? Needs thought around backward compatibility.
- **Smarter backlinks** — NotePlan's backlinks panel is noisy (piles of "prep for [[link]]" entries from daily notes). Explore ways to make backlinks more useful: grouping, filtering, collapsing routine references, surfacing only meaningful ones.
- **Email addresses as mailto: links** — Well-qualified email addresses (e.g. `person@example.com`) should render as clickable `mailto:` links, similar to how bare URLs become clickable links. Low priority.
- **Refine @mention sidebar badge** — Currently shows active note count. Could be more useful — e.g. count of open tasks mentioning the person, or total line references. Consider what's most actionable for meeting-prep workflows.
- **Copy wiki link to line** — Context menu action to copy a `[[wiki-link]]` pointing to a specific line. Low priority.
- **Copy URL to line** — Context menu action to copy a URL pointing to a specific line. Low priority.

---

## Archive

Finished tasks, jobs, and phases (newest first). Full detail preserved here; README has a short Implemented summary.

**Most recent (ordered lists, layout, tests)**

- **Nested ordered lists** — Renumbering restarts at `1)` at each indent level when a shallower line appears between two deeper ordered lines (segment breaks via `indentBreaksBetween` in `live-preview.ts`).
- **Hidden “syntax” layout** — `HiddenWidget` renders replaced text with `opacity:0` + `white-space:pre` so vertical cursor motion (`ArrowUp` / `posAtCoords`) does not skip lines whose leading indent was `display:none`.
- **Vitest** — `src/live-preview.ordered-filter.test.ts` (Node). **`editor-list-keymap.ts`** — Tab / Shift-Tab / Enter / Backspace extracted from `main.ts`; **`editor-list-keymap.test.ts`** uses happy-dom + `EditorView`. `vitest.config.ts` defaults to Node; per-file `@vitest-environment happy-dom` for DOM tests.

**Most recent (editor list/blockquote and autolink)**

- **Editor list and blockquote behavior** — Task/list styling with replace widgets; wrapping and indent for heading, list, blockquote; numbered lists basic support (editable numbers, Tab indent, Enter continues); Enter/Backspace rules (continue list/blockquote when line has text, clear marker-only line on Enter or Backspace). All marker types (task, bullet, ordered, checklist, blockquote) covered.
- **Angle-bracket autolink `<url>`** — We style `<https://...>` as a link in live preview (tree and regex path).

**2026-02-22**

- **Phase 2: File navigation and watching — Complete.** Sidebar with file tree (note titles, not filenames), Daily/Weekly quick links, Archive/Templates/Trash separated below. Back/forward navigation with Cmd+[/]. Weekly notes show date ranges and support prev/next. Project notes show path breadcrumb with emphasized title. Light/dark mode via system preference. Remix Icons throughout. Drag-to-resize sidebar. External change detection via polling (2s note, 5s directory).
- **Fix text selection bug** — Live preview no longer rebuilds decorations on every selection event; only when cursor position changes with a collapsed selection.
- **Inline-scoped decorations** — Markdown syntax only reveals for the specific element the cursor is within, not the whole line. Heading font size always applied; only `#` prefix is inline-scoped.
- **External link handling** — Markdown links `[text](url)` show as "text ↗" on non-cursor lines. Bare URLs styled as clickable links. Click opens in default browser via Tauri opener. Ctrl-click (macOS right-click) does not follow.
- **Paste URL → auto-title** — Pasting a bare URL wraps it as `[Fetching title…](url)` and async-fetches the `<title>` tag, replacing the placeholder.
- **Task icons** — All task markup (`- `, `- [ ] `, `- [x] `, `- [-] `, `- [>] `) replaced by Remix Icon circle icons (open, done, cancelled, scheduled). Done tasks mute the entire line. `* ` bullets left as plain markdown.
- **Selection highlight fix** — Replaced `drawSelection()` with native browser selection for reliable visibility over opaque line backgrounds.
- **Task iconography** — Resolved. Circle-based Remix Icons where each icon maps to its markdown character's meaning: empty circle (open), circle+checkmark (done `[x]`), circle+horizontal dash (cancelled `[-]`), circle+right arrow (scheduled `[>]`). Cancelled icon avoids X shape to prevent conflict with `[x]` done markdown.
- **Internal vs external link distinction** — External links show as "text ↗" with blue styling; wiki-links `[[text]]` show with distinct link styling. Both clickable with different behavior (external opens browser, wiki-links navigate internally in Phase 3).

**Before 2026-02-22 (pre-tracking)**

- **Phase 1: Walking skeleton — Complete.** Open a markdown file from NotePlan's iCloud directory, edit it with live preview, save it back. Tauri + CM6 stack works end-to-end. Edits round-trip to NotePlan. Added date navigation (prev/today/next) and live preview decorations (headings, bold, italic, strikethrough, inline code, wiki-links, task checkboxes). Line numbers removed per preference.
- **Weekly notes (resolved)** — Stored in `Calendar/` alongside daily notes. Filename: `YYYY-Wnn.txt` (e.g. `2026-W07.txt`). Content is a week plan: tasks for the week not assigned to a specific day. Support `<YYYY-Wnn` back-references. Open tasks from the weekly note are shown in a reference panel at the top of all daily notes in that week.
- **Scheduling: completion model (resolved)** — For non-synced `>YYYY-MM-DD` tasks, the source stays `[>]` ("delegated") regardless of destination state. Completion status lives only on the `<date` destination copy. The source doesn't need to know if the task was done — `[>]` means "sent elsewhere." The compact calendar only needs to check the target date for open items.
- **Icon source selection** — Evaluated icon options; chose Remix Icon via npm.
