import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, KeyBinding } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, deleteCharBackward } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
  bracketMatching,
} from '@codemirror/language';
import { readTextFile, writeTextFile, readDir, BaseDirectory } from '@tauri-apps/plugin-fs';
import { openUrl } from '@tauri-apps/plugin-opener';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { autocompletion } from '@codemirror/autocomplete';
import { livePreview } from './live-preview';
import {
  initSidebar,
  setActiveTreeItem,
  refreshSidebar,
  recordRecentNote,
  renderMentionsSidebar,
  refreshMentionsSidebar,
  renderHashtagsSidebar,
  refreshHashtagsSidebar,
  TreeNode,
} from './sidebar';
import { noteIndex, SearchResult } from './note-index';
import { wikiLinkCompletion, mentionCompletion, hashtagCompletion } from './completions';
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

type NavEntry =
  | { kind: 'note'; note: NoteLocation }
  | { kind: 'search'; term: string };

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
let lastSavedContent: string | null = null; // Content as last written by us

const navHistory: NavEntry[] = [];
let navIndex = -1;

// Polling intervals for external change detection
let notePollInterval: ReturnType<typeof setInterval> | null = null;
let dirPollInterval: ReturnType<typeof setInterval> | null = null;
let lastDirSnapshot: string | null = null;

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
      lastSavedContent = content;
      isDirty = false;
      noteIndex.updateEntry(currentNote.relPath, content);
      refreshMentionsSidebar();
      refreshHashtagsSidebar();
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
      const content = view.state.doc.toString();
      await writeTextFile(currentNote.relPath, content, { baseDir: BaseDirectory.Home });
      lastSavedContent = content;
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

function navigateToEntry(entry: NavEntry) {
  if (entry.kind === 'search') {
    showTagSearch(entry.term, false);
  } else {
    navigateTo(entry.note, false);
  }
}

function goBack(): boolean {
  if (navIndex > 0) {
    navIndex--;
    navigateToEntry(navHistory[navIndex]);
    return true;
  }
  return false;
}

function goForward(): boolean {
  if (navIndex < navHistory.length - 1) {
    navIndex++;
    navigateToEntry(navHistory[navIndex]);
    return true;
  }
  return false;
}

const navKeymap: KeyBinding[] = [
  { key: 'Mod-[', run: () => goBack() },
  { key: 'Mod-]', run: () => goForward() },
];

// --- External link click handler ---

function findLinkHref(el: HTMLElement | null): string | null {
  while (el && el.classList) {
    if (el.dataset.href) return el.dataset.href;
    if (el.classList.contains('cm-line')) return null;
    el = el.parentElement;
  }
  return null;
}

const linkClickHandler = EditorView.domEventHandlers({
  // Must be mousedown, not click — CM6 moves the cursor on mousedown,
  // which rebuilds decorations and removes the link span before click fires.
  mousedown(event: MouseEvent, _view: EditorView) {
    if (event.button !== 0 || event.ctrlKey) return false;
    const target = event.target as HTMLElement;
    if (!target) return false;

    // External links
    const isExtLink = target.closest('.cm-live-preview-extlink, .cm-live-preview-extlink-arrow');
    if (isExtLink) {
      const href = findLinkHref(isExtLink as HTMLElement);
      if (href) {
        event.preventDefault();
        openUrl(href).catch((err) => console.error('[daymark] Failed to open URL:', err));
        return true;
      }
      return false;
    }

    // Wiki-links
    const isWikiLink = target.closest('.cm-live-preview-wikilink') as HTMLElement | null;
    if (isWikiLink) {
      const linkTarget = isWikiLink.dataset.link;
      if (linkTarget) {
        event.preventDefault();
        navigateToWikiLink(linkTarget);
        return true;
      }
      return false;
    }

    // @mentions
    const isMention = target.closest('.cm-live-preview-mention') as HTMLElement | null;
    if (isMention) {
      const mention = isMention.dataset.mention;
      if (mention) {
        event.preventDefault();
        showTagSearch(mention);
        return true;
      }
      return false;
    }

    // #hashtags
    const isHashtag = target.closest('.cm-live-preview-hashtag') as HTMLElement | null;
    if (isHashtag) {
      const hashtag = isHashtag.dataset.hashtag;
      if (hashtag) {
        event.preventDefault();
        showTagSearch(hashtag);
        return true;
      }
      return false;
    }

    return false;
  },
});

