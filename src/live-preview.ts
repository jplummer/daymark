/**
 * Live preview extension for CodeMirror 6.
 *
 * Hides markdown syntax characters (e.g. **, ##, [[, ]]) via replace
 * decorations. All syntax is inline-scoped: decorations are only removed
 * for the specific syntax span the cursor is within, so moving around a
 * line doesn't disrupt unrelated formatted elements. Heading font sizes
 * are always applied; only the # prefix is inline-scoped.
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
import { EditorState, Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

// --- Widgets for replacing syntax tokens ---

class HiddenWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.style.display = 'none';
    return span;
  }
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
  ) {
    super();
  }

  /** Let click/mousedown through so our task icon can receive them (default: widget ignores all events). */
  ignoreEvent(event: Event): boolean {
    if (this.kind !== 'task' || this.taskBoxFrom === undefined) return true;
    return event.type !== 'click' && event.type !== 'mousedown';
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
      span.textContent = '\u25CB'; /* ○ */
    }
    return span;
  }

  eq(other: MarkerWidget) {
    return (
      this.kind === other.kind &&
      this.taskState === other.taskState &&
      this.taskBoxFrom === other.taskBoxFrom &&
      this.taskBoxTo === other.taskBoxTo
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

const hidden = Decoration.replace({ widget: new HiddenWidget() });
const syntaxFade = Decoration.mark({ class: 'cm-live-preview-syntax-fade' });

// --- Line decorations ---

const headingLineDecos: Record<number, Decoration> = {};
for (let level = 1; level <= 6; level++) {
  headingLineDecos[level] = Decoration.line({ class: `cm-live-preview-h${level}` });
}

const blockquoteLineDeco = Decoration.line({ class: 'cm-live-preview-blockquote' });
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
          decorations.push(hidden.range(line.from, line.from + leadingLen));
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
          decorations.push(hidden.range(from, Math.min(hideEnd, line.to)));
        }
        return;
      }

      // Blockquote: style lines that have ">" (optional leading whitespace); indent + hidden for leading tabs/spaces.
      if (name === 'Blockquote') {
        let pos = from;
        while (pos < to) {
          const line = doc.lineAt(pos);
          const lineText = line.text;
          const qMatch = lineText.match(/^(\s*)(> ?)/);
          if (qMatch && qMatch[2]) {
            // Decorate only after space: require "> " (not lone ">" at EOL)
            const isBlockquote = qMatch[2] === '> ';
            if (!isBlockquote) {
              pos = line.to + 1;
              continue;
            }
            decorations.push(blockquoteLineDeco.range(line.from));
            const leadingLen = qMatch[1].length;
            if (leadingLen > 0) {
              const leadingPart = qMatch[1];
              const tabCount = (leadingPart.match(/\t/g) ?? []).length;
              const spaceCount = (leadingPart.match(/ /g) ?? []).length;
              const indentLevel = Math.min(Math.max(tabCount, Math.floor(spaceCount / 4)), 3);
              decorations.push(indentLineDecos[indentLevel].range(line.from));
              decorations.push(hidden.range(line.from, line.from + leadingLen));
            }
            const markerStart = line.from + leadingLen;
            const markerEnd = markerStart + qMatch[2].length;
            decorations.push(hidden.range(markerStart, markerEnd));
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
            decorations.push(hidden.range(from, contentFrom));
            decorations.push(hidden.range(contentTo, to));
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
            decorations.push(hidden.range(from, contentFrom));
            decorations.push(hidden.range(contentTo, to));
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
            decorations.push(hidden.range(from, contentFrom));
            decorations.push(hidden.range(contentTo, to));
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
            decorations.push(hidden.range(from, contentFrom));
            decorations.push(hidden.range(contentTo, to));
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
            decorations.push(hidden.range(from, linkTextFrom));
            decorations.push(linkMark);
            decorations.push(hidden.range(linkTextTo, to));
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
            decorations.push(hidden.range(from, urlFrom));
            decorations.push(hidden.range(urlTo, to));
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

    listLineMap.set(lineFrom, { kind, taskState, markerFrom: listMark.from, markerTo, taskBoxFrom, taskBoxTo });
  }
}

// --- Build decorations for a given state ---
//
// Uses syntax tree when complete (tree.length >= doc.length) for: ATX headings, blockquotes,
// bold/italic/strikethrough/inline code, [text](url) links, and <url> autolinks. Falls back to
// regex for those when tree is incomplete. Wiki-links, @mentions, #hashtags remain regex-only.

const TASK_BULLET_REGEX = /^(\s*)([-+] \[([x\->  ])\] |(\*) |([-+]) )/;

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
        decorations.push(hidden.range(line.from, line.from + leadingLen));
      }
      const hashFrom = line.from + leadingLen;
      const hashFadeTo = Math.min(hashFrom + hashLen, line.to);
      const hashHideTo = Math.min(hashFrom + hashLen + 1, line.to); // hashes + space
      if (onCursorLine) {
        decorations.push(syntaxFade.range(hashFrom, hashFadeTo));
      } else {
        decorations.push(hidden.range(hashFrom, hashHideTo));
      }
    }

    // Blockquotes: only when not from tree. Decorate only after space: "> " (not ">text" or lone ">").
    if (!useTreeForBlocks && quoteMatch && quoteMatch[2]) {
      const quoteLeading = quoteMatch[1];
      const quoteMarker = quoteMatch[2];
      // Decorate only after space: require "> " (not lone ">" at EOL)
      const isBlockquote = quoteMarker === '> ';
      if (!isBlockquote) {
        // ">foo" etc. — skip so we don't apply blockquote prematurely
      } else {
      const leadingLen = quoteLeading.length;
      decorations.push(blockquoteLineDeco.range(line.from));
      if (leadingLen > 0) {
        const leadingPart = quoteLeading;
        const tabCount = (leadingPart.match(/\t/g) ?? []).length;
        const spaceCount = (leadingPart.match(/ /g) ?? []).length;
        const indentLevel = Math.min(Math.max(tabCount, Math.floor(spaceCount / 4)), 3);
        decorations.push(indentLineDecos[indentLevel].range(line.from));
        decorations.push(hidden.range(line.from, line.from + leadingLen));
      }
      const markerStart = line.from + leadingLen;
      const markerEnd = markerStart + quoteMarker.length;
      decorations.push(hidden.range(markerStart, markerEnd));
      }
    }

    const taskMatch = text.match(TASK_BULLET_REGEX);

    // Tab-indented plain paragraphs: indent + hidden so block indent and wrap align (same as list/blockquote).
    if (!headingMatch && !quoteMatch && !taskMatch && !listLineMap.has(line.from)) {
      const paraLeading = text.match(/^(\s+)/);
      if (paraLeading && line.text.trim().length > 0) {
        const leadingLen = paraLeading[1].length;
        const leadingPart = paraLeading[1];
        const tabCount = (leadingPart.match(/\t/g) ?? []).length;
        const spaceCount = (leadingPart.match(/ /g) ?? []).length;
        const indentLevel = Math.min(Math.max(tabCount, Math.floor(spaceCount / 4)), 3);
        if (indentLevel >= 1) {
          decorations.push(indentLineDecos[indentLevel].range(line.from));
          decorations.push(hidden.range(line.from, line.from + leadingLen));
        }
      }
    }

    // List/task/ordered line: line deco + replace marker range with inline widget (CM6-native; range is atomic).
    const resolved = listLineMap.get(line.from) ?? (taskMatch ? resolveListLineFromRegex(line, taskMatch) : null);
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
        decorations.push(hidden.range(line.from, line.from + leadingLen));
      }

      // Marker replace: only the marker (after leading whitespace), so we don't overlap with hidden.
      const markerFrom = leadingLen > 0 ? line.from + leadingLen : resolved.markerFrom;
      const markerTo = resolved.markerTo;
      if (markerFrom < markerTo && markerFrom >= line.from && markerTo <= line.to && markerTo <= doc.length) {
        decorations.push(
          Decoration.replace({
            widget: new MarkerWidget(
            resolved.kind,
            resolved.taskState,
            resolved.taskBoxFrom,
            resolved.taskBoxTo,
          ),
            inclusive: false,
          }).range(markerFrom, markerTo),
        );
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
          decorations.push(hidden.range(start, start + markerLen));
          decorations.push(Decoration.mark({ class: 'cm-live-preview-bold' }).range(
            start + markerLen, start + markerLen + match[2].length
          ));
          decorations.push(hidden.range(end - markerLen, end));
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
          decorations.push(hidden.range(start, start + 1));
          decorations.push(Decoration.mark({ class: 'cm-live-preview-italic' }).range(
            start + 1, start + 1 + content.length
          ));
          decorations.push(hidden.range(end - 1, end));
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
          decorations.push(hidden.range(start, start + 2));
          decorations.push(Decoration.mark({ class: 'cm-live-preview-strikethrough' }).range(
            start + 2, start + 2 + match[1].length
          ));
          decorations.push(hidden.range(end - 2, end));
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
          decorations.push(hidden.range(start, start + 1));
          decorations.push(Decoration.mark({ class: 'cm-live-preview-code' }).range(
            start + 1, start + 1 + match[2].length
          ));
          decorations.push(hidden.range(end - 1, end));
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
        decorations.push(hidden.range(start, start + 2));
        decorations.push(linkMark.range(start + 2, start + 2 + linkTarget.length));
        decorations.push(hidden.range(end - 2, end));
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
            decorations.push(hidden.range(start, start + 1));
            decorations.push(Decoration.mark({
              class: 'cm-live-preview-extlink',
              attributes: { 'data-href': url },
            }).range(start + 1, linkEnd));
            decorations.push(hidden.range(linkEnd, end));
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
          decorations.push(hidden.range(start, urlFrom));
          decorations.push(hidden.range(urlTo, end));
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
      } else if (sel.empty && newPos !== this.cursorPos) {
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
