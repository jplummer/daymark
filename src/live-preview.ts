/**
 * Live preview extension for CodeMirror 6.
 *
 * Hides markdown syntax characters (e.g. **, ##, [[, ]]) via replace
 * decorations. Hidden delimiters use a zero-width widget so they do not
 * occupy horizontal space when not shown (faded) on the cursor line.
 * Leading indent before headings/lists/blockquotes still uses an invisible
 * copy of the real characters so wrapped lines and vertical motion stay stable.
 *
 * Currently handles: headings, blockquotes, bold, italic, wiki-links,
 * inline code, strikethrough, task checkboxes, and external links.
 *
 * Styling is hard-coded for now. The decoration styles live in
 * styles.css under .cm-live-preview-* classes, and can be made
 * configurable later.
 */

import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { EditorSelection, EditorState, Range, Transaction } from '@codemirror/state';
import { indentUnit, syntaxTree } from '@codemirror/language';

// --- Widgets for replacing syntax tokens ---

/**
 * Invisible copy of source text — for leading indent only. Zero-width
 * replacements broke vertical cursor motion on indented / wrapped lines.
 */
class HiddenWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-live-preview-hidden-text';
    span.textContent = this.text;
    return span;
  }

  eq(other: HiddenWidget) {
    return other instanceof HiddenWidget && other.text === this.text;
  }
}

function layoutPreservingHiddenRange(state: EditorState, from: number, to: number) {
  return Decoration.replace({
    widget: new HiddenWidget(state.sliceDoc(from, to)),
  }).range(from, to);
}

class CollapsedHiddenWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-live-preview-collapsed-syntax';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }

  eq(other: CollapsedHiddenWidget) {
    return other instanceof CollapsedHiddenWidget;
  }
}

function collapsedHiddenRange(from: number, to: number) {
  return Decoration.replace({
    widget: new CollapsedHiddenWidget(),
  }).range(from, to);
}

// Remix Icon class names for task states (match sidebar / index.html usage)
const TASK_ICON_CLASS: Record<TaskState, string> = {
  open: 'ri-circle-line',
  done: 'ri-checkbox-circle-line',
  cancelled: 'ri-indeterminate-circle-line',
  scheduled: 'ri-arrow-right-circle-line',
};

/** Inline widget that replaces the list/task marker range. CM6 treats replaced range as atomic. */
class MarkerWidget extends WidgetType {
  constructor(
    readonly kind: ListLineKind,
    readonly taskState?: TaskState,
    readonly taskBoxFrom?: number,
    readonly taskBoxTo?: number,
    /** For ordered lists: label to show (e.g. "1." or "10)"). */
    readonly orderedLabel?: string,
  ) {
    super();
  }

  /**
   * Default true: editor ignores pointer events so the task icon’s mousedown listener can toggle.
   * For contextmenu, return false so CM6 treats the event as editor input — otherwise
   * `eventBelongsToEditor` bails and `domEventHandlers.contextmenu` (task line menu) never runs.
   */
  ignoreEvent(event: Event): boolean {
    if (this.kind !== 'task' || this.taskBoxFrom === undefined) return true;
    if (event.type === 'contextmenu') return false;
    return true;
  }

  toDOM(view: EditorView) {
    const span = document.createElement('span');
    span.className = 'cm-live-preview-marker-widget';
    if (this.kind === 'task' && this.taskState !== undefined) {
      span.classList.add(`cm-live-preview-marker-task-${this.taskState}`);
      if (this.taskBoxFrom !== undefined && this.taskBoxTo !== undefined) {
        span.dataset.taskBoxFrom = String(this.taskBoxFrom);
        span.dataset.taskBoxTo = String(this.taskBoxTo);
        span.style.cursor = 'pointer';
        const from = this.taskBoxFrom;
        const to = this.taskBoxTo;
        span.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const doc = view.state.doc;
          if (from < 0 || to > doc.length) return;
          if (from === to) {
            // Shortcut task "- " or "+ ": no [ ] in doc; insert "[x] " to mark done.
            view.dispatch({ changes: { from, to, insert: '[x] ' } });
          } else {
            const box = doc.sliceString(from, to);
            const next = box === '[ ]' ? '[x]' : box === '[x]' ? '[ ]' : null;
            if (next) view.dispatch({ changes: { from, to, insert: next } });
          }
        });
      }
      const i = document.createElement('i');
      i.className = TASK_ICON_CLASS[this.taskState];
      span.appendChild(i);
    } else if (this.kind === 'bullet') {
      span.classList.add('cm-live-preview-marker-bullet');
      span.textContent = '\u2022'; /* • */
    } else {
      span.classList.add('cm-live-preview-marker-ordered');
      span.textContent = this.orderedLabel ?? '\u25CB'; /* number or ○ */
    }
    return span;
  }

  eq(other: MarkerWidget) {
    return (
      this.kind === other.kind &&
      this.taskState === other.taskState &&
      this.taskBoxFrom === other.taskBoxFrom &&
      this.taskBoxTo === other.taskBoxTo &&
      this.orderedLabel === other.orderedLabel
    );
  }
}

class LinkArrowWidget extends WidgetType {
  constructor(readonly href: string) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-live-preview-extlink-arrow';
    span.textContent = ' ↗';
    span.dataset.href = this.href;
    return span;
  }

  eq(other: LinkArrowWidget) {
    return this.href === other.href;
  }
}

const syntaxFade = Decoration.mark({ class: 'cm-live-preview-syntax-fade' });
/** Single mark: nested syntax-fade + number-zone broke inline-block/margin; combined matches the widget slot. */
const orderedNumberEditMark = Decoration.mark({
  class: 'cm-live-preview-ordered-number-zone cm-live-preview-syntax-fade',
});

// --- Line decorations ---

const headingLineDecos: Record<number, Decoration> = {};
for (let level = 1; level <= 6; level++) {
  headingLineDecos[level] = Decoration.line({ class: `cm-live-preview-h${level}` });
}

const blockquoteLineDeco = Decoration.line({ class: 'cm-live-preview-blockquote' });
/** Set to true to log every blockquote application (path, line number, line text) to console. */
const DEBUG_BLOCKQUOTE = false;
const setextUnsupportedLineDeco = Decoration.line({ class: 'cm-live-preview-setext-unsupported' });

const listLineDeco = Decoration.line({ class: 'cm-live-preview-list-line' });
const doneTaskLineDeco = Decoration.line({ class: 'cm-live-preview-task-done-line' });
const cancelledTaskLineDeco = Decoration.line({ class: 'cm-live-preview-task-cancelled-line' });
const cancelledTextMark = Decoration.mark({ class: 'cm-live-preview-task-cancelled-text' });
const scheduledTaskLineDeco = Decoration.line({ class: 'cm-live-preview-task-scheduled-line' });

const indentLineDecos: Record<number, Decoration> = {};
for (let n = 1; n <= 3; n++) {
  indentLineDecos[n] = Decoration.line({ class: `cm-live-preview-indent-${n}` });
}

// --- Build decorations from syntax tree (when available) ---

interface ListLineInfo {
  listMark: { from: number; to: number };
  taskMarker?: { from: number; to: number };
}

export type ListLineKind = 'task' | 'bullet' | 'ordered';
export type TaskState = 'open' | 'done' | 'cancelled' | 'scheduled';