async function navigateToWikiLink(title: string) {
  const entry = noteIndex.resolveLink(title);
  if (entry) {
    navigateTo({
      type: 'project',
      relPath: entry.relPath,
      displayName: entry.title,
    });
  } else {
    // Create new note in Notes/ root
    const newPath = noteIndex.newNotePath(title);
    const content = `# ${title}\n`;
    try {
      await writeTextFile(newPath, content, { baseDir: BaseDirectory.Home });
      navigateTo({
        type: 'project',
        relPath: newPath,
        displayName: title,
      });
      noteIndex.addEntry(newPath, `${title}.txt`, content);
      refreshSidebar();
    } catch (err) {
      console.error('[daymark] Failed to create note:', err);
      setStatus(`Failed to create note: ${err}`);
    }
  }
}

// --- Paste URL → auto-fetch title ---

const URL_RE = /^https?:\/\/\S+$/;

async function fetchPageTitle(url: string): Promise<string> {
  try {
    const resp = await tauriFetch(url, {
      method: 'GET',
      headers: { 'Accept': 'text/html' },
    });
    // Read only enough to find <title> — limit to first 10 KB
    const html = (await resp.text()).slice(0, 10_000);
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) return titleMatch[1].trim();
  } catch (err) {
    console.warn('[daymark] Title fetch failed:', url, err);
  }
  // Fallback: use the domain name
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Link';
  }
}

const pasteUrlHandler = EditorView.domEventHandlers({
  paste(event: ClipboardEvent, editorView: EditorView) {
    const text = event.clipboardData?.getData('text/plain')?.trim();
    if (!text || !URL_RE.test(text)) return false;

    event.preventDefault();

    const placeholder = 'Fetching title…';
    const from = editorView.state.selection.main.head;
    const insertion = `[${placeholder}](${text})`;

    editorView.dispatch({
      changes: { from, insert: insertion },
      selection: { anchor: from + insertion.length },
    });

    // Async: replace placeholder with actual title
    const titleFrom = from + 1; // after [
    const titleTo = titleFrom + placeholder.length;

    fetchPageTitle(text).then((title) => {
      // Verify the placeholder is still there (user might have edited)
      const currentText = editorView.state.sliceDoc(titleFrom, titleTo);
      if (currentText !== placeholder) return;

      editorView.dispatch({
        changes: { from: titleFrom, to: titleTo, insert: title },
      });
    });

    return true;
  },
});

// --- Tag search (shared by @mentions and #hashtags) ---

let searchActive = false;
let hideDoneInSearch = true;
let showArchivedInSearch = false;

function searchFnForTerm(term: string): Promise<SearchResult[]> {
  if (term.startsWith('#')) return noteIndex.searchHashtag(term);
  return noteIndex.searchMention(term);
}

