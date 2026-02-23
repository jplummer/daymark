/**
 * Live preview extension for CodeMirror 6.
 *
 * Hides markdown syntax characters (e.g. **, ##, [[, ]]) via replace
 * decorations on all lines except the one the cursor is on. When the
 * cursor moves to a line, decorations are removed so you see the raw
 * markdown and can edit it naturally.
 *
 * Currently handles: headings, bold, italic, wiki-links, inline code,
 * strikethrough, task checkboxes, and external links.
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

class CheckboxWidget extends WidgetType {
  constructor(private checked: boolean, private cancelled: boolean) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-live-preview-checkbox';
    if (this.cancelled) {
      span.textContent = '⊘';
      span.classList.add('cancelled');
    } else if (this.checked) {
      span.textContent = '☑';
      span.classList.add('checked');
    } else {
      span.textContent = '☐';
    }
    return span;
  }

  eq(other: CheckboxWidget) {
    return this.checked === other.checked && this.cancelled === other.cancelled;
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

// --- Heading styles applied as line decorations ---

const headingLineDecos: Record<number, Decoration> = {};
for (let level = 1; level <= 6; level++) {
  headingLineDecos[level] = Decoration.line({ class: `cm-live-preview-h${level}` });
}

// --- Build decorations for a given state ---

function buildDecorations(state: EditorState, cursorLine: number): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const doc = state.doc;

  // Walk each line to find syntax we want to decorate
  for (let i = 1; i <= doc.lines; i++) {
    if (i === cursorLine) continue;

    const line = doc.line(i);
    const text = line.text;

    // Headings: hide the # characters and trailing space
    const headingMatch = text.match(/^(#{1,6})\s/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      decorations.push(headingLineDecos[level].range(line.from));
      decorations.push(hidden.range(line.from, line.from + headingMatch[0].length));
    }

    // Inline patterns — scan the line for syntax markers
    // Bold: **text** or __text__
    for (const match of text.matchAll(/(\*\*|__)(.+?)\1/g)) {
      const start = line.from + match.index!;
      const markerLen = match[1].length;
      decorations.push(hidden.range(start, start + markerLen));
      decorations.push(Decoration.mark({ class: 'cm-live-preview-bold' }).range(
        start + markerLen, start + markerLen + match[2].length
      ));
      decorations.push(hidden.range(start + match[0].length - markerLen, start + match[0].length));
    }

    // Italic: *text* or _text_ (but not ** or __)
    for (const match of text.matchAll(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g)) {
      const start = line.from + match.index!;
      const content = match[1] || match[2];
      decorations.push(hidden.range(start, start + 1));
      decorations.push(Decoration.mark({ class: 'cm-live-preview-italic' }).range(
        start + 1, start + 1 + content.length
      ));
      decorations.push(hidden.range(start + match[0].length - 1, start + match[0].length));
    }

    // Strikethrough: ~~text~~
    for (const match of text.matchAll(/~~(.+?)~~/g)) {
      const start = line.from + match.index!;
      decorations.push(hidden.range(start, start + 2));
      decorations.push(Decoration.mark({ class: 'cm-live-preview-strikethrough' }).range(
        start + 2, start + 2 + match[1].length
      ));
      decorations.push(hidden.range(start + match[0].length - 2, start + match[0].length));
    }

    // Inline code: `text`
    for (const match of text.matchAll(/(?<!`)(`)((?!`).+?)(`)/g)) {
      const start = line.from + match.index!;
      decorations.push(hidden.range(start, start + 1));
      decorations.push(Decoration.mark({ class: 'cm-live-preview-code' }).range(
        start + 1, start + 1 + match[2].length
      ));
      decorations.push(hidden.range(start + match[0].length - 1, start + match[0].length));
    }

    // Wiki-links: [[text]]
    for (const match of text.matchAll(/\[\[(.+?)\]\]/g)) {
      const start = line.from + match.index!;
      decorations.push(hidden.range(start, start + 2));
      decorations.push(Decoration.mark({ class: 'cm-live-preview-wikilink' }).range(
        start + 2, start + 2 + match[1].length
      ));
      decorations.push(hidden.range(start + match[0].length - 2, start + match[0].length));
    }

    // External links: [text](url) and bare URLs
    // Combined regex so bare URLs inside markdown links aren't double-matched
    for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)|(https?:\/\/\S+)/g)) {
      const start = line.from + match.index!;

      if (match[1] && match[2]) {
        // Markdown link: [text](url)
        const linkText = match[1];
        const url = match[2];
        decorations.push(hidden.range(start, start + 1));
        decorations.push(Decoration.mark({
          class: 'cm-live-preview-extlink',
          attributes: { 'data-href': url },
        }).range(start + 1, start + 1 + linkText.length));
        decorations.push(hidden.range(
          start + 1 + linkText.length,
          start + match[0].length
        ));
        decorations.push(Decoration.widget({
          widget: new LinkArrowWidget(url),
          side: 1,
        }).range(start + 1 + linkText.length));
      } else if (match[3]) {
        // Bare URL
        const url = match[3];
        decorations.push(Decoration.mark({
          class: 'cm-live-preview-extlink',
          attributes: { 'data-href': url },
        }).range(start, start + url.length));
      }
    }

    // Task checkboxes: - [ ], - [x], - [-]
    const taskMatch = text.match(/^(\s*- )\[([ x\-])\]/);
    if (taskMatch) {
      const checkStart = line.from + taskMatch[1].length;
      const marker = taskMatch[2];
      const widget = new CheckboxWidget(marker === 'x', marker === '-');
      decorations.push(Decoration.replace({ widget }).range(checkStart, checkStart + 3));
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
    cursorLine: number;

    constructor(view: EditorView) {
      this.cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
      this.decorations = buildDecorations(view.state, this.cursorLine);
    }

    update(update: ViewUpdate) {
      const newCursorLine = update.state.doc.lineAt(update.state.selection.main.head).number;

      if (update.docChanged || update.viewportChanged || newCursorLine !== this.cursorLine) {
        this.cursorLine = newCursorLine;
        this.decorations = buildDecorations(update.state, this.cursorLine);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