export interface ResolvedListLine {
  kind: ListLineKind;
  taskState?: TaskState;
  markerFrom: number;
  markerTo: number;
  /** For tasks: doc range of the "[ ]" / "[x]" etc. box (for click-to-toggle). */
  taskBoxFrom?: number;
  taskBoxTo?: number;
  /** For ordered lists: marker text to show in widget (e.g. "1." or "10)"). */
  orderedMarkerText?: string;
  /** For ordered lists: delimiter used ('.' or ')') so we keep it when renumbering. */
  orderedDelimiter?: '.' | ')';
}

function buildDecorationsFromTree(
  state: EditorState,
  cursorPos: number,
  decorations: Range<Decoration>[],
  listLineMap: Map<number, ResolvedListLine>,
): void {
  const tree = syntaxTree(state);
  const doc = state.doc;
  if (tree.length < doc.length) return;

  const cursorIn = (from: number, to: number) =>
    cursorPos >= from && cursorPos <= to;
  /** True when cursor is inside the range or immediately before/after it (undecorate links). */
  const cursorInOrAdjacent = (from: number, to: number) =>
    (cursorPos >= from && cursorPos <= to) ||
    (from > 0 && cursorPos === from - 1) ||
    cursorPos === to + 1;

  const listLinesByLineFrom = new Map<number, ListLineInfo>();

  tree.iterate({
    enter(node) {
      const name = node.type.name;
      const { from, to } = node;

      // ATX headings: optional leading indent then ## Title
      const atxMatch = /^ATXHeading(\d)$/.exec(name);
      if (atxMatch) {
        const level = parseInt(atxMatch[1], 10);
        const line = doc.lineAt(from);
        decorations.push(headingLineDecos[level].range(line.from));
        if (line.from < from) {
          const leadingLen = from - line.from;
          const leadingPart = doc.sliceString(line.from, from);
          const tabCount = (leadingPart.match(/\t/g) ?? []).length;
          const spaceCount = (leadingPart.match(/ /g) ?? []).length;
          const indentLevel = Math.min(Math.max(tabCount, Math.floor(spaceCount / 4)), 3);
          decorations.push(indentLineDecos[indentLevel].range(line.from));
          decorations.push(layoutPreservingHiddenRange(state, line.from, line.from + leadingLen));
        }
        return;
      }

      // Setext headings (Title\n=== / ---) are not supported; apply a line class to override syntax highlighter (e.g. underline).
      const setextMatch = /^SetextHeading(\d)$/.exec(name);
      if (setextMatch) {
        let pos = from;
        while (pos < to) {
          const line = doc.lineAt(pos);
          decorations.push(setextUnsupportedLineDeco.range(line.from));
          pos = line.to + 1;
        }
        return;
      }

      // # prefix: when cursor on line show ## faded; when cursor off line hide ## and following space.
      // Skip Setext underlines (line of only = or -) so they are not treated as heading syntax.
      if (name === 'HeaderMark') {
        const line = doc.lineAt(from);
        if (line.from === from && /^=+$|^-+$/.test(line.text)) return;
        const cursorOnThisLine = doc.lineAt(cursorPos).number === line.number;
        const fadeEnd = Math.min(to, line.to);
        if (cursorOnThisLine) {
          decorations.push(syntaxFade.range(from, fadeEnd));
        } else {
          const hideEnd = to < line.to && doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
          decorations.push(collapsedHiddenRange(from, Math.min(hideEnd, line.to)));
        }
        return;
      }

      // Blockquote: style lines that have ">" (optional leading whitespace); indent + hidden for leading tabs/spaces.
      if (name === 'Blockquote') {
        let pos = from;
        while (pos < to) {
          const line = doc.lineAt(pos);
          const lineText = line.text;
          if (lineText.trim() === '') {
            pos = line.to + 1;
            continue;
          }
          const qMatch = lineText.match(/^(\s*)(> ?)/);
          const looksLikeBlockquote = /^\s*> \s*/.test(lineText) || (lineText.trimStart().startsWith('> ') && lineText.trim().length > 0);
          if (qMatch && qMatch[2] && lineText.trim().length > 0 && looksLikeBlockquote) {
            // Decorate only after space: require "> " (not lone ">" at EOL)
            const isBlockquote = qMatch[2] === '> ';
            if (!isBlockquote) {
              pos = line.to + 1;
              continue;
            }
            if (DEBUG_BLOCKQUOTE) console.log('[live-preview] blockquote (tree) line', line.number, ':', JSON.stringify(lineText));
            decorations.push(blockquoteLineDeco.range(line.from));
            const leadingLen = qMatch[1].length;
            if (leadingLen > 0) {
              const leadingPart = qMatch[1];
              const tabCount = (leadingPart.match(/\t/g) ?? []).length;
              const spaceCount = (leadingPart.match(/ /g) ?? []).length;
              const indentLevel = Math.min(Math.max(tabCount, Math.floor(spaceCount / 4)), 3);
              decorations.push(indentLineDecos[indentLevel].range(line.from));
              decorations.push(layoutPreservingHiddenRange(state, line.from, line.from + leadingLen));
            }
            const markerStart = line.from + leadingLen;
            const markerEnd = markerStart + qMatch[2].length;
            decorations.push(collapsedHiddenRange(markerStart, markerEnd));
          }
          pos = line.to + 1;
        }
        return;
      }

      // > prefix: always fade (never replace/hide — replace changes line geometry and breaks cursor on wrapped lines)
      if (name === 'QuoteMark') {
        decorations.push(syntaxFade.range(from, to));
        return;
      }

      // Inline: bold (** or __), italic (* or _), inline code (`), strikethrough (~~)
      // Delimiters: fade when cursor inside range, else hidden. Content gets a mark.
      if (name === 'StrongEmphasis') {
        const markerLen = 2;
        const contentFrom = from + markerLen;
        const contentTo = to - markerLen;
        if (contentTo > contentFrom) {
          if (cursorIn(from, to)) {
            decorations.push(syntaxFade.range(from, contentFrom));
            decorations.push(syntaxFade.range(contentTo, to));
          } else {
            decorations.push(collapsedHiddenRange(from, contentFrom));
            decorations.push(collapsedHiddenRange(contentTo, to));
          }
          decorations.push(Decoration.mark({ class: 'cm-live-preview-bold' }).range(contentFrom, contentTo));
        }
        return;
      }
      if (name === 'Emphasis') {
        const markerLen = 1;
        const contentFrom = from + markerLen;
        const contentTo = to - markerLen;
        if (contentTo > contentFrom) {
          if (cursorIn(from, to)) {
            decorations.push(syntaxFade.range(from, contentFrom));
            decorations.push(syntaxFade.range(contentTo, to));
          } else {
            decorations.push(collapsedHiddenRange(from, contentFrom));
            decorations.push(collapsedHiddenRange(contentTo, to));
          }
          decorations.push(Decoration.mark({ class: 'cm-live-preview-italic' }).range(contentFrom, contentTo));
        }
        return;
      }
      if (name === 'InlineCode') {
        const markerLen = 1;
        const contentFrom = from + markerLen;
        const contentTo = to - markerLen;
        if (contentTo > contentFrom) {
          if (cursorIn(from, to)) {
            decorations.push(syntaxFade.range(from, contentFrom));
            decorations.push(syntaxFade.range(contentTo, to));
          } else {
            decorations.push(collapsedHiddenRange(from, contentFrom));
            decorations.push(collapsedHiddenRange(contentTo, to));
          }
          decorations.push(Decoration.mark({ class: 'cm-live-preview-code' }).range(contentFrom, contentTo));
        }
        return;
      }
      if (name === 'Strikethrough') {
        const markerLen = 2;
        const contentFrom = from + markerLen;
        const contentTo = to - markerLen;
        if (contentTo > contentFrom) {
          if (cursorIn(from, to)) {
            decorations.push(syntaxFade.range(from, contentFrom));
            decorations.push(syntaxFade.range(contentTo, to));
          } else {
            decorations.push(collapsedHiddenRange(from, contentFrom));
            decorations.push(collapsedHiddenRange(contentTo, to));
          }
          decorations.push(Decoration.mark({ class: 'cm-live-preview-strikethrough' }).range(contentFrom, contentTo));
        }
        return;
      }

      // Link: [text](url) — undecorate when cursor adjacent or inside; else hide delimiters, widget
      if (name === 'Link') {
        const slice = doc.sliceString(from, to);
        const closeBracket = slice.indexOf('](');
        if (closeBracket >= 0) {
          const linkTextFrom = from + 1;
          const linkTextTo = from + closeBracket;
          const urlFrom = from + closeBracket + 2;
          const urlTo = to - 1;
          const url = doc.sliceString(urlFrom, urlTo);
          const linkMark = Decoration.mark({
            class: 'cm-live-preview-extlink',
            attributes: { 'data-href': url },
          }).range(linkTextFrom, linkTextTo);
          if (cursorInOrAdjacent(from, to)) {
            decorations.push(syntaxFade.range(from, linkTextFrom));
            decorations.push(linkMark);
            decorations.push(syntaxFade.range(linkTextTo, to));
          } else {
            decorations.push(collapsedHiddenRange(from, linkTextFrom));
            decorations.push(linkMark);
            decorations.push(collapsedHiddenRange(linkTextTo, to));
            decorations.push(Decoration.widget({
              widget: new LinkArrowWidget(url),
              side: 1,
            }).range(linkTextTo));
          }
        }
        return;
      }

      // Autolink: <url> — hide brackets, mark URL
      if (name === 'Autolink') {
        const urlFrom = from + 1;
        const urlTo = to - 1;
        if (urlTo > urlFrom) {
          const url = doc.sliceString(urlFrom, urlTo);
          if (cursorIn(from, to)) {
            decorations.push(syntaxFade.range(from, urlFrom));
            decorations.push(syntaxFade.range(urlTo, to));
          } else {
            decorations.push(collapsedHiddenRange(from, urlFrom));
            decorations.push(collapsedHiddenRange(urlTo, to));
          }
          decorations.push(Decoration.mark({
            class: 'cm-live-preview-extlink',
            attributes: { 'data-href': url },
          }).range(urlFrom, urlTo));
        }
        return;
      }

      // List: collect ListMark and TaskMarker per line for post-pass
      if (name === 'ListMark') {
        const line = doc.lineAt(from);
        let info = listLinesByLineFrom.get(line.from);
        if (!info) {
          info = { listMark: { from, to } };
          listLinesByLineFrom.set(line.from, info);
        } else {
          info.listMark = { from, to };
        }
        return;
      }

      if (name === 'TaskMarker') {
        const line = doc.lineAt(from);
        const info = listLinesByLineFrom.get(line.from);
        if (info) info.taskMarker = { from, to };
      }
    },
  });

  // Resolve list/task/ordered lines: kind, task state, marker range. Fade marker only (no replace) for cursor/wrap safety.
  for (const [lineFrom, info] of listLinesByLineFrom) {
    const { listMark, taskMarker } = info;
    const listMarkText = doc.sliceString(listMark.from, listMark.to);
    const isOrdered = /^\d+[.)]\s?/.test(listMarkText);
    const isGfmTask = !!taskMarker;
    const isBulletOnly = !taskMarker && (listMarkText === '* ' || listMarkText === '*\t');
    if (!isGfmTask && !isBulletOnly && !isOrdered) continue;

    let kind: ListLineKind = 'bullet';
    let taskState: TaskState | undefined;
    let markerTo = listMark.to;
    let taskBoxFrom: number | undefined;
    let taskBoxTo: number | undefined;
    if (isGfmTask && taskMarker) {
      kind = 'task';
      markerTo = taskMarker.to;
      if (doc.sliceString(taskMarker.to, taskMarker.to + 1) === ' ') markerTo = taskMarker.to + 1;
      const box = doc.sliceString(taskMarker.from, taskMarker.to);
      if (box === '[x]') taskState = 'done';
      else if (box === '[-]') taskState = 'cancelled';
      else if (box === '[>]') taskState = 'scheduled';
      else taskState = 'open';
      taskBoxFrom = taskMarker.from;
      taskBoxTo = taskMarker.to;
    } else if (isOrdered) {
      kind = 'ordered';
    }

    let orderedMarkerText: string | undefined;
    let orderedDelimiter: '.' | ')' | undefined;
    if (kind === 'ordered') {
      const raw = doc.sliceString(listMark.from, listMark.to).trim();
      orderedMarkerText = raw;
      orderedDelimiter = raw.endsWith(')') ? ')' : '.';
    }
    listLineMap.set(lineFrom, { kind, taskState, markerFrom: listMark.from, markerTo, taskBoxFrom, taskBoxTo, orderedMarkerText, orderedDelimiter });
  }
}

