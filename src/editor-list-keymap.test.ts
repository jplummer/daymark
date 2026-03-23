/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, afterEach } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';
import { orderedListBodyInsertFilter } from './live-preview';
import {
  backspaceMarkerLineAware,
  enterListAndBlockquoteAware,
  listLineKeymapExtensions,
  shiftTabOnHeadingOrListLine,
  tabOnHeadingOrListLine,
} from './editor-list-keymap';

let lastView: EditorView | null = null;

afterEach(() => {
  lastView?.destroy();
  lastView = null;
  document.body.replaceChildren();
});

function mkView(doc: string, anchor: number) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(anchor),
    extensions: [
      orderedListBodyInsertFilter,
      indentUnit.of('\t'),
      ...listLineKeymapExtensions(),
    ],
  });
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state, parent });
  lastView = view;
  return view;
}

describe('enterListAndBlockquoteAware', () => {
  it('clears a marker-only task line on Enter', () => {
    const line = '- [ ] ';
    const view = mkView(line, line.length);
    expect(enterListAndBlockquoteAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('');
  });

  it('clears marker-only ordered line on Enter', () => {
    const line = '1) ';
    const view = mkView(line, line.length);
    expect(enterListAndBlockquoteAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('');
  });

  it('clears marker-only blockquote line on Enter', () => {
    const line = '> ';
    const view = mkView(line, line.length);
    expect(enterListAndBlockquoteAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('');
  });

  it('clears marker-only asterisk bullet on Enter', () => {
    const line = '* ';
    const view = mkView(line, line.length);
    expect(enterListAndBlockquoteAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('');
  });

  it('continues task list with - [ ] on Enter when line has text', () => {
    const line = '- [ ] hello';
    const view = mkView(line, line.length);
    expect(enterListAndBlockquoteAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- [ ] hello\n- [ ] ');
  });

  it('continues checklist (+) with + [ ] on Enter', () => {
    const line = '+ step';
    const view = mkView(line, line.length);
    expect(enterListAndBlockquoteAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('+ step\n+ [ ] ');
  });

  it('continues * bullet with * on Enter', () => {
    const line = '* item';
    const view = mkView(line, line.length);
    expect(enterListAndBlockquoteAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('* item\n* ');
  });

  it('continues - bullet with - [ ] on Enter (dash bullet becomes task continuation)', () => {
    const line = '- item';
    const view = mkView(line, line.length);
    expect(enterListAndBlockquoteAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- item\n- [ ] ');
  });

  it('continues blockquote with > on Enter', () => {
    const line = '> quote';
    const view = mkView(line, line.length);
    expect(enterListAndBlockquoteAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('> quote\n> ');
  });

  it('continues ordered list with next number on Enter', () => {
    const doc = '1) first';
    const view = mkView(doc, doc.length);
    expect(enterListAndBlockquoteAware(view)).toBe(true);
    const t = view.state.doc.toString();
    expect(t.startsWith('1) first\n')).toBe(true);
    expect(t).toMatch(/^1\) first\n2\) /);
  });

  it('inserts plain newline on Enter for non-list body line', () => {
    const doc = 'paragraph';
    const view = mkView(doc, doc.length);
    expect(enterListAndBlockquoteAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('paragraph\n');
  });

  it('returns false when selection is not empty', () => {
    const doc = '- [ ] x';
    const state = EditorState.create({
      doc,
      selection: { anchor: 0, head: doc.length },
      extensions: [
        orderedListBodyInsertFilter,
        indentUnit.of('\t'),
        ...listLineKeymapExtensions(),
      ],
    });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ state, parent });
    lastView = view;
    expect(enterListAndBlockquoteAware(view)).toBe(false);
  });
});

describe('backspaceMarkerLineAware', () => {
  it('clears marker-only task line when caret is at end of line', () => {
    const line = '- [ ] ';
    const view = mkView(line, line.length);
    expect(backspaceMarkerLineAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('');
  });

  it('clears marker-only ordered line', () => {
    const line = '2) ';
    const view = mkView(line, line.length);
    expect(backspaceMarkerLineAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('');
  });

  it('clears marker-only blockquote line', () => {
    const line = '> ';
    const view = mkView(line, line.length);
    expect(backspaceMarkerLineAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('');
  });

  it('clears marker-only asterisk bullet line', () => {
    const line = '* ';
    const view = mkView(line, line.length);
    expect(backspaceMarkerLineAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('');
  });

  it('clears dash-only bullet line', () => {
    const line = '- ';
    const view = mkView(line, line.length);
    expect(backspaceMarkerLineAware(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('');
  });

  it('does nothing when caret is not at end of line', () => {
    const line = '- [ ] hello';
    const view = mkView(line, 2);
    expect(backspaceMarkerLineAware(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(line);
  });

  it('returns false when selection is not empty', () => {
    const line = '- [ ] ';
    const state = EditorState.create({
      doc: line,
      selection: { anchor: 0, head: line.length },
      extensions: [
        orderedListBodyInsertFilter,
        indentUnit.of('\t'),
        ...listLineKeymapExtensions(),
      ],
    });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ state, parent });
    lastView = view;
    expect(backspaceMarkerLineAware(view)).toBe(false);
  });
});

describe('tabOnHeadingOrListLine / shiftTabOnHeadingOrListLine', () => {
  it('inserts tab at line start for ordered list and pins caret after marker', () => {
    const doc = '1. item';
    const view = mkView(doc, 0);
    expect(tabOnHeadingOrListLine(view)).toBe(true);
    expect(view.state.doc.toString().startsWith('\t')).toBe(true);
    const head = view.state.selection.main.head;
    const after = view.state.doc.line(1).text.match(/^\t(\d+\.\s)/);
    expect(after).toBeTruthy();
    expect(head).toBeGreaterThan(0);
  });

  it('inserts tab at line start for ATX heading', () => {
    const doc = '# Title';
    const view = mkView(doc, 0);
    expect(tabOnHeadingOrListLine(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('\t# Title');
    expect(view.state.selection.main.head).toBe(1);
  });

  it('inserts tab at line start for task list line', () => {
    const doc = '- [ ] task';
    const view = mkView(doc, 0);
    expect(tabOnHeadingOrListLine(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('\t- [ ] task');
  });

  it('returns false for plain paragraph (not heading or list)', () => {
    const doc = 'hello';
    const view = mkView(doc, 0);
    expect(tabOnHeadingOrListLine(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('hello');
  });

  it('outdents leading tab on ordered list', () => {
    const doc = '\t2. item';
    const view = mkView(doc, 1);
    expect(shiftTabOnHeadingOrListLine(view)).toBe(true);
    expect(view.state.doc.toString().startsWith('1.')).toBe(true);
  });

  it('outdents leading tab on heading', () => {
    const doc = '\t## H2';
    const view = mkView(doc, 1);
    expect(shiftTabOnHeadingOrListLine(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('## H2');
  });

  it('returns false on Shift-Tab when line has no leading indent', () => {
    const doc = '1. x';
    const view = mkView(doc, 0);
    expect(shiftTabOnHeadingOrListLine(view)).toBe(false);
  });

  it('returns false on Tab when selection is not empty', () => {
    const doc = '- [ ] ';
    const state = EditorState.create({
      doc,
      selection: { anchor: 0, head: doc.length },
      extensions: [
        orderedListBodyInsertFilter,
        indentUnit.of('\t'),
        ...listLineKeymapExtensions(),
      ],
    });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ state, parent });
    lastView = view;
    expect(tabOnHeadingOrListLine(view)).toBe(false);
  });
});