function showTagSearch(term: string, addToHistory = true) {
  const container = document.getElementById('search-results')!;
  const editorEl = document.getElementById('editor')!;
  const backlinksPanel = document.getElementById('backlinks-panel');

  container.textContent = '';
  container.classList.remove('hidden');
  editorEl.style.display = 'none';
  if (backlinksPanel) backlinksPanel.classList.add('hidden');
  searchActive = true;

  if (addToHistory) {
    navHistory.splice(navIndex + 1);
    navHistory.push({ kind: 'search', term });
    navIndex = navHistory.length - 1;
  }
  updateHistoryButtons();

  // Header
  const header = document.createElement('div');
  header.className = 'search-header';

  const title = document.createElement('span');
  title.className = 'search-header-mention';
  title.textContent = term;

  const countEl = document.createElement('span');
  countEl.className = 'search-header-count';
  countEl.textContent = 'Searching…';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'search-header-close';
  closeBtn.title = 'Close search (Esc)';
  closeBtn.innerHTML = '<i class="ri-close-line"></i>';
  closeBtn.addEventListener('click', closeSearch);

  header.appendChild(title);
  header.appendChild(countEl);
  header.appendChild(closeBtn);
  container.appendChild(header);

  // Filter bar (populated after results load)
  const filterBar = document.createElement('div');
  filterBar.className = 'search-filter-bar';
  container.appendChild(filterBar);

  // Results area
  const resultsArea = document.createElement('div');
  resultsArea.className = 'search-results-area';
  container.appendChild(resultsArea);

  searchFnForTerm(term).then((results) => {
    // Separate active vs archived, deduplicate archived copies
    const activeResults = results.filter((r) => !r.entry.isArchived);
    const activeFilenames = new Set(activeResults.map((r) => r.entry.filename));
    const archivedResults = results
      .filter((r) => r.entry.isArchived)
      .filter((r) => !activeFilenames.has(r.entry.filename));

    const hasDone = results.some((r) => r.lines.some((l) => l.isDone));
    const hasArchived = archivedResults.length > 0;

    // Build filter bar
    filterBar.textContent = '';
    if (hasDone) {
      const doneToggle = document.createElement('button');
      doneToggle.className = `search-filter-toggle${hideDoneInSearch ? '' : ' active'}`;
      doneToggle.textContent = hideDoneInSearch ? 'Show done' : 'Hide done';
      doneToggle.addEventListener('click', () => {
        hideDoneInSearch = !hideDoneInSearch;
        showTagSearch(term, false);
      });
      filterBar.appendChild(doneToggle);
    }
    if (hasArchived) {
      const archiveToggle = document.createElement('button');
      archiveToggle.className = `search-filter-toggle${showArchivedInSearch ? ' active' : ''}`;
      archiveToggle.textContent = showArchivedInSearch ? 'Hide archived' : 'Show archived';
      archiveToggle.addEventListener('click', () => {
        showArchivedInSearch = !showArchivedInSearch;
        showTagSearch(term, false);
      });
      filterBar.appendChild(archiveToggle);
    }
    if (!hasDone && !hasArchived) {
      filterBar.style.display = 'none';
    }

    const visibleResults = showArchivedInSearch
      ? [...activeResults, ...archivedResults]
      : activeResults;

    renderSearchResults(resultsArea, visibleResults, countEl, archivedResults.length);
  });
}

function renderSearchResults(
  container: HTMLElement,
  results: SearchResult[],
  countEl: HTMLElement,
  hiddenArchivedCount: number,
) {
  container.textContent = '';

  let totalLines = 0;
  let visibleLines = 0;
  let noteCount = 0;

  for (const result of results) {
    totalLines += result.lines.length;
  }

  for (const result of results) {
    const visibleForNote = hideDoneInSearch
      ? result.lines.filter((l) => !l.isDone)
      : result.lines;

    if (visibleForNote.length === 0) continue;
    visibleLines += visibleForNote.length;
    noteCount++;

    const group = document.createElement('div');
    group.className = 'search-note-group';

    const noteTitle = document.createElement('div');
    noteTitle.className = 'search-note-title';
    const archiveLabel = result.entry.isArchived ? ' <span class="search-archived-badge">archived</span>' : '';
    noteTitle.innerHTML = `<i class="ri-file-text-line"></i> ${escapeHtml(result.entry.title)}${archiveLabel}`;
    noteTitle.addEventListener('click', () => {
      closeSearch();
      navigateTo({
        type: 'project',
        relPath: result.entry.relPath,
        displayName: result.entry.title,
      });
    });
    group.appendChild(noteTitle);

    for (const line of visibleForNote) {
      const lineEl = document.createElement('div');
      lineEl.className = `search-line${line.isDone ? ' done' : ''}`;
      lineEl.textContent = line.text.trim();
      lineEl.addEventListener('click', () => {
        closeSearch();
        navigateTo({
          type: 'project',
          relPath: result.entry.relPath,
          displayName: result.entry.title,
        }, true, line.lineNum);
      });
      group.appendChild(lineEl);
    }

    container.appendChild(group);
  }

  // Status line
  const parts: string[] = [];
  parts.push(`${visibleLines} result${visibleLines === 1 ? '' : 's'} in ${noteCount} note${noteCount === 1 ? '' : 's'}`);
  const doneHidden = totalLines - visibleLines;
  if (doneHidden > 0 && hideDoneInSearch) parts.push(`${doneHidden} done hidden`);
  if (hiddenArchivedCount > 0 && !showArchivedInSearch) parts.push(`${hiddenArchivedCount} archived note${hiddenArchivedCount === 1 ? '' : 's'} hidden`);
  countEl.textContent = parts.join(' · ');

  if (visibleLines === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    const reasons: string[] = [];
    if (totalLines > 0 && hideDoneInSearch) reasons.push('done tasks are hidden');
    if (hiddenArchivedCount > 0 && !showArchivedInSearch) reasons.push('archived notes are hidden');
    if (reasons.length > 0) {
      empty.textContent = `No visible results — ${reasons.join(' and ')}.`;
    } else {
      empty.textContent = 'No results found.';
    }
    container.appendChild(empty);
  }
}