// --- Build decorations for a given state ---
//
// Uses syntax tree when complete (tree.length >= doc.length) for: ATX headings, blockquotes,
// bold/italic/strikethrough/inline code, [text](url) links, and <url> autolinks. Falls back to
// regex for those when tree is incomplete. Wiki-links, @mentions, #hashtags remain regex-only.

const TASK_BULLET_REGEX = /^(\s*)([-+] \[([x\->  ])\] |(\*) |([-+]) )/;
/** Ordered list: leading whitespace + "1. " or "2) " etc. Groups: (1) leading, (2) digits, (3) delimiter. Trailing \\s* so "4)Four" still parses (marker end = match length; renumber inserts a space). */
export const ORDERED_LIST_REGEX = /^(\s*)(\d+)([.)])\s*/;

/**
 * When the caret snaps to the first digit of an ordered marker (atomic replace + raw marker edit mode),
 * typing body text inserts before the digit → "Four3) ". Redirect pure inserts at markerFrom to markerTo
 * unless the insert is a single ASCII digit (editing the list number), or exactly one indent unit
 * (Tab on list lines inserts at line.from, which equals markerFrom when there is no leading whitespace).
 */
export const orderedListBodyInsertFilter = EditorState.transactionFilter.of((tr: Transaction) => {
  if (tr.changes.empty) return tr;
  const s = tr.startState;
  const indent = s.facet(indentUnit);
  const specs: { from: number; to: number; insert: string }[] = [];
  let redirected: { markerFrom: number; markerTo: number } | null = null;
  let abortMultiRedirect = false;

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const ins = inserted.toString();
    if (fromA !== toA) {
      specs.push({ from: fromA, to: toA, insert: ins });
      return;
    }
    if (ins.length === 0) return;

    const line = s.doc.lineAt(fromA);
    const m = line.text.match(ORDERED_LIST_REGEX);
    if (!m) {
      specs.push({ from: fromA, to: toA, insert: ins });
      return;
    }
    const leadLen = m[1].length;
    const markerFrom = line.from + leadLen;
    const markerTo = line.from + m[0].length;
    if (fromA !== markerFrom) {
      specs.push({ from: fromA, to: toA, insert: ins });
      return;
    }
    // Match indentMore (`input.indent`) and exact indent unit; Tab from tabOnHeadingOrListLine must tag input.indent.
    if (ins === indent || tr.isUserEvent('input.indent')) {
      specs.push({ from: fromA, to: toA, insert: ins });
      return;
    }
    const singleDigit = ins.length === 1 && ins >= '0' && ins <= '9';
    if (singleDigit) {
      specs.push({ from: fromA, to: toA, insert: ins });
      return;
    }
    if (redirected) {
      abortMultiRedirect = true;
      return;
    }
    redirected = { markerFrom, markerTo };
    specs.push({ from: markerTo, to: markerTo, insert: ins });
  });

  if (abortMultiRedirect || !redirected) return tr;
  // Assignment happens inside iterChanges; TS does not narrow `redirected` across that callback.
  const r = redirected as { markerFrom: number; markerTo: number };

  const delta = r.markerTo - r.markerFrom;
  const newSel = tr.newSelection;
  const adjusted =
    newSel.ranges.length === 1 && newSel.main.empty
      ? EditorSelection.cursor(newSel.main.head + delta, newSel.main.assoc ?? 0)
      : newSel;

  return {
    changes: specs,
    selection: adjusted,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
  };
});

