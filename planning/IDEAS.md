# Ideas

## Will Build

Ordered roughly by functional priority. Items marked ⚠️ require significant investigation or design work before implementation.

### Editor & Rendering

- ⚠️ **Use CM6 syntax tree instead of regex for live preview** — Current prototype uses regex to find markdown syntax. CM6 has a proper Lezer parse tree via `syntaxTree(state)`. Switching to tree-walking will be more robust and handle edge cases. Do this before adding more syntax support.
- **Autocomplete polish** — Icons in the wiki-link autocomplete dropdown (e.g. file icon for notes, folder icon for context). Visual divider between active and archived sections of the result list.
- **Heading folding** — Fold/collapse text under headings. Standard editor feature for long notes.
- **Left gutter controls** — The generous left padding area will house controls for line/block dragging, heading folding, and task scheduling. Nothing in the content area should protrude into this padding.
- **Fine style adjustments pass** — Dedicated pass over typography and spacing: text size, line-height, line margin, bullet centering, marker-to-text gap, heading spacing, blockquote bar position. Current values (16px / 1.4 / 8px margin) are rough-in; refine together.
- **Better numbered lists** — NotePlan handles numbered/ordered lists poorly. Opportunity to do better. Note: numbered list indent should adjust to the widest number in the list.
- ⚠️ **Refactor CM6 styling to use `EditorView.theme()` (Option C)** — Currently we layer CSS on top of CM6's default base theme, using `calc()` offsets and `!important` to work around its hidden `padding: 0 2px 0 6px` on `.cm-line`. This works but is fragile and hard to reason about. The proper CM6 approach is to define our own theme extension via `EditorView.theme()`, which merges with correct specificity and eliminates `!important`. Moves some CSS into TypeScript but works *with* the framework. Good refactor point: when we add numbered lists or re-enable dark mode, since we'd be touching all spacing logic anyway.
- **Format menu** `[Phase 3]` — Top bar icon that launches a menu for inserting or applying content types. Everything in the menu should also be typable directly in markdown. Full content type inventory:
    - Already rendering (Phase 1): headings 1–6, bold, italic, strikethrough, inline code, task, bullet point, URL.
    - Need rendering + input support `[Phase 3]`: table, code block, quote, horizontal rule, note link, checklist item, `!`/`!!`/`!!!` priority markers.
    - Need file handling `[Beyond Phase 6]`: add image, add file attachment.
- **Make it clear what's an internal and external link** — markdown link for external, double bracket for internal. Visual distinction in the editor.
- **Proportional fonts for body text** — CM6 handles variable-width text fine. Use SF Pro / system sans-serif for body, a serif like New York for headings, monospace only for code. Match the NotePlan theme feel.

### @Mentions

Core @mention behavior (identity, click, autocomplete, sidebar, rename, delete) is specified in PLAN.md § Design Decisions: @Mentions. Remaining ideas:

- ⚠️ **@mention → note association** — Associate an @mention with a specific note (e.g. link `@AngelicaBunyi` to `[[Angelica Bunyi, UX Designer]]`). If established, clicking the mention could navigate directly to the person's note instead of running a search. Options to explore: explicit `@mention:` line in the note, fuzzy name matching, or both. Prerequisite for the reference pane below.
- ⚠️ **@mention reference pane** — When viewing a person's note, show a reference pane listing all tasks across all notes that mention that person. Done tasks filtered by default. One-click to navigate to the source. The goal: "show me everything I need to talk to this person about" in one place, zero gymnastics. Depends on the mention → note association above.

### Scheduling

- **Schedule to weekly notes** — NotePlan syntax is `>YYYY-Wnn` (e.g. `>2026-W08`). Useful for "I won't get to this today, put it on next week's plan."
- **Scheduling convenience shortcuts** — `>tomorrow`, `>Friday`, `>+1d`, `>+3d`, `>+1w`, `>+1m` etc., auto-converted to a concrete `>YYYY-MM-DD` on entry. Lower priority than getting `>today` and `>YYYY-MM-DD` right.

### Navigation & File Management

- **Context menu and command-click to open a link in a new window** — Standard link UX behavior.
- **Drag and drop in sidebar** — Drag files into folders and folders into folders. Especially useful for tidying up the archive. ⚠️ Would need to update any wiki-links that reference moved notes.
- **Move note while keeping it open** — Currently you close a note, move it in the sidebar, then re-navigate. Being able to move it without closing would reduce mistakes.
- **Trashed note search** — Trashed notes should be searchable (for recovery) but never appear in autocomplete or link resolution.