function closeSearch() {
  const container = document.getElementById('search-results')!;
  const editorEl = document.getElementById('editor')!;
  container.classList.add('hidden');
  container.textContent = '';
  editorEl.style.display = '';
  searchActive = false;
  updateHistoryButtons();
  view?.focus();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Editor extensions ---
// Set to true to test whether the task-line backspace bug is from live-preview or elsewhere.
const DISABLE_LIVE_PREVIEW = false;

// When cursor is at end of a line that is only a task marker (e.g. "- [ ]" or "- [ ] "), lang-markdown's
// deleteMarkupBackward deletes the whole line. Run default backward delete so one character is removed.
const TASK_MARKER_ONLY = /^[-+] \[[ x]\]\s*$/;
function backspaceTaskMarkerAware(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  if (state.selection.main.empty && pos === line.to && TASK_MARKER_ONLY.test(line.text)) {
    return deleteCharBackward(view);
  }
  return false;
}

const editorExtensions = [
  highlightActiveLine(),
  indentOnInput(),
  indentUnit.of('\t'),
  bracketMatching(),
  history(),
  keymap.of([...navKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap]),
  Prec.highest(keymap.of([{ key: 'Backspace', run: backspaceTaskMarkerAware }])),
  markdown({ base: markdownLanguage, codeLanguages: languages }),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      scheduleSave();
      setStatus('Editing…');
    }
  }),
  EditorView.lineWrapping,
  autocompletion({
    override: [wikiLinkCompletion, mentionCompletion, hashtagCompletion],
    activateOnTyping: true,
  }),
  ...(DISABLE_LIVE_PREVIEW ? [] : [livePreview]),
  linkClickHandler,
  pasteUrlHandler,
];

// --- Polling for external changes ---

function pollCurrentNote(relPath: string) {
  if (notePollInterval) clearInterval(notePollInterval);

  notePollInterval = setInterval(async () => {
    if (currentNote?.relPath !== relPath || !view) return;
    if (isDirty) return; // Don't clobber unsaved local edits

    try {
      const diskContent = await readTextFile(relPath, { baseDir: BaseDirectory.Home });

      // Skip if this matches what we last wrote
      if (diskContent === lastSavedContent) return;

      const editorContent = view.state.doc.toString();
      if (diskContent === editorContent) return;

      const cursorPos = view.state.selection.main.head;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: diskContent },
        selection: { anchor: Math.min(cursorPos, diskContent.length) },
      });
      lastSavedContent = diskContent;
      setStatus('Reloaded (external change)');
      setTimeout(() => setStatus(''), 2000);
    } catch {
      // File might not exist yet — ignore
    }
  }, 2000);
}

async function getDirSnapshot(): Promise<string> {
  const notesPath = `${NOTEPLAN_BASE}/Notes`;
  try {
    const entries = await readDir(notesPath, { baseDir: BaseDirectory.Home });
    return entries.map((e) => `${e.name}:${e.isDirectory}`).sort().join('\n');
  } catch {
    return '';
  }
}

async function pollNotesDirectory() {
  if (dirPollInterval) clearInterval(dirPollInterval);

  lastDirSnapshot = await getDirSnapshot();

  dirPollInterval = setInterval(async () => {
    try {
      const snapshot = await getDirSnapshot();
      if (snapshot !== lastDirSnapshot) {
        lastDirSnapshot = snapshot;
        await noteIndex.build();
        refreshSidebar();
        refreshMentionsSidebar();
        refreshHashtagsSidebar();
      }
    } catch {
      // Ignore transient read errors
    }
  }, 5000);
}

// --- Navigation ---

let pendingScrollRAF: number | null = null;