function resolveListLineFromRegex(line: { from: number; text: string }, taskMatch: RegExpMatchArray): ResolvedListLine {
  const leadLen = taskMatch[1].length;
  const markerLen = taskMatch[2].length;
  const markerFrom = line.from + leadLen;
  const markerTo = line.from + leadLen + markerLen;
  if (taskMatch[4]) return { kind: 'bullet', markerFrom, markerTo };
  if (taskMatch[3] !== undefined) {
    const ch = taskMatch[3];
    let taskState: TaskState = 'open';
    if (ch === 'x') taskState = 'done';
    else if (ch === '-') taskState = 'cancelled';
    else if (ch === '>') taskState = 'scheduled';
    const taskBoxFrom = markerFrom + 2; // after "- " or "* "
    const taskBoxLen = ch === '-' || ch === '>' ? 4 : 3; // "[-]" "[>]" vs "[ ]" "[x]"
    return { kind: 'task', taskState, markerFrom, markerTo, taskBoxFrom, taskBoxTo: taskBoxFrom + taskBoxLen };
  }
  if (taskMatch[5]) {
    // Shortcut task "- " or "+ ": no literal [ ] in doc; use insertion point so click inserts "[x] ".
    const taskBoxFrom = markerTo;
    const taskBoxTo = markerTo;
    return { kind: 'task', taskState: 'open', markerFrom, markerTo, taskBoxFrom, taskBoxTo };
  }
  return { kind: 'bullet', markerFrom, markerTo };
}

function resolveOrderedListFromRegex(line: { from: number; text: string }, orderedMatch: RegExpMatchArray): ResolvedListLine {
  const leadLen = orderedMatch[1].length;
  const markerFrom = line.from + leadLen;
  const markerTo = line.from + orderedMatch[0].length;
  const orderedMarkerText = orderedMatch[2] + (orderedMatch[3] ?? '.'); // e.g. "1." or "2)"
  const delim = (orderedMatch[3] === ')' ? ')' : '.') as '.' | ')';
  return { kind: 'ordered', markerFrom, markerTo, orderedMarkerText, orderedDelimiter: delim };
}

/**
 * Syntax tree ListMark can end before the space after the delimiter, so the replace range would miss that space and
 * the gap between number and body looks tight until the next rebuild. Regex always matches the full `1. ` span.
 */
function normalizeOrderedResolvedFromLineText(line: { from: number; text: string }, resolved: ResolvedListLine): ResolvedListLine {
  if (resolved.kind !== 'ordered') return resolved;
  const m = line.text.match(ORDERED_LIST_REGEX);
  if (!m) return resolved;
  return resolveOrderedListFromRegex(line, m);
}

/** Doc position after the ordered marker (`1. `), i.e. first index for body text. Used after Tab + renumber so typing does not insert before the number. */
export function getOrderedMarkerEnd(state: EditorState, lineNumber: number): number | null {
  const line = state.doc.line(lineNumber);
  const m = line.text.match(ORDERED_LIST_REGEX);
  if (!m) return null;
  return line.from + m[0].length;
}

/** True when the line is ordered and has nothing after the marker (only whitespace). */
export function orderedListLineHasNoBody(lineText: string): boolean {
  const m = lineText.match(ORDERED_LIST_REGEX);
  if (!m) return false;
  const rest = lineText.slice(m[0].length);
  return rest.trim() === '';
}

/** True if the line looks like a list (ordered, task, or bullet). Used by main for Tab-at-line-start. */
export function isListLine(state: EditorState, lineNumber: number): boolean {
  const line = state.doc.line(lineNumber);
  return TASK_BULLET_REGEX.test(line.text) || ORDERED_LIST_REGEX.test(line.text);
}

/**
 * Resolve list / task / ordered marker for one line (regex path; matches live preview when tree is stale).
 * Used for task context menu and other line-scoped actions.
 */
export function resolveEditorListLine(state: EditorState, lineNumber: number): ResolvedListLine | null {
  const line = state.doc.line(lineNumber);
  const taskMatch = line.text.match(TASK_BULLET_REGEX);
  const orderedMatch = line.text.match(ORDERED_LIST_REGEX);
  let resolved: ResolvedListLine | null = taskMatch
    ? resolveListLineFromRegex(line, taskMatch)
    : orderedMatch
      ? resolveOrderedListFromRegex(line, orderedMatch)
      : null;
  if (resolved?.kind === 'ordered') {
    resolved = normalizeOrderedResolvedFromLineText(line, resolved);
  }
  return resolved;
}

// --- Ordered list run and renumbering (consecutive lines only) ---

export interface OrderedLineInRun {
  lineFrom: number;
  lineNumber: number;
  indentLevel: number;
  markerFrom: number;
  markerTo: number;
  num: number;
  delim: '.' | ')';
}

/** Indent level 0..3 from leading tabs/spaces (tabs count 1, 4 spaces = 1). */
function getIndentLevel(lineText: string): number {
  const lead = lineText.match(/^(\s*)/)?.[1] ?? '';
  const tabCount = (lead.match(/\t/g) ?? []).length;
  const spaceCount = (lead.match(/ /g) ?? []).length;
  return Math.min(Math.max(tabCount, Math.floor(spaceCount / 4)), 3);
}

/** Consecutive ordered-list lines containing the given line. Blank or non-ordered lines break the run. */
export function getOrderedRun(state: EditorState, lineNumber: number): OrderedLineInRun[] {
  const doc = state.doc;
  const run: OrderedLineInRun[] = [];
  let i = lineNumber;
  while (i >= 1) {
    const line = doc.line(i);
    const m = line.text.match(ORDERED_LIST_REGEX);
    if (!m) break;
    const leadLen = m[1].length;
    run.unshift({
      lineFrom: line.from,
      lineNumber: i,
      indentLevel: getIndentLevel(line.text),
      markerFrom: line.from + leadLen,
      markerTo: line.from + m[0].length,
      num: parseInt(m[2], 10),
      delim: m[3] === ')' ? ')' : '.',
    });
    i--;
  }
  i = lineNumber + 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    const m = line.text.match(ORDERED_LIST_REGEX);
    if (!m) break;
    const leadLen = m[1].length;
    run.push({
      lineFrom: line.from,
      lineNumber: i,
      indentLevel: getIndentLevel(line.text),
      markerFrom: line.from + leadLen,
      markerTo: line.from + m[0].length,
      num: parseInt(m[2], 10),
      delim: m[3] === ')' ? ')' : '.',
    });
    i++;
  }
  return run;
}

