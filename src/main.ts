import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
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

// NotePlan Setapp data path, relative to $HOME
const NOTEPLAN_BASE = 'Library/Containers/co.noteplan.NotePlan-setapp/Data/Library/Application Support/co.noteplan.NotePlan-setapp';

function todayFilename(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}.txt`;
}

let currentRelPath = '';
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let view: EditorView;

function setStatus(msg: string) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

function setFilename(name: string) {
  const el = document.getElementById('filename');
  if (el) el.textContent = name;
}

function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
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
    console.log('[daymark] Reading:', relPath);
    const content = await readTextFile(relPath, { baseDir: BaseDirectory.Home });
    console.log('[daymark] Read OK, length:', content.length);
    return content;
  } catch (err) {
    console.error('[daymark] Read failed:', relPath, err);
    setStatus('Read error — check console');
    return '';
  }
}

async function init() {
  const dailyNote = todayFilename();
  currentRelPath = `${NOTEPLAN_BASE}/Calendar/${dailyNote}`;

  setFilename(dailyNote);
  setStatus('Loading…');

  const content = await loadFile(currentRelPath);

  const state = EditorState.create({
    doc: content,
    extensions: [
      lineNumbers(),
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
    ],
  });

  view = new EditorView({
    state,
    parent: document.getElementById('editor')!,
  });

  setStatus(content ? '' : 'New note');
}

init().catch((err) => {
  console.error('[daymark] Init failed:', err);
  setStatus(`Error: ${err}`);
});
