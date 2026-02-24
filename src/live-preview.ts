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
    span.innerHTML = `<i class="${icon}"></i> `;
    return span;
  }

  eq(other: TaskWidget) {
    return this.taskState === other.taskState;
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
const doneTaskLineDeco = Decoration.line({ class: 'cm-live-preview-task-done-line' });
const cancelledTaskLineDeco = Decoration.line({ class: 'cm-live-preview-task-cancelled-line' });
const cancelledTextMark = Decoration.mark({ class: 'cm-live-preview-task-cancelled-text' });
const scheduledTaskLineDeco = Decoration.line({ class: 'cm-live-preview-task-scheduled-line' });

// --- Build decorations for a given state ---
//
// Heading font size always applied; `#` prefix inline-scoped like everything
// else. Raw markers shown only when cursor is within the match range.

function buildDecorations(state: EditorState, cursorPos: number): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const doc = state.doc;
  const cursorLine = doc.lineAt(cursorPos).number;

  // True when cursor is inside [from, to] (inclusive of boundaries)
  const cursorIn = (from: number, to: number) =>
    cursorPos >= from && cursorPos <= to;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;
    const onCursorLine = (i === cursorLine);

    // Headings: font size always applied; # prefix hidden or faded
    const headingMatch = text.match(/^(#{1,6})\s/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      decorations.push(headingLineDecos[level].range(line.from));
      const hashEnd = line.from + headingMatch[0].length;
      if (onCursorLine && cursorIn(line.from, hashEnd)) {
        decorations.push(syntaxFade.range(line.from, line.from + headingMatch[1].length));
      } else {
        decorations.push(hidden.range(line.from, hashEnd));
      }
    }

    // Blockquotes: `> text`
    const quoteMatch = text.match(/^(> ?)/);
    if (quoteMatch) {
      decorations.push(blockquoteLineDeco.range(line.from));
      const markerEnd = line.from + quoteMatch[0].length;
      if (onCursorLine && cursorIn(line.from, markerEnd)) {
        decorations.push(syntaxFade.range(line.from, markerEnd));
      } else {
        decorations.push(hidden.range(line.from, markerEnd));
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

    // Tasks: `- `, `- [ ] `, `- [x] `, `- [-] `, `- [>] `
    // Replace the entire task prefix (indent + marker) with an icon widget
    const taskMatch = text.match(/^(\s*)(- \[([x\->  ])\] |(\*) |(-) )/);
    if (taskMatch) {
      const indent = taskMatch[1].length;
      const prefix = taskMatch[2];
      const prefixStart = line.from + indent;
      const prefixEnd = prefixStart + prefix.length;

      let taskState: TaskState | null = null;
      if (taskMatch[3] !== undefined) {
        const marker = taskMatch[3];
        if (marker === 'x') taskState = 'done';
        else if (marker === '-') taskState = 'cancelled';
        else if (marker === '>') taskState = 'scheduled';
        else taskState = 'open';
      } else if (taskMatch[5]) {
        // `- ` alone is an open task, unless followed by short bracket syntax
        // like `[]`, `[x]`, `[ ]` — that's a checkbox being edited mid-keystroke
        const afterDash = text.slice(indent + 2);
        if (!afterDash.match(/^\[.?\]/)) {
          taskState = 'open';
        }
      }
      // `* ` (taskMatch[4]) is a plain bullet, not a task — skip

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

      // Icon widget is inline-scoped
      if (taskState && !(onCursorLine && cursorIn(prefixStart, prefixEnd))) {
        const widget = new TaskWidget(taskState);
        decorations.push(Decoration.replace({ widget }).range(prefixStart, prefixEnd));
      }
    }

    // @mentions: @FirstnameLastname (not preceded by alphanumeric or dot — avoids emails)
    for (const match of text.matchAll(/(?<![a-zA-Z0-9.])(@[A-Za-z]\w+)/g)) {
      const start = line.from + match.index!;
      const end = start + match[1].length;
      decorations.push(Decoration.mark({
        class: 'cm-live-preview-mention',
        attributes: { 'data-mention': match[1] },
      }).range(start, end));
    }

    // #hashtags: not at line start (avoids headings), requires letter after #
    for (const match of text.matchAll(/(?:(?<=\s)|^)(?<!^)(#[A-Za-z]\w+)/gm)) {
      if (match.index === 0) continue; // skip if # is at line start (heading)
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