/** If pos is inside the number zone (digits only, to the left of the delimiter) of an ordered line, return that line's marker info. Used for: show raw when editing. */
export function getOrderedNumberZoneAt(state: EditorState, pos: number): { lineFrom: number; markerFrom: number; markerTo: number; num: number; delim: '.' | ')' } | null {
  const line = state.doc.lineAt(pos);
  const m = line.text.match(ORDERED_LIST_REGEX);
  if (!m) return null;
  const leadLen = m[1].length;
  const markerFrom = line.from + leadLen;
  const markerTo = line.from + m[0].length;
  const numberZoneEnd = markerFrom + m[2].length; // digits only (exclusive)
  if (pos < markerFrom || pos >= numberZoneEnd) return null;
  return {
    lineFrom: line.from,
    markerFrom,
    markerTo,
    num: parseInt(m[2], 10),
    delim: m[3] === ')' ? ')' : '.',
  };
}

/** If pos is anywhere inside the full marker (digits + delimiter + optional spaces) of an ordered line, return that line's marker info. Used for: trigger renumber only when cursor leaves the whole marker. */
function getOrderedMarkerRangeAt(state: EditorState, pos: number): { lineFrom: number; markerFrom: number; markerTo: number } | null {
  const line = state.doc.lineAt(pos);
  const m = line.text.match(ORDERED_LIST_REGEX);
  if (!m) return null;
  const leadLen = m[1].length;
  const markerFrom = line.from + leadLen;
  const markerTo = line.from + m[0].length;
  if (pos < markerFrom || pos >= markerTo) return null;
  return { lineFrom: line.from, markerFrom, markerTo };
}

/**
 * True if any line strictly between lineLo and lineHi has indent strictly less than `level`.
 * Nested ordered lists restart at 1 after a shallower line (e.g. top-level `3)`) appears between
 * two deeper items.
 */
function indentBreaksBetween(state: EditorState, lineLo: number, lineHi: number, level: number): boolean {
  if (level <= 0) return false;
  const doc = state.doc;
  const lo = Math.min(lineLo, lineHi);
  const hi = Math.max(lineLo, lineHi);
  for (let ln = lo + 1; ln < hi; ln++) {
    if (ln < 1 || ln > doc.lines) continue;
    const line = doc.line(ln);
    if (getIndentLevel(line.text) < level) return true;
  }
  return false;
}

/** 1-based index of this line among lines at the same indent level in the same segment (shallower line breaks segments). */
function expectedNumberAtLevel(state: EditorState, run: OrderedLineInRun[], lineFrom: number, level: number): number {
  let n = 0;
  let prevLineNum: number | null = null;
  for (const row of run) {
    if (row.indentLevel !== level) continue;
    if (prevLineNum !== null && indentBreaksBetween(state, prevLineNum, row.lineNumber, level)) {
      n = 0;
    }
    n++;
    if (row.lineFrom === lineFrom) return n;
    prevLineNum = row.lineNumber;
  }
  return 0;
}

/** Renumber run: assign 1,2,3 per indent level (for indent/outdent), restarting per segment when a shallower line breaks nesting. */
function renumberRunSequential(state: EditorState, run: OrderedLineInRun[]): { from: number; to: number; insert: string }[] {
  const changes: { from: number; to: number; insert: string }[] = [];
  const counters: Record<number, number> = {};
  const lastLineAtLevel: Record<number, number> = {};
  const sorted = [...run].sort((a, b) => a.lineNumber - b.lineNumber);
  for (const row of sorted) {
    const level = row.indentLevel;
    const prevLn = lastLineAtLevel[level];
    if (prevLn !== undefined && indentBreaksBetween(state, prevLn, row.lineNumber, level)) {
      counters[level] = 0;
    }
    counters[level] = (counters[level] ?? 0) + 1;
    lastLineAtLevel[level] = row.lineNumber;
    const newNum = counters[level];
    const newMarker = String(newNum) + row.delim + ' ';
    changes.push({ from: row.markerFrom, to: row.markerTo, insert: newMarker });
  }
  return changes;
}

/** Renumber from edited line onward at same level: set to startNum, startNum+1, ... (for edit-then-leave). Stops at segment boundary. */
function renumberRunFromEdit(state: EditorState, run: OrderedLineInRun[], editedLineFrom: number, startNum: number): { from: number; to: number; insert: string }[] {
  const editedRow = run.find((r) => r.lineFrom === editedLineFrom);
  if (!editedRow) return [];
  const editedLevel = editedRow.indentLevel;
  const editedLineNum = editedRow.lineNumber;
  const sorted = [...run].sort((a, b) => a.lineNumber - b.lineNumber);
  const changes: { from: number; to: number; insert: string }[] = [];
  let n = startNum;
  let prevLineNum = editedLineNum;

  for (const row of sorted) {
    if (row.indentLevel !== editedLevel) continue;
    if (row.lineNumber < editedLineNum) continue;
    if (row.lineNumber > editedLineNum) {
      if (indentBreaksBetween(state, prevLineNum, row.lineNumber, editedLevel)) break;
    }
    changes.push({ from: row.markerFrom, to: row.markerTo, insert: String(n) + row.delim + ' ' });
    n++;
    prevLineNum = row.lineNumber;
  }
  return changes;
}

/** Renumber changes for the ordered run containing this line, in coordinates of `state` (e.g. after outdent). Used to merge outdent + renumber in one transaction. */
export function getRenumberOrderedListChanges(
  state: EditorState,
  lineNumber: number,
): { from: number; to: number; insert: string }[] {
  const run = getOrderedRun(state, lineNumber);
  if (run.length === 0) return [];
  return renumberRunSequential(state, run);
}

/** Call after indent or outdent: renumber the ordered run containing this line (1,2,3 per level). */
export function renumberOrderedListAfterIndent(view: EditorView, lineNumber: number): boolean {
  const changes = getRenumberOrderedListChanges(view.state, lineNumber);
  if (changes.length === 0) return false;
  view.dispatch({
    changes: changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
  });
  return true;
}

/** Call when cursor leaves the number zone of an ordered line; renumbers subsequent lines at that level if the number was changed. */
export function renumberOrderedListAfterLeaveNumberZone(
  view: EditorView,
  lineFrom: number,
  _markerFrom: number,
  _markerTo: number,
  currentNum: number,
  _delim: '.' | ')',
): boolean {
  const run = getOrderedRun(view.state, view.state.doc.lineAt(lineFrom).number);
  if (run.length === 0) return false;
  const expected = expectedNumberAtLevel(
    view.state,
    run,
    lineFrom,
    run.find((r) => r.lineFrom === lineFrom)!.indentLevel,
  );
  if (currentNum === expected) return false;
  const changes = renumberRunFromEdit(view.state, run, lineFrom, currentNum);
  if (changes.length === 0) return false;
  view.dispatch({
    changes: changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
  });
  return true;
}

/** Next number and delimiter for a new line at the same indent in the run (for Enter). */
export function getNextOrderedMarkerInRun(state: EditorState, lineNumber: number): { num: number; delim: '.' | ')' } | null {
  const run = getOrderedRun(state, lineNumber);
  if (run.length === 0) return null;
  const line = state.doc.line(lineNumber);
  const level = getIndentLevel(line.text);
  const expected = expectedNumberAtLevel(state, run, line.from, level);
  if (expected === 0) return null;
  const row = run.find((r) => r.lineNumber === lineNumber);
  return row ? { num: expected + 1, delim: row.delim } : null;
}