async function navigateTo(note: NoteLocation, addToHistory = true, targetLine?: number) {
  // Cancel any stale scroll from a previous navigation
  if (pendingScrollRAF !== null) {
    cancelAnimationFrame(pendingScrollRAF);
    pendingScrollRAF = null;
  }

  // If we're leaving a search view to go to a note, close the search UI
  if (searchActive) {
    const container = document.getElementById('search-results')!;
    const editorEl = document.getElementById('editor')!;
    container.classList.add('hidden');
    container.textContent = '';
    editorEl.style.display = '';
    searchActive = false;
  }

  await flushSave();

  currentNote = note;

  if (addToHistory) {
    navHistory.splice(navIndex + 1);
    navHistory.push({ kind: 'note', note });
    navIndex = navHistory.length - 1;
  }

  updateToolbar(note);
  setActiveTreeItem(note.relPath);
  recordRecentNote(note.relPath);

  const content = await loadFile(note.relPath);
  lastSavedContent = content;

  if (view) {
    view.setState(EditorState.create({ doc: content, extensions: editorExtensions }));
  } else {
    const state = EditorState.create({ doc: content, extensions: editorExtensions });
    view = new EditorView({
      state,
      parent: document.getElementById('editor')!,
    });
  }

  if (targetLine && targetLine > 0 && targetLine <= view.state.doc.lines) {
    const v = view;
    pendingScrollRAF = requestAnimationFrame(() => {
      pendingScrollRAF = null;
      const line = v.state.doc.line(targetLine);
      v.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      });
    });
  }

  pollCurrentNote(note.relPath);
  updateBacklinksPanel(note.relPath);
  setStatus('');
  view.focus();
}

function updateBacklinksPanel(relPath: string) {
  if (searchActive) return;
  const panel = document.getElementById('backlinks-panel');
  const list = document.getElementById('backlinks-list');
  const title = document.getElementById('backlinks-title');
  if (!panel || !list || !title) return;

  const backlinks = noteIndex.getBacklinks(relPath);

  list.textContent = '';

  if (backlinks.length === 0) {
    title.textContent = 'No backlinks';
    panel.classList.remove('open');
    panel.classList.add('no-backlinks');
  } else {
    title.textContent = `Backlinks (${backlinks.length})`;
    panel.classList.remove('no-backlinks');
    for (const entry of backlinks) {
      const item = document.createElement('div');
      item.className = 'backlink-item';

      const icon = document.createElement('i');
      icon.className = 'ri-link';

      const label = document.createElement('span');
      label.textContent = entry.title;

      item.appendChild(icon);
      item.appendChild(label);
      item.addEventListener('click', () => {
        navigateTo({
          type: 'project',
          relPath: entry.relPath,
          displayName: entry.title,
        });
      });
      list.appendChild(item);
    }
  }

  panel.classList.remove('hidden');
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

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.metaKey && e.key === '[') { e.preventDefault(); goBack(); }
    if (e.metaKey && e.key === ']') { e.preventDefault(); goForward(); }
    if (e.key === 'Escape' && searchActive) { e.preventDefault(); closeSearch(); }
  });
}

function wireBacklinksPanel() {
  const header = document.getElementById('backlinks-header');
  const panel = document.getElementById('backlinks-panel');
  if (header && panel) {
    header.addEventListener('click', () => {
      if (!panel.classList.contains('no-backlinks')) {
        panel.classList.toggle('open');
      }
    });
  }
}

async function init() {
  wireNavButtons();
  wireResizeHandle();
  wireBacklinksPanel();

  const sidebarReady = initSidebar((node: TreeNode) => {
    navigateTo(projectNote(node));
  });

  // Build note index in parallel with first navigation
  const indexReady = noteIndex.build();

  await navigateTo(dailyNote(new Date()));
  await sidebarReady;
  await indexReady;

  // Re-render backlinks now that index is ready (initial navigateTo ran before index finished)
  if (currentNote) updateBacklinksPanel(currentNote.relPath);

  // Build mentions sidebar now that index is ready
  renderMentionsSidebar((mention) => showTagSearch(mention));
  renderHashtagsSidebar((hashtag) => showTagSearch(hashtag));

  pollNotesDirectory();
}

init().catch((err) => {
  console.error('[daymark] Init failed:', err);
  setStatus(`Error: ${err}`);
});
