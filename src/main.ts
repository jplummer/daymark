import { EditorState } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, drawSelection, KeyBinding } from '@codemirror/view';
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
import { initSidebar, setActiveTreeItem, TreeNode } from './sidebar';
import 'remixicon/fonts/remixicon.css';

const NOTEPLAN_BASE = 'Library/Containers/co.noteplan.NotePlan-setapp/Data/Library/Application Support/co.noteplan.NotePlan-setapp';

// --- Note location types ---

type NoteType = 'daily' | 'weekly' | 'project';

interface NoteLocation {
  type: NoteType;
  relPath: string;
  displayName: string;
  date?: Date;
  weekInfo?: { year: number; week: number };
}

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

// ISO week number (Monday-based)
function getISOWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

// Monday of ISO week
function mondayOfWeek(year: number, week: number): Date {
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const mondayOfW1 = new Date(jan4);
  mondayOfW1.setDate(jan4.getDate() - dayOfWeek + 1);
  const target = new Date(mondayOfW1);
  target.setDate(mondayOfW1.getDate() + (week - 1) * 7);
  return target;
}

function weeklyFilenameForWeek(year: number, week: number): string {
  return `${year}-W${String(week).padStart(2, '0')}.txt`;
}

function weeklyDisplayNameForWeek(year: number, week: number): string {
  const mon = mondayOfWeek(year, week);
  const sun = addDays(mon, 6);
  const monStr = mon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const sunStr = mon.getMonth() === sun.getMonth()
    ? String(sun.getDate())
    : sun.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `Week ${week} · ${monStr}–${sunStr}, ${year}`;
}

// --- State ---

let currentNote: NoteLocation | null = null;
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let view: EditorView | null = null;
let isDirty = false;

const navHistory: NoteLocation[] = [];
let navIndex = -1;

// --- UI helpers ---

function setStatus(msg: string) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

function updateToolbar(note: NoteLocation) {
  const titleEl = document.getElementById('note-title');
  const dateNav = document.getElementById('nav-date');
  const todayBtn = document.getElementById('nav-today') as HTMLButtonElement | null;

  if (titleEl) {
    titleEl.innerHTML = '';
    if (note.type === 'project') {
      // Show path with emphasized note name
      const prefix = `${NOTEPLAN_BASE}/Notes/`;
      const shortPath = note.relPath.startsWith(prefix)
        ? note.relPath.slice(prefix.length)
        : note.relPath;
      const parts = shortPath.replace(/\.txt$/, '').split('/');
      const fileName = parts.pop() || '';
      if (parts.length > 0) {
        const pathSpan = document.createElement('span');
        pathSpan.className = 'note-path-prefix';
        pathSpan.textContent = parts.join(' › ') + ' › ';
        titleEl.appendChild(pathSpan);
      }
      const nameSpan = document.createElement('span');
      nameSpan.className = 'note-path-name';
      nameSpan.textContent = note.displayName.split('  ·  ')[0] || fileName;
      titleEl.appendChild(nameSpan);
    } else {
      titleEl.textContent = note.displayName;
    }
  }

  // Show date nav for daily and weekly notes
  if (dateNav) {
    dateNav.classList.toggle('hidden', note.type === 'project');
  }

  if (todayBtn && note.type === 'daily' && note.date) {
    todayBtn.disabled = isSameDay(note.date, new Date());
  }
  if (todayBtn && note.type === 'weekly') {
    const currentWeek = getISOWeek(new Date());
    todayBtn.disabled = !!(note.weekInfo
      && note.weekInfo.year === currentWeek.year
      && note.weekInfo.week === currentWeek.week);
  }

  updateHistoryButtons();

  document.getElementById('link-daily')?.classList.toggle('active',
    note.type === 'daily' && !!note.date && isSameDay(note.date, new Date()));
  document.getElementById('link-weekly')?.classList.toggle('active', note.type === 'weekly');
}

function updateHistoryButtons() {
  const backBtn = document.getElementById('nav-back') as HTMLButtonElement | null;
  const fwdBtn = document.getElementById('nav-forward') as HTMLButtonElement | null;
  if (backBtn) backBtn.disabled = navIndex <= 0;
  if (fwdBtn) fwdBtn.disabled = navIndex >= navHistory.length - 1;
}

// --- File I/O ---

function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  isDirty = true;
  saveTimeout = setTimeout(async () => {
    if (!view || !currentNote) return;
    try {
      const content = view.state.doc.toString();
      await writeTextFile(currentNote.relPath, content, { baseDir: BaseDirectory.Home });
      isDirty = false;
      setStatus('Saved');
      setTimeout(() => setStatus(''), 1500);
    } catch (err) {
      setStatus(`Save error: ${err}`);
      console.error('[daymark] Save failed:', err);
    }
  }, 500);
}

async function flushSave(): Promise<void> {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  if (view && currentNote && isDirty) {
    try {
      await writeTextFile(currentNote.relPath, view.state.doc.toString(), { baseDir: BaseDirectory.Home });
      isDirty = false;
    } catch (err) {
      console.error('[daymark] Flush save failed:', err);
    }
  }
}

async function loadFile(relPath: string): Promise<string> {
  try {
    return await readTextFile(relPath, { baseDir: BaseDirectory.Home });
  } catch (err) {
    console.warn('[daymark] Read failed (may be new note):', relPath, err);
    return '';
  }
}

// --- Back/forward as CM6 keybindings ---

function goBack(): boolean {
  if (navIndex > 0) {
    navIndex--;
    navigateTo(navHistory[navIndex], false);
    return true;
  }
  return false;
}