/** When true, skip tree and use only regex/line iteration (avoids stale tree positions right after doc change). */
function buildDecorations(
  state: EditorState,
  cursorPos: number,
  forceRegexAfterDocChange?: boolean,
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const doc = state.doc;
  const cursorLine = doc.lineAt(cursorPos).number;

  const cursorIn = (from: number, to: number) =>
    cursorPos >= from && cursorPos <= to;
  /** True when cursor is inside the range or immediately before/after it (undecorate links). */
  const cursorInOrAdjacent = (from: number, to: number) =>
    (cursorPos >= from && cursorPos <= to) ||
    (from > 0 && cursorPos === from - 1) ||
    cursorPos === to + 1;

  const tree = syntaxTree(state);
  const useTreeForBlocks =
    !forceRegexAfterDocChange && tree.length >= doc.length;
  const listLineMap = new Map<number, ResolvedListLine>();
  if (useTreeForBlocks) {
    buildDecorationsFromTree(state, cursorPos, decorations, listLineMap);
  }

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;
    const onCursorLine = (i === cursorLine);

    const headingMatch = text.match(/^(\s*)(#{1,6})\s/);
    const quoteMatch = text.match(/^(\s*)(> ?)/);

    // Setext headings (Title\n=== / ---): we don't support them; override so both lines look like body text. Tree path does this too; regex path needs it when tree is skipped (e.g. after indent).
    const isSetextUnderline = /^=+\s*$|^-\s*$/.test(text.trim());
    const nextLineText = i < doc.lines ? doc.line(i + 1).text : '';
    const isSetextTitle = i < doc.lines && /^=+\s*$|^-\s*$/.test(nextLineText.trim());
    if (isSetextUnderline || isSetextTitle) {
      decorations.push(setextUnsupportedLineDeco.range(line.from));
    }

    // Headings: always apply when line matches (fallback when tree misses the line after Tab/Untab etc.). Support leading indent. On cursor line show ## faded; off line hide ## and following space.
    if (headingMatch) {
      const leadingLen = headingMatch[1].length;
      const hashLen = headingMatch[2].length;
      const level = hashLen;
      decorations.push(headingLineDecos[level].range(line.from));
      if (leadingLen > 0) {
        const leadingPart = headingMatch[1];
        const tabCount = (leadingPart.match(/\t/g) ?? []).length;
        const spaceCount = (leadingPart.match(/ /g) ?? []).length;
        const indentLevel = Math.min(Math.max(tabCount, Math.floor(spaceCount / 4)), 3);
        decorations.push(indentLineDecos[indentLevel].range(line.from));
        decorations.push(layoutPreservingHiddenRange(state, line.from, line.from + leadingLen));
      }
      const hashFrom = line.from + leadingLen;
      const hashFadeTo = Math.min(hashFrom + hashLen, line.to);
      const hashHideTo = Math.min(hashFrom + hashLen + 1, line.to); // hashes + space
      if (onCursorLine) {
        decorations.push(syntaxFade.range(hashFrom, hashFadeTo));
      } else {
        decorations.push(collapsedHiddenRange(hashFrom, hashHideTo));
      }
    }

    // Blockquotes: only when not from tree. Decorate only after space: "> " (not ">text" or lone ">"). Never apply to blank lines.
    const looksLikeBlockquoteLine = /^\s*> \s*/.test(text) || (text.trimStart().startsWith('> ') && text.trim().length > 0);
    if (!useTreeForBlocks && line.text.trim().length > 0 && looksLikeBlockquoteLine && quoteMatch && quoteMatch[2]) {
      const quoteLeading = quoteMatch[1];
      const quoteMarker = quoteMatch[2];
      // Decorate only after space: require "> " (not lone ">" at EOL)
      const isBlockquote = quoteMarker === '> ';
      if (!isBlockquote) {
        // ">foo" etc. — skip so we don't apply blockquote prematurely
      } else {
      const leadingLen = quoteLeading.length;
      if (DEBUG_BLOCKQUOTE) console.log('[live-preview] blockquote (regex) line', i, ':', JSON.stringify(text));
      decorations.push(blockquoteLineDeco.range(line.from));
      if (leadingLen > 0) {
        const leadingPart = quoteLeading;
        const tabCount = (leadingPart.match(/\t/g) ?? []).length;
        const spaceCount = (leadingPart.match(/ /g) ?? []).length;
        const indentLevel = Math.min(Math.max(tabCount, Math.floor(spaceCount / 4)), 3);
        decorations.push(indentLineDecos[indentLevel].range(line.from));
        decorations.push(layoutPreservingHiddenRange(state, line.from, line.from + leadingLen));
      }
      const markerStart = line.from + leadingLen;
      const markerEnd = markerStart + quoteMarker.length;
      decorations.push(collapsedHiddenRange(markerStart, markerEnd));
      }
    }

    const taskMatch = text.match(TASK_BULLET_REGEX);
    const orderedMatch = text.match(ORDERED_LIST_REGEX);

    // Tab-indented plain paragraphs: indent + hidden so block indent and wrap align (same as list/blockquote).
    if (!headingMatch && !quoteMatch && !taskMatch && !orderedMatch && !listLineMap.has(line.from)) {
      const paraLeading = text.match(/^(\s+)/);
      if (paraLeading && line.text.trim().length > 0) {
        const leadingLen = paraLeading[1].length;
        const leadingPart = paraLeading[1];
        const tabCount = (leadingPart.match(/\t/g) ?? []).length;
        const spaceCount = (leadingPart.match(/ /g) ?? []).length;
        const indentLevel = Math.min(Math.max(tabCount, Math.floor(spaceCount / 4)), 3);
        if (indentLevel >= 1) {
          decorations.push(indentLineDecos[indentLevel].range(line.from));
          decorations.push(layoutPreservingHiddenRange(state, line.from, line.from + leadingLen));
        }
      }
    }

    // List/task/ordered line: line deco + replace marker range with inline widget (CM6-native; range is atomic).
    let resolved = listLineMap.get(line.from)
      ?? (taskMatch ? resolveListLineFromRegex(line, taskMatch) : orderedMatch ? resolveOrderedListFromRegex(line, orderedMatch) : null);
    if (resolved?.kind === 'ordered') {
      resolved = normalizeOrderedResolvedFromLineText(line, resolved);
    }
    if (resolved) {
      decorations.push(listLineDeco.range(line.from));
      if (resolved.kind === 'task' && resolved.taskState === 'done') decorations.push(doneTaskLineDeco.range(line.from));
      if (resolved.kind === 'task' && resolved.taskState === 'cancelled') {
        decorations.push(cancelledTaskLineDeco.range(line.from));
        if (resolved.markerTo < line.to) decorations.push(cancelledTextMark.range(resolved.markerTo, line.to));
      }
      if (resolved.kind === 'task' && resolved.taskState === 'scheduled') decorations.push(scheduledTaskLineDeco.range(line.from));

      // Indented list: detect leading whitespace from line text (tree may put tab inside ListMark so markerFrom can be line.from).
      const leadingMatch = text.match(/^(\s+)/);
      const leadingLen = leadingMatch ? leadingMatch[1].length : 0;
      const leadingPart = leadingLen ? text.slice(0, leadingLen) : '';
      const tabCount = (leadingPart.match(/\t/g) ?? []).length;
      const spaceCount = (leadingPart.match(/ /g) ?? []).length;
      const indentLevel = Math.min(Math.max(tabCount, Math.floor(spaceCount / 4)), 3);

      if (indentLevel >= 1 && leadingLen > 0) {
        decorations.push(indentLineDecos[indentLevel].range(line.from));
        decorations.push(layoutPreservingHiddenRange(state, line.from, line.from + leadingLen));
      }

      // Marker replace: only the marker (after leading whitespace), so we don't overlap with hidden.
      // Ordered: always use regex-normalized markerFrom (same as tree normalize) so top-level and indented align.
      // When cursor is anywhere in the marker (digits + delimiter + space), show raw edit; else widget.
      // Digit-only would make top-level (easy to click digits) feel unlike indented (caret often on delim/space).
      const markerFrom =
        resolved.kind === 'ordered'
          ? resolved.markerFrom
          : leadingLen > 0
            ? line.from + leadingLen
            : resolved.markerFrom;
      const markerTo = resolved.markerTo;
      if (markerFrom < markerTo && markerFrom >= line.from && markerTo <= line.to && markerTo <= doc.length) {
        if (resolved.kind === 'ordered') {
          const cursorInsideOrderedMarker =
            cursorPos >= markerFrom && cursorPos < markerTo;
          if (cursorInsideOrderedMarker) {
            decorations.push(orderedNumberEditMark.range(markerFrom, markerTo));
          } else {
            decorations.push(
              Decoration.replace({
                widget: new MarkerWidget(
                  'ordered',
                  undefined,
                  undefined,
                  undefined,
                  resolved.orderedMarkerText,
                ),
                inclusive: false,
              }).range(markerFrom, markerTo),
            );
          }
        } else {
          decorations.push(
            Decoration.replace({
              widget: new MarkerWidget(
              resolved.kind,
              resolved.taskState,
              resolved.taskBoxFrom,
              resolved.taskBoxTo,
              resolved.orderedMarkerText,
            ),
              inclusive: false,
            }).range(markerFrom, markerTo),
          );
        }
      }
    }

    // Inline patterns — tree handles bold/italic/code/strikethrough when useTreeForBlocks; regex fallback below

    if (!useTreeForBlocks) {
      // Bold: **text** or __text__
      for (const match of text.matchAll(/(\*\*|__)(.+?)\1/g)) {
        const start = line.from + match.index!;
        const end = start + match[0].length;
        const markerLen = match[1].length;
        if (onCursorLine && cursorIn(start, end)) {
          decorations.push(syntaxFade.range(start, start + markerLen));
          decorations.push(Decoration.mark({ class: 'cm-live-preview-bold' }).range(
            start + markerLen, start + markerLen + match[2].length
          ));
          decorations.push(syntaxFade.range(end - markerLen, end));
        } else {
          decorations.push(collapsedHiddenRange(start, start + markerLen));
          decorations.push(Decoration.mark({ class: 'cm-live-preview-bold' }).range(
            start + markerLen, start + markerLen + match[2].length
          ));
          decorations.push(collapsedHiddenRange(end - markerLen, end));
        }
      }

      // Italic: *text* or _text_ (but not ** or __)
      for (const match of text.matchAll(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g)) {
        const start = line.from + match.index!;
        const end = start + match[0].length;
        const content = match[1] || match[2];
        if (onCursorLine && cursorIn(start, end)) {
          decorations.push(syntaxFade.range(start, start + 1));
          decorations.push(Decoration.mark({ class: 'cm-live-preview-italic' }).range(
            start + 1, start + 1 + content.length
          ));
          decorations.push(syntaxFade.range(end - 1, end));
        } else {
          decorations.push(collapsedHiddenRange(start, start + 1));
          decorations.push(Decoration.mark({ class: 'cm-live-preview-italic' }).range(
            start + 1, start + 1 + content.length
          ));
          decorations.push(collapsedHiddenRange(end - 1, end));
        }
      }

      // Strikethrough: ~~text~~
      for (const match of text.matchAll(/~~(.+?)~~/g)) {
        const start = line.from + match.index!;
        const end = start + match[0].length;
        if (onCursorLine && cursorIn(start, end)) {
          decorations.push(syntaxFade.range(start, start + 2));
          decorations.push(Decoration.mark({ class: 'cm-live-preview-strikethrough' }).range(
            start + 2, start + 2 + match[1].length
          ));
          decorations.push(syntaxFade.range(end - 2, end));
        } else {
          decorations.push(collapsedHiddenRange(start, start + 2));
          decorations.push(Decoration.mark({ class: 'cm-live-preview-strikethrough' }).range(
            start + 2, start + 2 + match[1].length
          ));
          decorations.push(collapsedHiddenRange(end - 2, end));
        }
      }

      // Inline code: `text`
      for (const match of text.matchAll(/(?<!`)(`)((?!`).+?)(`)/g)) {
        const start = line.from + match.index!;
        const end = start + match[0].length;
        if (onCursorLine && cursorIn(start, end)) {
          decorations.push(syntaxFade.range(start, start + 1));
          decorations.push(Decoration.mark({ class: 'cm-live-preview-code' }).range(
            start + 1, start + 1 + match[2].length
          ));
          decorations.push(syntaxFade.range(end - 1, end));
        } else {
          decorations.push(collapsedHiddenRange(start, start + 1));
          decorations.push(Decoration.mark({ class: 'cm-live-preview-code' }).range(
            start + 1, start + 1 + match[2].length
          ));
          decorations.push(collapsedHiddenRange(end - 1, end));
        }
      }
    }

    // Wiki-links: [[text]] — always regex (not in standard markdown)
    for (const match of text.matchAll(/\[\[(.+?)\]\]/g)) {
      const start = line.from + match.index!;
      const end = start + match[0].length;
      const linkTarget = match[1];
      const linkMark = Decoration.mark({
        class: 'cm-live-preview-wikilink',
        attributes: { 'data-link': linkTarget },
      });
      if (cursorInOrAdjacent(start, end)) {
        decorations.push(syntaxFade.range(start, start + 2));
        decorations.push(linkMark.range(start + 2, start + 2 + linkTarget.length));
        decorations.push(syntaxFade.range(end - 2, end));
      } else {
        decorations.push(collapsedHiddenRange(start, start + 2));
        decorations.push(linkMark.range(start + 2, start + 2 + linkTarget.length));
        decorations.push(collapsedHiddenRange(end - 2, end));
      }
    }

    // External links: [text](url) and bare URLs — tree handles when useTreeForBlocks. Match [text](anyurl) so malformed URLs still get link styling in regex path.
    if (!useTreeForBlocks) {
      for (const match of text.matchAll(/\[([^\]]+)\]\(([^)]*)\)|(https?:\/\/\S+)/g)) {
        if (match.index == null) continue;
        const start = line.from + match.index;
        const end = Math.min(start + match[0].length, line.to);
        if (start < line.from || end > line.to) continue;

        if (match[1] != null && match[2] != null) {
          const linkText = match[1];
          const url = match[2]; // may be malformed (e.g. https::/...)
          const linkEnd = Math.min(start + 1 + linkText.length, end);
          if (start + 1 >= linkEnd || linkEnd > end) continue; // skip if range would be invalid
          if (cursorInOrAdjacent(start, end)) {
            decorations.push(syntaxFade.range(start, start + 1));
            decorations.push(Decoration.mark({
              class: 'cm-live-preview-extlink',
              attributes: { 'data-href': url },
            }).range(start + 1, linkEnd));
            decorations.push(syntaxFade.range(linkEnd, end));
          } else {
            decorations.push(collapsedHiddenRange(start, start + 1));
            decorations.push(Decoration.mark({
              class: 'cm-live-preview-extlink',
              attributes: { 'data-href': url },
            }).range(start + 1, linkEnd));
            decorations.push(collapsedHiddenRange(linkEnd, end));
            /* Widget at end, side -1, so it appears after the link without overlapping the replace that starts at linkEnd */
            decorations.push(Decoration.widget({
              widget: new LinkArrowWidget(url),
              side: -1,
            }).range(end));
          }
        } else if (match[3]) {
          const url = match[3];
          const urlEnd = Math.min(start + url.length, line.to);
          if (urlEnd > start) {
            decorations.push(Decoration.mark({
              class: 'cm-live-preview-extlink',
              attributes: { 'data-href': url },
            }).range(start, urlEnd));
          }
        }
      }

      // Autolink: <url> — tree handles when useTreeForBlocks; regex fallback so angle-bracket links keep formatting after indent
      for (const match of text.matchAll(/<(https?:\/\/[^>\s]+)>/g)) {
        if (match.index == null) continue;
        const start = line.from + match.index;
        const end = Math.min(start + match[0].length, line.to);
        if (start < line.from || end > line.to) continue;
        const url = match[1];
        const urlFrom = start + 1;
        const urlTo = end - 1;
        if (urlTo <= urlFrom) continue;
        if (cursorInOrAdjacent(start, end)) {
          decorations.push(syntaxFade.range(start, urlFrom));
          decorations.push(syntaxFade.range(urlTo, end));
        } else {
          decorations.push(collapsedHiddenRange(start, urlFrom));
          decorations.push(collapsedHiddenRange(urlTo, end));
        }
        decorations.push(Decoration.mark({
          class: 'cm-live-preview-extlink',
          attributes: { 'data-href': url },
        }).range(urlFrom, urlTo));
      }
    }

    // @mentions: @FirstnameLastname — only at word boundary (start of line or after whitespace)
    for (const match of text.matchAll(/(?:^|(?<=\s))(@[A-Za-z_][A-Za-z0-9_/\-&]*)/g)) {
      const start = line.from + match.index!;
      const end = start + match[1].length;
      decorations.push(Decoration.mark({
        class: 'cm-live-preview-mention',
        attributes: { 'data-mention': match[1] },
      }).range(start, end));
    }

    // #hashtags: requires whitespace or line start before #.
    // Requires letter after # (avoids headings like "# Title", hex colors, bare numbers).
    for (const match of text.matchAll(/(?:^|(?<=\s))(#[A-Za-z][A-Za-z0-9_/\-&]*)/g)) {
      const start = line.from + match.index!;
      const end = start + match[1].length;
      decorations.push(Decoration.mark({
        class: 'cm-live-preview-hashtag',
        attributes: { 'data-hashtag': match[1] },
      }).range(start, end));
    }
  }

  // CM6 requires ranges sorted by `from` and `startSide`; let the library sort.
  // Diagnostic: set to true to log doc content and decorations when a line is exactly "- [ ]".
  const DEBUG_TASK_LINE = false;
  if (DEBUG_TASK_LINE) {
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      if (line.text !== '- [ ]') continue;
      const charCodes = [...line.text].map((c) => c.charCodeAt(0)).join(',');
      console.log('[live-preview] line "- [ ]" at', line.from, '-', line.to, 'text:', JSON.stringify(line.text), 'charCodes:', charCodes);
      const overlaps = decorations.filter(
        (r) => r.from < line.to && (r.to ?? r.from) > line.from,
      );
      console.log('[live-preview] overlapping decorations:', overlaps.length);
      overlaps.forEach((r) => {
        const spec = (r.value as { spec?: { widget?: unknown; class?: string } }).spec;
        const isReplace = spec && 'widget' in spec && spec.widget != null;
        console.log('  ', r.from, r.to, isReplace ? 'REPLACE' : 'mark/line', spec?.class ?? '');
      });
    }
  }

  return Decoration.set(decorations, true);
}

// --- Plugin that rebuilds decorations on every relevant change ---

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    cursorPos: number;

    constructor(view: EditorView) {
      this.cursorPos = view.state.selection.main.head;
      try {
        this.decorations = buildDecorations(view.state, this.cursorPos);
      } catch (e) {
        console.error('[live-preview] buildDecorations failed (init):', e);
        this.decorations = Decoration.none;
      }
    }

    update(update: ViewUpdate) {
      const sel = update.state.selection.main;
      const newPos = sel.head;
      const prevHead = this.cursorPos;

      const scheduleRenumberIfLeftNumberZone = () => {
        const leftMarker = getOrderedMarkerRangeAt(update.startState, prevHead);
        if (!leftMarker) return;
        const stillInMarker = getOrderedMarkerRangeAt(update.state, newPos)?.lineFrom === leftMarker.lineFrom;
        if (stillInMarker) return;
        const lineNumber = update.startState.doc.lineAt(leftMarker.lineFrom).number;
        const view = update.view;
        setTimeout(() => {
          const state = view.state;
          const line = state.doc.line(lineNumber);
          const m = line.text.match(ORDERED_LIST_REGEX);
          if (!m) return;
          const leadLen = m[1].length;
          const markerFrom = line.from + leadLen;
          const markerTo = line.from + m[0].length;
          renumberOrderedListAfterLeaveNumberZone(
            view,
            line.from,
            markerFrom,
            markerTo,
            parseInt(m[2], 10),
            m[3] === ')' ? ')' : '.',
          );
        }, 0);
      };

      if (update.docChanged || update.viewportChanged) {
        this.cursorPos = newPos;
        try {
          this.decorations = buildDecorations(
            update.state,
            this.cursorPos,
            !!update.docChanged,
          );
        } catch (e) {
          console.error('[live-preview] buildDecorations failed:', e);
          console.error('[live-preview] doc.length=', update.state.doc.length, 'lines=', update.state.doc.lines);
          this.decorations = Decoration.none;
        }
        scheduleRenumberIfLeftNumberZone();
      } else if (sel.empty && newPos !== prevHead) {
        scheduleRenumberIfLeftNumberZone();
        this.cursorPos = newPos;
        try {
          this.decorations = buildDecorations(update.state, this.cursorPos);
        } catch (e) {
          console.error('[live-preview] buildDecorations failed:', e);
        }
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

/** Mousedown on task icon toggles [ ] <-> [x]. Use mousedown so CM6 does not move cursor before we run. */
export const taskMarkerClickHandler = EditorView.domEventHandlers({
  mousedown(event: MouseEvent, view: EditorView) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey) return false;
    const el = (event.target as HTMLElement).closest?.('.cm-live-preview-marker-widget') as HTMLElement | null;
    if (!el?.dataset.taskBoxFrom || !el.dataset.taskBoxTo) return false;
    const from = Number(el.dataset.taskBoxFrom);
    const to = Number(el.dataset.taskBoxTo);
    if (Number.isNaN(from) || Number.isNaN(to) || from >= to) return false;
    const doc = view.state.doc;
    if (from < 0 || to > doc.length) return false;
    const box = doc.sliceString(from, to);
    const next = box === '[ ]' || box === '[x]' ? (box === '[ ]' ? '[x]' : '[ ]') : null;
    if (!next) return false;
    event.preventDefault();
    event.stopPropagation();
    view.dispatch({ changes: { from, to, insert: next } });
    return true;
  },
});
