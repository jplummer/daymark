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

type TaskState = 'open' | 'done' | 'cancelled' | 'scheduled';

const taskIcons: Record<TaskState, { icon: string; cls: string }> = {
  open:      { icon: 'ri-circle-line',               cls: 'open' },
  done:      { icon: 'ri-checkbox-circle-line',       cls: 'done' },
  cancelled: { icon: 'ri-indeterminate-circle-line',  cls: 'cancelled' },
  scheduled: { icon: 'ri-arrow-right-circle-line',    cls: 'scheduled' },
};

class TaskWidget extends WidgetType {
  constructor(readonly taskState: TaskState) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    const { icon, cls } = taskIcons[this.taskState];
    span.className = `cm-live-preview-task ${cls}`;
    span.innerHTML = `<i class="${icon}"></i>`;
    return span;
  }

  eq(other: TaskWidget) {
    return this.taskState === other.taskState;
  }
}

class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-live-preview-bullet';
    span.textContent = '•';
    return span;
  }

  eq() { return true; }
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
const doneTaskLineDeco = Decoration.line({ class: 'cm-live-preview-task-done-line' });
const cancelledTaskLineDeco = Decoration.line({ class: 'cm-live-preview-task-cancelled-line' });
const cancelledTextMark = Decoration.mark({ class: 'cm-live-preview-task-cancelled-text' });
const scheduledTaskLineDeco = Decoration.line({ class: 'cm-live-preview-task-scheduled-line' });
const listLineDeco = Decoration.line({ class: 'cm-live-preview-list-line' });

const indentLineDecos: Record<number, Decoration> = {};
for (let n = 1; n <= 3; n++) {
  indentLineDecos[n] = Decoration.line({ class: `cm-live-preview-indent-${n}` });
}

// --- Build decorations from syntax tree (when available) ---

interface ListLineInfo {
  listMark: { from: number; to: number };
  taskMarker?: { from: number; to: number };
}

