import { readDir, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { noteIndex } from './note-index';

const NOTEPLAN_BASE = 'Library/Containers/co.noteplan.NotePlan-setapp/Data/Library/Application Support/co.noteplan.NotePlan-setapp';

// Folders that get separated to the bottom of the sidebar
const SPECIAL_FOLDERS = new Set(['@Archive', '@Templates', '@Trash']);

export interface TreeNode {
  name: string;
  title: string;
  relPath: string;
  isDir: boolean;
  children?: TreeNode[];
}

async function extractTitle(relPath: string, filename: string): Promise<string> {
  try {
    const text = await readTextFile(relPath, { baseDir: BaseDirectory.Home });
    const firstLines = text.slice(0, 500);
    const match = firstLines.match(/^\s*#\s+(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // File unreadable
  }
  return filename.replace(/\.txt$/, '');
}

async function readTree(relDir: string, excludeSpecial = false): Promise<TreeNode[]> {
  const entries = await readDir(relDir, { baseDir: BaseDirectory.Home });
  const nodes: TreeNode[] = [];

  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    if (excludeSpecial && SPECIAL_FOLDERS.has(entry.name)) continue;

    const childPath = `${relDir}/${entry.name}`;

    if (entry.isDirectory) {
      const children = await readTree(childPath);
      nodes.push({
        name: entry.name,
        title: entry.name.replace(/^@/, ''),
        relPath: childPath,
        isDir: true,
        children,
      });
    } else if (entry.name.endsWith('.txt')) {
      const title = await extractTitle(childPath, entry.name);
      nodes.push({
        name: entry.name,
        title,
        relPath: childPath,
        isDir: false,
      });
    }
  }

  return nodes;
}

// Icon mappings for special folders
const SPECIAL_FOLDER_ICONS: Record<string, string> = {
  '@Archive': 'ri-archive-line',
  '@Templates': 'ri-file-list-line',
  '@Trash': 'ri-delete-bin-line',
};

function renderTree(
  container: HTMLElement,
  nodes: TreeNode[],
  depth: number,
  onNavigate: (node: TreeNode) => void,
): void {
  for (const node of nodes) {
    const indent = 12 + depth * 18;

    if (node.isDir) {
      const folder = document.createElement('div');
      folder.className = 'tree-folder';
      folder.dataset.folderPath = node.relPath;

      const item = document.createElement('div');
      item.className = 'tree-item';
      item.style.paddingLeft = `${indent}px`;

      const isOpen = openFolders.has(node.relPath);

      const arrow = document.createElement('i');
      arrow.className = isOpen
        ? 'ri-arrow-down-s-line tree-item-arrow'
        : 'ri-arrow-right-s-line tree-item-arrow';

      const icon = document.createElement('i');
      icon.className = isOpen
        ? 'ri-folder-open-line tree-item-icon'
        : 'ri-folder-line tree-item-icon';

      const label = document.createElement('span');
      label.className = 'tree-item-label';
      label.textContent = node.title;

      item.appendChild(arrow);
      item.appendChild(icon);
      item.appendChild(label);

      const childContainer = document.createElement('div');
      childContainer.className = `tree-folder-children${isOpen ? ' open' : ''}`;

      item.addEventListener('click', () => {
        const nowOpen = childContainer.classList.toggle('open');
        if (nowOpen) {
          openFolders.add(node.relPath);
        } else {
          openFolders.delete(node.relPath);
        }
        arrow.className = nowOpen
          ? 'ri-arrow-down-s-line tree-item-arrow'
          : 'ri-arrow-right-s-line tree-item-arrow';
        icon.className = nowOpen
          ? 'ri-folder-open-line tree-item-icon'
          : 'ri-folder-line tree-item-icon';
      });

      folder.appendChild(item);
      folder.appendChild(childContainer);
      container.appendChild(folder);

      if (node.children) {
        renderTree(childContainer, node.children, depth + 1, onNavigate);
      }
    } else {
      const item = document.createElement('div');
      item.className = 'tree-item';
      // Indent files to align with folder labels (skip the arrow width)
      item.style.paddingLeft = `${indent}px`;
      item.dataset.relPath = node.relPath;

      const spacer = document.createElement('span');
      spacer.className = 'tree-item-arrow-spacer';

      const icon = document.createElement('i');
      icon.className = 'ri-file-text-line tree-item-icon';

      const label = document.createElement('span');
      label.className = 'tree-item-label';
      label.textContent = node.title;

      item.appendChild(spacer);
      item.appendChild(icon);
      item.appendChild(label);

      item.addEventListener('click', () => onNavigate(node));
      container.appendChild(item);
    }
  }
}

function renderSpecialFolders(
  container: HTMLElement,
  specialNodes: TreeNode[],
  onNavigate: (node: TreeNode) => void,
): void {
  for (const node of specialNodes) {
    const item = document.createElement('div');
    item.className = 'tree-item special-folder';
    item.style.paddingLeft = '12px';

    const isOpen = openFolders.has(node.relPath);

    const iconClass = SPECIAL_FOLDER_ICONS[node.name] || 'ri-folder-line';
    const arrow = document.createElement('i');
    arrow.className = isOpen
      ? 'ri-arrow-down-s-line tree-item-arrow'
      : 'ri-arrow-right-s-line tree-item-arrow';

    const icon = document.createElement('i');
    icon.className = `${iconClass} tree-item-icon`;

    const label = document.createElement('span');
    label.className = 'tree-item-label';
    label.textContent = node.title;

    item.appendChild(arrow);
    item.appendChild(icon);
    item.appendChild(label);

    const childContainer = document.createElement('div');
    childContainer.className = `tree-folder-children${isOpen ? ' open' : ''}`;

    item.addEventListener('click', () => {
      const nowOpen = childContainer.classList.toggle('open');
      if (nowOpen) {
        openFolders.add(node.relPath);
      } else {
        openFolders.delete(node.relPath);
      }
      arrow.className = nowOpen
        ? 'ri-arrow-down-s-line tree-item-arrow'
        : 'ri-arrow-right-s-line tree-item-arrow';
    });

    const wrapper = document.createElement('div');
    wrapper.className = 'tree-folder';
    wrapper.dataset.folderPath = node.relPath;
    wrapper.appendChild(item);
    wrapper.appendChild(childContainer);
    container.appendChild(wrapper);

    if (node.children) {
      renderTree(childContainer, node.children, 1, onNavigate);
    }
  }
}

export function setActiveTreeItem(relPath: string): void {
  document.querySelectorAll('#sidebar-tree .tree-item.active, #sidebar-special .tree-item.active').forEach((el) => {
    el.classList.remove('active');
  });
  const selector = `.tree-item[data-rel-path="${CSS.escape(relPath)}"]`;
  const item = document.querySelector(selector);
  if (item) item.classList.add('active');
}

// Persistent state across refreshes
let sidebarNavigateCallback: ((node: TreeNode) => void) | null = null;
const openFolders = new Set<string>();

async function buildSidebar(onNavigate: (node: TreeNode) => void): Promise<void> {
  const treeContainer = document.getElementById('sidebar-tree');
  const specialContainer = document.getElementById('sidebar-special');
  if (!treeContainer) return;

  const notesPath = `${NOTEPLAN_BASE}/Notes`;

  const [mainTree, allEntries] = await Promise.all([
    readTree(notesPath, true),
    readDir(notesPath, { baseDir: BaseDirectory.Home }),
  ]);

  const specialEntries = allEntries.filter((e) => e.isDirectory && SPECIAL_FOLDERS.has(e.name));
  const specialNodes: TreeNode[] = [];
  for (const entry of specialEntries) {
    const childPath = `${notesPath}/${entry.name}`;
    const children = await readTree(childPath);
    specialNodes.push({
      name: entry.name,
      title: entry.name.replace(/^@/, ''),
      relPath: childPath,
      isDir: true,
      children,
    });
  }

  treeContainer.textContent = '';
  renderTree(treeContainer, mainTree, 0, onNavigate);

  if (specialContainer) {
    specialContainer.textContent = '';
    if (specialNodes.length > 0) {
      renderSpecialFolders(specialContainer, specialNodes, onNavigate);
    }
  }
}

export async function initSidebar(onNavigate: (node: TreeNode) => void): Promise<void> {
  sidebarNavigateCallback = onNavigate;
  const treeContainer = document.getElementById('sidebar-tree');
  if (!treeContainer) return;

  treeContainer.textContent = 'Loading…';

  try {
    await buildSidebar(onNavigate);
  } catch (err) {
    console.error('[daymark] Failed to load sidebar:', err);
    treeContainer.textContent = 'Failed to load notes';
  }
}

export async function refreshSidebar(): Promise<void> {
  if (!sidebarNavigateCallback) return;

  const scrollEl = document.getElementById('sidebar-scroll');
  const scrollTop = scrollEl?.scrollTop ?? 0;

  try {
    await buildSidebar(sidebarNavigateCallback);
  } catch (err) {
    console.error('[daymark] Failed to refresh sidebar:', err);
  }

  if (scrollEl) scrollEl.scrollTop = scrollTop;
}

// --- @Mentions sidebar section ---

let mentionClickCallback: ((mention: string) => void) | null = null;
const mentionSectionOpen = { value: true };
const openMentionGroups = new Set<string>();

interface MentionItem {
  mention: string;
  count: number;
  archiveOnly: boolean;
}

interface MentionGroup {
  prefix: string;
  label: string;
  mentions: MentionItem[];
}

function groupMentions(ranked: MentionItem[]): MentionGroup[] {
  const groups = new Map<string, MentionGroup>();

  for (const item of ranked) {
    const name = item.mention.slice(1); // strip @
    const slashIdx = name.indexOf('/');
    let prefix = '';
    if (slashIdx > 0) {
      prefix = name.slice(0, slashIdx);
    }

    let group = groups.get(prefix);
    if (!group) {
      group = {
        prefix,
        label: prefix,
        mentions: [],
      };
      groups.set(prefix, group);
    }
    group.mentions.push(item);
  }

  // Prefixed groups (folders) first alphabetically, then unprefixed mentions
  return [...groups.values()].sort((a, b) => {
    if (a.prefix !== '' && b.prefix === '') return -1;
    if (a.prefix === '' && b.prefix !== '') return 1;
    return a.label.localeCompare(b.label);
  });
}

export function renderMentionsSidebar(onMentionClick: (mention: string) => void): void {
  mentionClickCallback = onMentionClick;
  refreshMentionsSidebar();
}

export function refreshMentionsSidebar(): void {
  const container = document.getElementById('sidebar-mentions');
  if (!container) return;

  container.textContent = '';

  const ranked = noteIndex.getMentionsRanked();
  if (ranked.length === 0) return;

  const groups = groupMentions(ranked);

  // Section header
  const sectionHeader = document.createElement('div');
  sectionHeader.className = 'tree-item sidebar-section-header';
  sectionHeader.style.paddingLeft = '12px';

  const sectionArrow = document.createElement('i');
  sectionArrow.className = mentionSectionOpen.value
    ? 'ri-arrow-down-s-line tree-item-arrow'
    : 'ri-arrow-right-s-line tree-item-arrow';

  const sectionIcon = document.createElement('i');
  sectionIcon.className = 'ri-at-line tree-item-icon';

  const sectionLabel = document.createElement('span');
  sectionLabel.className = 'tree-item-label';
  sectionLabel.textContent = 'Mentions';

  sectionHeader.appendChild(sectionArrow);
  sectionHeader.appendChild(sectionIcon);
  sectionHeader.appendChild(sectionLabel);

  const sectionBody = document.createElement('div');
  sectionBody.className = `tree-folder-children${mentionSectionOpen.value ? ' open' : ''}`;

  sectionHeader.addEventListener('click', () => {
    mentionSectionOpen.value = !mentionSectionOpen.value;
    sectionBody.classList.toggle('open', mentionSectionOpen.value);
    sectionArrow.className = mentionSectionOpen.value
      ? 'ri-arrow-down-s-line tree-item-arrow'
      : 'ri-arrow-right-s-line tree-item-arrow';
  });

  container.appendChild(sectionHeader);
  container.appendChild(sectionBody);

  for (const group of groups) {
    if (group.prefix && group.mentions.length > 0) {
      // Prefixed groups get a collapsible sub-header
      const groupHeader = document.createElement('div');
      groupHeader.className = 'tree-item mention-group-header';
      groupHeader.style.paddingLeft = '24px';

      const isGroupOpen = openMentionGroups.has(group.prefix);

      const groupArrow = document.createElement('i');
      groupArrow.className = isGroupOpen
        ? 'ri-arrow-down-s-line tree-item-arrow'
        : 'ri-arrow-right-s-line tree-item-arrow';

      const groupLabel = document.createElement('span');
      groupLabel.className = 'tree-item-label';
      groupLabel.textContent = group.label;

      groupHeader.appendChild(groupArrow);
      groupHeader.appendChild(groupLabel);

      const groupBody = document.createElement('div');
      groupBody.className = `tree-folder-children${isGroupOpen ? ' open' : ''}`;

      groupHeader.addEventListener('click', () => {
        const nowOpen = groupBody.classList.toggle('open');
        if (nowOpen) {
          openMentionGroups.add(group.prefix);
        } else {
          openMentionGroups.delete(group.prefix);
        }
        groupArrow.className = nowOpen
          ? 'ri-arrow-down-s-line tree-item-arrow'
          : 'ri-arrow-right-s-line tree-item-arrow';
      });

      sectionBody.appendChild(groupHeader);
      sectionBody.appendChild(groupBody);
      renderMentionItems(groupBody, group.mentions, 36);
    } else {
      // Unprefixed mentions go directly in the section body
      renderMentionItems(sectionBody, group.mentions, 24);
    }
  }
}

function renderMentionItems(
  container: HTMLElement,
  items: { mention: string; count: number; archiveOnly: boolean }[],
  indent: number,
): void {
  for (const item of items) {
    const dimmed = item.archiveOnly;
    const el = document.createElement('div');
    el.className = `tree-item mention-item${dimmed ? ' inactive' : ''}`;
    el.style.paddingLeft = `${indent}px`;

    const spacer = document.createElement('span');
    spacer.className = 'tree-item-arrow-spacer';

    const label = document.createElement('span');
    label.className = 'tree-item-label';
    label.textContent = item.mention;

    el.appendChild(spacer);
    el.appendChild(label);

    if (item.count > 0) {
      const badge = document.createElement('span');
      badge.className = 'mention-count';
      badge.textContent = String(item.count);
      badge.title = `${item.count} active note${item.count === 1 ? '' : 's'}`;
      el.appendChild(badge);
    } else if (item.archiveOnly) {
      const badge = document.createElement('span');
      badge.className = 'mention-count';
      badge.textContent = 'archived';
      el.appendChild(badge);
    }

    el.addEventListener('click', () => {
      if (mentionClickCallback) mentionClickCallback(item.mention);
    });

    container.appendChild(el);
  }
}

// --- #Hashtags sidebar section ---

interface HashtagItem {
  hashtag: string;
  count: number;
  archiveOnly: boolean;
}

interface HashtagGroup {
  prefix: string;
  label: string;
  items: HashtagItem[];
}

function groupHashtags(ranked: HashtagItem[]): HashtagGroup[] {
  const groups = new Map<string, HashtagGroup>();

  for (const item of ranked) {
    const name = item.hashtag.slice(1); // strip #
    const slashIdx = name.indexOf('/');
    let prefix = '';
    if (slashIdx > 0) {
      prefix = name.slice(0, slashIdx);
    }

    let group = groups.get(prefix);
    if (!group) {
      group = { prefix, label: prefix, items: [] };
      groups.set(prefix, group);
    }
    group.items.push(item);
  }

  // Prefixed groups (folders) first alphabetically, then unprefixed items
  return [...groups.values()].sort((a, b) => {
    if (a.prefix !== '' && b.prefix === '') return -1;
    if (a.prefix === '' && b.prefix !== '') return 1;
    return a.label.localeCompare(b.label);
  });
}

let hashtagClickCallback: ((hashtag: string) => void) | null = null;
const hashtagSectionOpen = { value: true };
const openHashtagGroups = new Set<string>();

export function renderHashtagsSidebar(onHashtagClick: (hashtag: string) => void): void {
  hashtagClickCallback = onHashtagClick;
  refreshHashtagsSidebar();
}

export function refreshHashtagsSidebar(): void {
  const container = document.getElementById('sidebar-hashtags');
  if (!container) return;

  container.textContent = '';

  const ranked = noteIndex.getHashtagsRanked();
  if (ranked.length === 0) return;

  // Section header
  const sectionHeader = document.createElement('div');
  sectionHeader.className = 'tree-item sidebar-section-header';
  sectionHeader.style.paddingLeft = '12px';

  const sectionArrow = document.createElement('i');
  sectionArrow.className = hashtagSectionOpen.value
    ? 'ri-arrow-down-s-line tree-item-arrow'
    : 'ri-arrow-right-s-line tree-item-arrow';

  const sectionIcon = document.createElement('i');
  sectionIcon.className = 'ri-hashtag tree-item-icon';

  const sectionLabel = document.createElement('span');
  sectionLabel.className = 'tree-item-label';
  sectionLabel.textContent = 'Hashtags';

  sectionHeader.appendChild(sectionArrow);
  sectionHeader.appendChild(sectionIcon);
  sectionHeader.appendChild(sectionLabel);

  const sectionBody = document.createElement('div');
  sectionBody.className = `tree-folder-children${hashtagSectionOpen.value ? ' open' : ''}`;

  sectionHeader.addEventListener('click', () => {
    hashtagSectionOpen.value = !hashtagSectionOpen.value;
    sectionBody.classList.toggle('open', hashtagSectionOpen.value);
    sectionArrow.className = hashtagSectionOpen.value
      ? 'ri-arrow-down-s-line tree-item-arrow'
      : 'ri-arrow-right-s-line tree-item-arrow';
  });

  container.appendChild(sectionHeader);
  container.appendChild(sectionBody);

  const groups = groupHashtags(ranked);

  for (const group of groups) {
    if (group.prefix && group.items.length > 0) {
      const groupHeader = document.createElement('div');
      groupHeader.className = 'tree-item mention-group-header';
      groupHeader.style.paddingLeft = '24px';

      const isGroupOpen = openHashtagGroups.has(group.prefix);

      const groupArrow = document.createElement('i');
      groupArrow.className = isGroupOpen
        ? 'ri-arrow-down-s-line tree-item-arrow'
        : 'ri-arrow-right-s-line tree-item-arrow';

      const groupLabel = document.createElement('span');
      groupLabel.className = 'tree-item-label';
      groupLabel.textContent = group.label;

      groupHeader.appendChild(groupArrow);
      groupHeader.appendChild(groupLabel);

      const groupBody = document.createElement('div');
      groupBody.className = `tree-folder-children${isGroupOpen ? ' open' : ''}`;

      groupHeader.addEventListener('click', () => {
        const nowOpen = groupBody.classList.toggle('open');
        if (nowOpen) {
          openHashtagGroups.add(group.prefix);
        } else {
          openHashtagGroups.delete(group.prefix);
        }
        groupArrow.className = nowOpen
          ? 'ri-arrow-down-s-line tree-item-arrow'
          : 'ri-arrow-right-s-line tree-item-arrow';
      });

      sectionBody.appendChild(groupHeader);
      sectionBody.appendChild(groupBody);
      renderHashtagItems(groupBody, group.items, 36);
    } else {
      renderHashtagItems(sectionBody, group.items, 24);
    }
  }
}

function renderHashtagItems(
  container: HTMLElement,
  items: HashtagItem[],
  indent: number,
): void {
  for (const item of items) {
    const dimmed = item.archiveOnly;
    const el = document.createElement('div');
    el.className = `tree-item mention-item${dimmed ? ' inactive' : ''}`;
    el.style.paddingLeft = `${indent}px`;

    const spacer = document.createElement('span');
    spacer.className = 'tree-item-arrow-spacer';

    const label = document.createElement('span');
    label.className = 'tree-item-label';
    label.textContent = item.hashtag;

    el.appendChild(spacer);
    el.appendChild(label);

    if (item.count > 0) {
      const badge = document.createElement('span');
      badge.className = 'mention-count';
      badge.textContent = String(item.count);
      badge.title = `${item.count} active note${item.count === 1 ? '' : 's'}`;
      el.appendChild(badge);
    } else if (item.archiveOnly) {
      const badge = document.createElement('span');
      badge.className = 'mention-count';
      badge.textContent = 'archived';
      el.appendChild(badge);
    }

    el.addEventListener('click', () => {
      if (hashtagClickCallback) hashtagClickCallback(item.hashtag);
    });

    container.appendChild(el);
  }
}