function goForward(): boolean {
  if (navIndex < navHistory.length - 1) {
    navIndex++;
    navigateTo(navHistory[navIndex], false);
    return true;
  }
  return false;
}

const navKeymap: KeyBinding[] = [
  { key: 'Mod-[', run: () => goBack() },
  { key: 'Mod-]', run: () => goForward() },
];

// --- Editor extensions ---

const editorExtensions = [
  highlightActiveLine(),
  drawSelection(),
  indentOnInput(),
  bracketMatching(),
  history(),
  keymap.of([...navKeymap, ...defaultKeymap, ...historyKeymap]),
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

async function navigateTo(note: NoteLocation, addToHistory = true) {
  await flushSave();

  currentNote = note;

  if (addToHistory) {
    navHistory.splice(navIndex + 1);
    navHistory.push(note);
    navIndex = navHistory.length - 1;
  }

  updateToolbar(note);
  setActiveTreeItem(note.relPath);

  const content = await loadFile(note.relPath);

  if (view) {
    view.setState(EditorState.create({ doc: content, extensions: editorExtensions }));
  } else {
    const state = EditorState.create({ doc: content, extensions: editorExtensions });
    view = new EditorView({
      state,
      parent: document.getElementById('editor')!,
    });
  }

  setStatus('');
  view.focus();
}

function dailyNote(date: Date): NoteLocation {
  return {
    type: 'daily',
    relPath: `${NOTEPLAN_BASE}/Calendar/${formatDateForFile(date)}`,
    displayName: formatDateForDisplay(date),
    date,
  };
}

function weeklyNoteForWeek(year: number, week: number): NoteLocation {
  return {
    type: 'weekly',
    relPath: `${NOTEPLAN_BASE}/Calendar/${weeklyFilenameForWeek(year, week)}`,
    displayName: weeklyDisplayNameForWeek(year, week),
    weekInfo: { year, week },
  };
}

function currentWeeklyNote(): NoteLocation {
  const { year, week } = getISOWeek(new Date());
  return weeklyNoteForWeek(year, week);
}

function projectNote(node: TreeNode): NoteLocation {
  return {
    type: 'project',
    relPath: node.relPath,
    displayName: node.title,
  };
}

// Navigate to previous or next period depending on note type
function navigatePrev() {
  if (!currentNote) return;
  if (currentNote.type === 'daily' && currentNote.date) {
    navigateTo(dailyNote(addDays(currentNote.date, -1)));
  } else if (currentNote.type === 'weekly' && currentNote.weekInfo) {
    const { year, week } = currentNote.weekInfo;
    if (week <= 1) {
      const prevYearLastWeek = getISOWeek(new Date(year - 1, 11, 28));
      navigateTo(weeklyNoteForWeek(prevYearLastWeek.year, prevYearLastWeek.week));
    } else {
      navigateTo(weeklyNoteForWeek(year, week - 1));
    }
  }
}

function navigateNext() {
  if (!currentNote) return;
  if (currentNote.type === 'daily' && currentNote.date) {
    navigateTo(dailyNote(addDays(currentNote.date, 1)));
  } else if (currentNote.type === 'weekly' && currentNote.weekInfo) {
    const { year, week } = currentNote.weekInfo;
    const lastWeek = getISOWeek(new Date(year, 11, 28));
    if (week >= lastWeek.week) {
      navigateTo(weeklyNoteForWeek(year + 1, 1));
    } else {
      navigateTo(weeklyNoteForWeek(year, week + 1));
    }
  }
}

function navigateToday() {
  if (!currentNote) return;
  if (currentNote.type === 'daily') {
    navigateTo(dailyNote(new Date()));
  } else if (currentNote.type === 'weekly') {
    navigateTo(currentWeeklyNote());
  }
}

// --- Resize handle ---

function wireResizeHandle() {
  const handle = document.getElementById('resize-handle')!;
  const sidebar = document.getElementById('sidebar')!;

  let startX = 0;
  let startWidth = 0;

  function onMouseMove(e: MouseEvent) {
    const newWidth = Math.max(160, Math.min(500, startWidth + e.clientX - startX));
    sidebar.style.width = `${newWidth}px`;
  }

  function onMouseUp() {
    handle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = '';
  }

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// --- Init ---

function wireNavButtons() {
  document.getElementById('nav-prev')?.addEventListener('click', navigatePrev);
  document.getElementById('nav-next')?.addEventListener('click', navigateNext);
  document.getElementById('nav-today')?.addEventListener('click', navigateToday);

  document.getElementById('nav-back')?.addEventListener('click', () => goBack());
  document.getElementById('nav-forward')?.addEventListener('click', () => goForward());

  document.getElementById('link-daily')?.addEventListener('click', () => {
    navigateTo(dailyNote(new Date()));
  });
  document.getElementById('link-weekly')?.addEventListener('click', () => {
    navigateTo(currentWeeklyNote());
  });

  // Global keyboard shortcuts for back/forward (when editor not focused)
  document.addEventListener('keydown', (e) => {
    if (e.metaKey && e.key === '[') { e.preventDefault(); goBack(); }
    if (e.metaKey && e.key === ']') { e.preventDefault(); goForward(); }
  });
}

async function init() {
  wireNavButtons();
  wireResizeHandle();

  const sidebarReady = initSidebar((node: TreeNode) => {
    navigateTo(projectNote(node));
  });

  await navigateTo(dailyNote(new Date()));
  await sidebarReady;
}

init().catch((err) => {
  console.error('[daymark] Init failed:', err);
  setStatus(`Error: ${err}`);
});