### App Chrome

- ⚠️ **Top bar layout** `[Phase 3]` — Design the top bar arrangement before building menus. Decisions needed: where date or path+title goes, where back/forward actions go, where format menu / note actions / share icons go, where date navigation goes on calendar notes. Prerequisite for the menu items below.
- **Note actions menu** `[Phase 3]` `[Phase 5]` — Top bar icon that launches note-level actions:
    - Initial set `[Phase 3]`: Open in new window, Keep window on top, Show note in Finder, Show note in sidebar.
    - Task-dependent actions `[Phase 5]`: Move all open tasks, Move completed tasks to bottom.
    - Later `[Beyond Phase 6]`: View revisions.
- **Share menu** `[Beyond Phase 6]` — Top bar icon for sharing a note. Contents TBD.
- Eventually we will need a **settings panel** for
    - syntax highlighting options
    - colors and styling
    - location of notes (see "flexible notes directory" in Someday/Maybe)
    - sync settings
- Simple note + calendar **app icon** for Daymark.
- Not have an icon in the dock for every window.

### Reference

- **NotePlan theme reference** — Favorite theme is "JP Dieter Rams New York". All four JP theme JSONs are cached in `planning/reference/` for easy access. Key style choices: gold headings (#736B1E) in New York Semibold, red open tasks (#ED3F1C), faded syntax markers (#35000000), subtle tag/mention backgrounds (#20d87001), highlighted text (yellow bg), code in SF Mono with light gray bg. Also shows NotePlan's full style vocabulary (flagged states, working-on, schedule links, etc.) which hints at features we'll encounter. Source: `~/Library/Containers/co.noteplan.NotePlan-setapp/.../Themes/`.

---

## Someday / Maybe

Things we might want but aren't committed to. Some need significant investigation before we'd even know if they're worth doing.

- **Caret-shaped back/forward icons** — Current back/forward icons could be more caret-like. Low priority cosmetic.
- **Flexible notes directory** — Long-term, Daymark should be able to point at any folder of markdown files, not just NotePlan's directory. Users should be able to choose `.md` or `.txt` as the file extension (or accept both). For now, targeting NotePlan's exact conventions is the right call, but the architecture should avoid hard-coding assumptions that would make this difficult later.
- **Schedule to quarterly notes** — NotePlan syntax is `>YYYY-Qn` (e.g. `>2026-Q1`). Lower priority.
- ⚠️ **Weekly carry-forward (`>thisweek`?)** — No weekly equivalent to `>today` exists in NotePlan. Could be useful for tasks that should roll week-to-week until done, but not yet clear if needed.
- **Link to a specific section of a note** — `[[Note Title#Section]]` or similar. NotePlan may support this but it's unused. Explore later.
- ⚠️ **Smarter note rename** — NotePlan keeps the old filename when you change a note's H1, then offers to update links. Could we rename the file too? Needs thought around backward compatibility.
- ⚠️ **Smarter backlinks** — NotePlan's backlinks panel is noisy (piles of "prep for [[link]]" entries from daily notes). Explore ways to make backlinks more useful: grouping, filtering, collapsing routine references, surfacing only meaningful ones.
- **Email addresses as mailto: links** — Well-qualified email addresses (e.g. `person@example.com`) should render as clickable `mailto:` links, similar to how bare URLs become clickable links. Low priority.

---

## Archive

Items completed before 2026-02-22 (exact dates not tracked):

- **Icon source selection** — Evaluated icon options; chose Remix Icon via npm. *(pre-tracking)*

Items completed 2026-02-22:

- **Task iconography** — Resolved. Circle-based Remix Icons where each icon maps to its markdown character's meaning: empty circle (open), circle+checkmark (done `[x]`), circle+horizontal dash (cancelled `[-]`), circle+right arrow (scheduled `[>]`). Cancelled icon avoids X shape to prevent conflict with `[x]` done markdown.
- **Internal vs external link distinction** — External links show as "text ↗" with blue styling; wiki-links `[[text]]` show with distinct link styling. Both clickable with different behavior (external opens browser, wiki-links will navigate internally in Phase 3).