function buildDecorationsFromTree(
  state: EditorState,
  cursorPos: number,
  decorations: Range<Decoration>[],
  linesWithListFromTree: Set<number>,
): void {
  const tree = syntaxTree(state);
  const doc = state.doc;
  if (tree.length < doc.length) return;

  const cursorIn = (from: number, to: number) =>
    cursorPos >= from && cursorPos <= to;

  const listLinesByLineFrom = new Map<number, ListLineInfo>();

  tree.iterate({
    enter(node) {
      const name = node.type.name;
      const { from, to } = node;

      // ATX headings: ## Title
      const atxMatch = /^ATXHeading(\d)$/.exec(name);
      if (atxMatch) {
        const level = parseInt(atxMatch[1], 10);
        decorations.push(headingLineDecos[level].range(from));
        return;
      }

      // Setext headings: Title\n===
      const setextMatch = /^SetextHeading(\d)$/.exec(name);
      if (setextMatch) {
        const level = parseInt(setextMatch[1], 10);
        decorations.push(headingLineDecos[level].range(from));
        return;
      }

      // # prefix (hide or fade when cursor in range)
      if (name === 'HeaderMark') {
        if (cursorIn(from, to)) {
          decorations.push(syntaxFade.range(from, to));
        } else {
          decorations.push(hidden.range(from, to));
        }
        return;
      }

      // Blockquote container: one node per line with ">"
      if (name === 'Blockquote') {
        let pos = from;
        while (pos < to) {
          const line = doc.lineAt(pos);
          decorations.push(blockquoteLineDeco.range(line.from));
          pos = line.to + 1;
        }
        return;
      }

      // > prefix (hide or fade when cursor in range)
      if (name === 'QuoteMark') {
        if (cursorIn(from, to)) {
          decorations.push(syntaxFade.range(from, to));
        } else {
          decorations.push(hidden.range(from, to));
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

  // Apply list/task decorations from collected tree nodes.
  // Only take lines that are GFM task ([ ]/[x]) or * bullet; let regex handle "- "/"+ " and NotePlan markers ([-], [>]).
  for (const [lineFrom, info] of listLinesByLineFrom) {
    const line = doc.lineAt(lineFrom);
    const { listMark, taskMarker } = info;
    const listMarkText = doc.sliceString(listMark.from, listMark.to);
    const isGfmTask = !!taskMarker;
    const isBulletOnly = !taskMarker && (listMarkText === '* ' || listMarkText === '*\t');
    if (!isGfmTask && !isBulletOnly) continue;

    const indentStart = line.from;
    const indentEnd = listMark.from;
    const hasIndent = indentEnd > indentStart;
    const prefixEnd = taskMarker ? taskMarker.to : listMark.to;
    const showingRaw = cursorIn(line.from, prefixEnd);

    linesWithListFromTree.add(line.from);

    if (hasIndent) {
      const indentStr = doc.sliceString(indentStart, indentEnd);
      const tabCount = Math.min((indentStr.match(/\t/g) || []).length, 3);
      if (tabCount > 0) {
        decorations.push(hidden.range(indentStart, indentEnd));
        decorations.push(indentLineDecos[tabCount].range(line.from));
      }
      decorations.push(listLineDeco.range(line.from));
    } else if (!showingRaw) {
      decorations.push(listLineDeco.range(line.from));
    }

    if (!showingRaw) {
      if (taskMarker) {
        decorations.push(hidden.range(listMark.from, listMark.to));
        const markerText = doc.sliceString(taskMarker.from, taskMarker.to);
        const checked = markerText.length >= 2 && (markerText[1] === 'x' || markerText[1] === 'X');
        const taskState: TaskState = checked ? 'done' : 'open';
        const widget = new TaskWidget(taskState);
        decorations.push(Decoration.replace({ widget }).range(taskMarker.from, taskMarker.to));
        if (checked) {
          decorations.push(doneTaskLineDeco.range(line.from));
        }
      } else {
        const widget = new BulletWidget();
        decorations.push(Decoration.replace({ widget }).range(listMark.from, listMark.to));
      }
    }
  }
}

// --- Build decorations for a given state ---
//
// Uses syntax tree for headings and blockquotes when tree is complete;
// otherwise falls back to regex. Rest remains regex-based.

function buildDecorations(state: EditorState, cursorPos: number): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const doc = state.doc;
  const cursorLine = doc.lineAt(cursorPos).number;

  const cursorIn = (from: number, to: number) =>
    cursorPos >= from && cursorPos <= to;

  const tree = syntaxTree(state);
  const useTreeForBlocks = tree.length >= doc.length;
  const linesWithListFromTree = new Set<number>();
  if (useTreeForBlocks) {
    buildDecorationsFromTree(state, cursorPos, decorations, linesWithListFromTree);
  }

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;
    const onCursorLine = (i === cursorLine);

    const headingMatch = text.match(/^(#{1,6})\s/);
    const quoteMatch = text.match(/^(> ?)/);

    // Headings: only when not from tree
    if (!useTreeForBlocks && headingMatch) {
      const level = headingMatch[1].length;
      decorations.push(headingLineDecos[level].range(line.from));
      const hashEnd = line.from + headingMatch[0].length;
      if (onCursorLine && cursorIn(line.from, hashEnd)) {
        decorations.push(syntaxFade.range(line.from, line.from + headingMatch[1].length));
      } else {
        decorations.push(hidden.range(line.from, hashEnd));
      }
    }

    // Blockquotes: only when not from tree
    if (!useTreeForBlocks && quoteMatch) {
      decorations.push(blockquoteLineDeco.range(line.from));
      const markerEnd = line.from + quoteMatch[0].length;
      if (onCursorLine && cursorIn(line.from, markerEnd)) {
        decorations.push(syntaxFade.range(line.from, markerEnd));
      } else {
        decorations.push(hidden.range(line.from, markerEnd));
      }
    }

    // Pre-detect tasks/lists so tab handling can skip them
    const taskMatch = text.match(/^(\s*)([-+] \[([x\->  ])\] |(\*) |([-+]) )/);

    // Tab-indented paragraphs: hide tabs and use CSS padding for consistent
    // wrap indent. Only for lines that aren't headings, blockquotes, or lists.
    if (!headingMatch && !quoteMatch && !taskMatch && !linesWithListFromTree.has(line.from)) {
      const tabMatch = text.match(/^(\t+)/);
      if (tabMatch) {
        const tabCount = Math.min(tabMatch[1].length, 3);
        const tabEnd = line.from + tabMatch[1].length;
        const inTabPrefix = onCursorLine && cursorIn(line.from, tabEnd);
        if (!inTabPrefix) {
          decorations.push(hidden.range(line.from, tabEnd));
          decorations.push(indentLineDecos[tabCount].range(line.from));
        }
      }
    }

    // Inline patterns — all inline-scoped from here down

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

    // Wiki-links: [[text]]
    for (const match of text.matchAll(/\[\[(.+?)\]\]/g)) {
      const start = line.from + match.index!;
      const end = start + match[0].length;
      const linkTarget = match[1];
      const linkMark = Decoration.mark({
        class: 'cm-live-preview-wikilink',
        attributes: { 'data-link': linkTarget },
      });
      if (onCursorLine && cursorIn(start, end)) {
        decorations.push(syntaxFade.range(start, start + 2));
        decorations.push(linkMark.range(start + 2, start + 2 + linkTarget.length));
        decorations.push(syntaxFade.range(end - 2, end));
      } else {
        decorations.push(hidden.range(start, start + 2));
        decorations.push(linkMark.range(start + 2, start + 2 + linkTarget.length));
        decorations.push(hidden.range(end - 2, end));
      }
    }

    // External links: [text](url) and bare URLs
    for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)|(https?:\/\/\S+)/g)) {
      const start = line.from + match.index!;
      const end = start + match[0].length;

      if (match[1] && match[2]) {
        const linkText = match[1];
        const url = match[2];
        if (onCursorLine && cursorIn(start, end)) {
          decorations.push(syntaxFade.range(start, start + 1));
          decorations.push(Decoration.mark({
            class: 'cm-live-preview-extlink',
            attributes: { 'data-href': url },
          }).range(start + 1, start + 1 + linkText.length));
          decorations.push(syntaxFade.range(start + 1 + linkText.length, end));
        } else {
          decorations.push(hidden.range(start, start + 1));
          decorations.push(Decoration.mark({
            class: 'cm-live-preview-extlink',
            attributes: { 'data-href': url },
          }).range(start + 1, start + 1 + linkText.length));
          decorations.push(hidden.range(start + 1 + linkText.length, end));
          decorations.push(Decoration.widget({
            widget: new LinkArrowWidget(url),
            side: 1,
          }).range(start + 1 + linkText.length));
        }
      } else if (match[3]) {
        const url = match[3];
        decorations.push(Decoration.mark({
          class: 'cm-live-preview-extlink',
          attributes: { 'data-href': url },
        }).range(start, start + url.length));
      }
    }

    // Tasks and bullets: from tree when available, else regex (NotePlan-specific: [-], [>], bare "- ")
    if (taskMatch && !(useTreeForBlocks && linesWithListFromTree.has(line.from))) {
      const indentStr = taskMatch[1];
      const prefix = taskMatch[2];
      const prefixStart = line.from + indentStr.length;
      const prefixEnd = prefixStart + prefix.length;

      let taskState: TaskState | null = null;
      let isBullet = false;

      if (taskMatch[3] !== undefined) {
        const marker = taskMatch[3];
        if (marker === 'x') taskState = 'done';
        else if (marker === '-') taskState = 'cancelled';
        else if (marker === '>') taskState = 'scheduled';
        else taskState = 'open';
      } else if (taskMatch[4]) {
        isBullet = true;
      } else if (taskMatch[5]) {
        const afterMarker = text.slice(indentStr.length + 2);
        if (!afterMarker.match(/^\[.?\]/)) {
          taskState = 'open';
        }
      }

      // Atomic zone: entire whitespace + marker transitions together
      const showingRaw = onCursorLine && cursorIn(line.from, prefixEnd);
      const isIndented = indentStr.length > 0;

      // Non-indented: padding only when widget visible (raw stays at left edge).
      // Indented: always apply indent + list so line doesn't shift when toggling raw.
      if (isIndented) {
        const tabCount = Math.min((indentStr.match(/\t/g) || []).length, 3);
        if (tabCount > 0) {
          decorations.push(hidden.range(line.from, line.from + indentStr.length));
          decorations.push(indentLineDecos[tabCount].range(line.from));
        }
        decorations.push(listLineDeco.range(line.from));
      } else if (!showingRaw) {
        decorations.push(listLineDeco.range(line.from));
      }

      // Marker: widget when not editing, raw when cursor in zone
      if (!showingRaw) {
        if (taskState) {
          const widget = new TaskWidget(taskState);
          decorations.push(Decoration.replace({ widget }).range(prefixStart, prefixEnd));
        } else if (isBullet) {
          const widget = new BulletWidget();
          decorations.push(Decoration.replace({ widget }).range(prefixStart, prefixEnd));
        }
      }

      // Task state line decorations always apply (dimming, strikethrough)
      if (taskState === 'done') {
        decorations.push(doneTaskLineDeco.range(line.from));
      } else if (taskState === 'cancelled') {
        decorations.push(cancelledTaskLineDeco.range(line.from));
        if (prefixEnd < line.to) {
          decorations.push(cancelledTextMark.range(prefixEnd, line.to));
        }
      } else if (taskState === 'scheduled') {
        decorations.push(scheduledTaskLineDeco.range(line.from));
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

  // Sort by position — CM6 requires decorations in document order
  decorations.sort((a, b) => a.from - b.from || a.to! - b.to!);
  return Decoration.set(decorations);
}

// --- Plugin that rebuilds decorations on every relevant change ---

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    cursorPos: number;

    constructor(view: EditorView) {
      this.cursorPos = view.state.selection.main.head;
      this.decorations = buildDecorations(view.state, this.cursorPos);
    }

    update(update: ViewUpdate) {
      const sel = update.state.selection.main;
      const newPos = sel.head;

      if (update.docChanged || update.viewportChanged) {
        this.cursorPos = newPos;
        this.decorations = buildDecorations(update.state, this.cursorPos);
      } else if (sel.empty && newPos !== this.cursorPos) {
        // Collapsed cursor moved — rebuild for inline-scoped decorations.
        // Skip during drag-select (non-empty selection) to avoid breaking selection.
        this.cursorPos = newPos;
        this.decorations = buildDecorations(update.state, this.cursorPos);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
