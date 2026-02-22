# Daymark — Feature Prioritization

## Overview

This document captures the features of [NotePlan](https://noteplan.co/features) and prioritizes them for a reimplementation focused on performance and simplicity.

## Priority 1: Must Have (Core Experience)

These features define the app. Ship nothing without them.

- **Daily & Weekly notes** — Weekly items that aren't completed appear at top of daily note.
- **Project notes** — Long-lived notes (not tied to a date) with tasks, links, etc.
- **Tasks** — Inline tasks in any note; checkboxes, completion state.
- **Scheduling (`>YYYY-MM-DD`)** — Schedule a task to a specific day's Daily Note. The task stays in the originating note (marked `[>]`) and a synced copy is written into the target daily note file with a `<YYYY-MM-DD` back-reference. Checking off a task checks it off everywhere it appears. Scheduling can originate from any note — project notes, 1:1 notes, or past daily notes.
- **Carry-forward (`>today`)** — Distinct from date scheduling. `>today` marks a task for today with automatic carry-forward: if not completed, it appears at the top of tomorrow's note, and so on until done. In NotePlan this is rendered via a reference panel (not written into the daily note file), which has a bad side-effect: dragging a task out of the panel removes it from the source note, destroying context. **Design principle:** the originating task must always be preserved in its source note. We need a better approach than NotePlan's reference panel — discuss before implementing.
- **Synced lines** — Tasks scheduled into a daily/weekly note via `>date` appear as synced references. Edits to a synced line propagate back to the source note (and vice versa), so the task doesn't diverge across locations.
- **Task context menu** — Right-click a task to schedule it, complete it, cancel it, etc. Includes a date picker and shortcuts like `>today`, tomorrow's date, etc. A discoverable alternative to memorizing syntax.
- **Drag to reorder** — Drag tasks, lines, or selections to reposition them within a note.
- **Auto-task creation** — Typing `- ` (hyphen space) at the start of a line automatically converts to `- [ ] ` (open task). `* ` (asterisk space) remains a plain markdown bullet.
- **Links & backlinks** — `[[wiki-links]]` that resolve by title; backlink panel showing inbound references.
- **Stable links on move** — Moving a note into a folder must not break links to/from it.
- **@mentions and #hashtags** — Clickable, searchable; function as lightweight taxonomy.
- **Mention renaming / consolidation** — Rename an @mention globally, updating every document that contains it.
- **Note templates with logic** — Create notes from templates; templates support conditional/dynamic content.
- **Custom markdown formatting** — Custom syntax highlighting for extended markdown elements (e.g. task states, dates, tags).
- **Compact calendar** — Calendar widget highlighting past/future dates that have open items.
- **Sidebar file/folder browser** — Left-column tree view for navigating notes and folders. The primary way to find and open notes (alongside search and links).
- **Search** — Full-text search across all notes; clickable @mentions as primary search entry point. NotePlan's search UI has issues (clicks fall through to underlying note, causing unintended navigation) — we should do better here.
- **Sync with conflict resolution** — See "Sync strategy" below.

### Sync strategy: piggyback on iCloud Drive

NotePlan stores notes as plain-text files (`.txt`, not `.md`). The storage location depends on the install:
- **Setapp version:** `~/Library/Containers/co.noteplan.NotePlan-setapp/Data/Library/Application Support/co.noteplan.NotePlan-setapp/`
- **App Store / direct version:** `~/Library/Mobile Documents/iCloud~co~noteplan~NotePlan3/Documents/` (iCloud Drive container)

The Setapp version uses CloudKit sync internally rather than iCloud Drive file-level sync. Both versions use the same file format and directory structure.

**Plan:** Read/write NotePlan's files directly. This gives us:
- Cross-machine sync via iCloud Drive with zero additional work.
- Side-by-side use with NotePlan during development (same data, two UIs).
- No sync engine to build or maintain.

**How iCloud Drive handles conflicts:** Last-writer-wins with conflict copies. If two machines edit the same file before sync completes, iCloud creates a duplicate (e.g. `filename 2.md`) rather than merging. This is the same behavior NotePlan already deals with — we don't make it worse.

**The one thing to avoid:** Editing the same note in both apps simultaneously on the same machine. NotePlan holds file contents in memory and writes on save, so concurrent writes from two processes could cause one to silently overwrite the other. Easy to avoid in practice during development.

**Trade-off:** We inherit NotePlan's file/folder structure and naming conventions. We should document those conventions as we discover them. If we ever want to decouple from NotePlan entirely, we'd need our own sync — but that's a distant concern.

## Priority 2: Nice to Have (Use but Can Defer)

- **Theming** — Custom color schemes, dark/light mode.
- **Filters** — Structured filters (overdue tasks, by project, by tag, etc.) — not yet used because NotePlan's search UI is clunky, but could be valuable once search UX is solid.
- **Vertical calendar / timeline view** — Day view with hour blocks; used for timeblocking.
- **TimeBlocking** — Drag tasks onto a timeline to allocate focus time.
- **Calendar integration** — Sync with Google Calendar / system calendar to show events inline.

## Priority 3: Not Needed

- **Plugins** — NotePlan's plugin system.
- **LLM / AI features** — Smart Note Assistant, AI summarization, etc.
- **Kanban board view**
- **Sketch & Transcribe** — Handwriting → text on iPad/iPhone.
- **Voice Notes** — Voice-to-text dictation — may be useful later, revisit.
- **Memo AI** — Voice notes → structured insights (new feature).

## Unsorted / Needs Clarification

_Nothing currently unsorted. Move items here if new features surface._

---

## Technical Direction

Decided. See PLAN.md for full rationale.

- **Platform:** Tauri (Rust + web frontend)
- **Editor engine:** CodeMirror 6
- **Starting point:** Greenfield (no fork)
- **File format:** Match NotePlan's conventions exactly (read/write their iCloud Drive files directly)
