import { EditorState } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  indentOnInput,
  bracketMatching,
} from '@codemirror/language';
import { readTextFile, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { livePreview } from './live-preview';

// NotePlan Setapp data path, relative to $HOME
const NOTEPLAN_BASE = 'Library/Containers/co.noteplan.NotePlan-setapp/Data/Library/Application Support/co.noteplan.NotePlan-setapp';

// --- Date helpers ---

function formatDateForFile(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}.txt`;
}

function formatDateForDisplay(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

// --- State ---

let currentDate = new Date();
let currentRelPath = '';
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let view: EditorView | null = null;

// --- UI helpers ---

function setStatus(msg: string) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

function setFilename(name: string) {
  const el = document.getElementById('filename');
  if (el) el.textContent = name;
}

function updateTodayButton() {
  const btn = document.getElementById('nav-today') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = isSameDay(currentDate, new Date());
  }
}

// --- File I/O ---

function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    if (!view) return;
    try {
      const content = view.state.doc.toString();
      await writeTextFile(currentRelPath, content, { baseDir: BaseDirectory.Home });
      setStatus('Saved');
      setTimeout(() => setStatus(''), 1500);
    } catch (err) {
      setStatus(`Save error: ${err}`);
      console.error('[daymark] Save failed:', err);
    }
  }, 500);
}

async function loadFile(relPath: string): Promise<string> {
  try {
    return await readTextFile(relPath, { baseDir: BaseDirectory.Home });
  } catch (err) {
    console.warn('[daymark] Read failed (may be new note):', relPath, err);
    return '';
  }
}

// --- Editor extensions (built once, reused across navigations) ---

const editorExtensions = [
  highlightActiveLine(),
  drawSelection(),
  indentOnInput(),
  bracketMatching(),
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  markdown({ base: markdownLanguage, codeLanguages: languages }),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      scheduleSave();
      setStatus('Editing…');
    }
  }),
  EditorView.lineWrapping,
  livePreview,
];

// --- Navigation ---

async function navigateToDate(date: Date) {
  // Flush any pending save for the current note before switching
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
    if (view && currentRelPath) {
      try {
        await writeTextFile(currentRelPath, view.state.doc.toString(), { baseDir: BaseDirectory.Home });
      } catch (err) {
        console.error('[daymark] Save on navigate failed:', err);
      }
    }
  }

  currentDate = date;
  const filename = formatDateForFile(date);
  currentRelPath = `${NOTEPLAN_BASE}/Calendar/${filename}`;

  setFilename(formatDateForDisplay(date));
  updateTodayButton();
  setStatus('Loading…');

  const content = await loadFile(currentRelPath);

  if (view) {
    view.setState(EditorState.create({ doc: content, extensions: editorExtensions }));
  } else {
    const state = EditorState.create({ doc: content, extensions: editorExtensions });
    view = new EditorView({
      state,
      parent: document.getElementById('editor')!,
    });
  }

  setStatus(content ? '' : 'New note');
  view.focus();
}

// --- Init ---

function wireNavButtons() {
  document.getElementById('nav-prev')?.addEventListener('click', () => {
    navigateToDate(addDays(currentDate, -1));
  });
  document.getElementById('nav-next')?.addEventListener('click', () => {
    navigateToDate(addDays(currentDate, 1));
  });
  document.getElementById('nav-today')?.addEventListener('click', () => {
    navigateToDate(new Date());
  });
}

async function init() {
  wireNavButtons();
  await navigateToDate(new Date());
}

init().catch((err) => {
  console.error('[daymark] Init failed:', err);
  setStatus(`Error: ${err}`);
});
