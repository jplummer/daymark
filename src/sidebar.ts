import { readDir, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';

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
    const match = firstLines.match(/^#\s+(.+)$/m);
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

      const item = document.createElement('div');
      item.className = 'tree-item';
      item.style.paddingLeft = `${indent}px`;

      const arrow = document.createElement('i');
      arrow.className = 'ri-arrow-right-s-line tree-item-arrow';

      const icon = document.createElement('i');
      icon.className = 'ri-folder-line tree-item-icon';

      const label = document.createElement('span');
      label.className = 'tree-item-label';
      label.textContent = node.title;

      item.appendChild(arrow);
      item.appendChild(icon);
      item.appendChild(label);

      const childContainer = document.createElement('div');
      childContainer.className = 'tree-folder-children';

      item.addEventListener('click', () => {
        const isOpen = childContainer.classList.toggle('open');
        arrow.className = isOpen
          ? 'ri-arrow-down-s-line tree-item-arrow'
          : 'ri-arrow-right-s-line tree-item-arrow';
        icon.className = isOpen
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

    const iconClass = SPECIAL_FOLDER_ICONS[node.name] || 'ri-folder-line';
    const arrow = document.createElement('i');
    arrow.className = 'ri-arrow-right-s-line tree-item-arrow';

    const icon = document.createElement('i');
    icon.className = `${iconClass} tree-item-icon`;

    const label = document.createElement('span');
    label.className = 'tree-item-label';
    label.textContent = node.title;

    item.appendChild(arrow);
    item.appendChild(icon);
    item.appendChild(label);

    const childContainer = document.createElement('div');
    childContainer.className = 'tree-folder-children';

    item.addEventListener('click', () => {
      const isOpen = childContainer.classList.toggle('open');
      arrow.className = isOpen
        ? 'ri-arrow-down-s-line tree-item-arrow'
        : 'ri-arrow-right-s-line tree-item-arrow';
    });

    const wrapper = document.createElement('div');
    wrapper.className = 'tree-folder';
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

export async function initSidebar(onNavigate: (node: TreeNode) => void): Promise<void> {
  const treeContainer = document.getElementById('sidebar-tree');
  const specialContainer = document.getElementById('sidebar-special');
  if (!treeContainer) return;

  treeContainer.textContent = 'Loading…';

  try {
    const notesPath = `${NOTEPLAN_BASE}/Notes`;

    // Load main tree (excluding special folders) and special folders in parallel
    const [mainTree, allEntries] = await Promise.all([
      readTree(notesPath, true),
      readDir(notesPath, { baseDir: BaseDirectory.Home }),
    ]);

    // Build special folder nodes
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

    if (specialContainer && specialNodes.length > 0) {
      renderSpecialFolders(specialContainer, specialNodes, onNavigate);
    }
  } catch (err) {
    console.error('[daymark] Failed to load sidebar:', err);
    treeContainer.textContent = 'Failed to load notes';
  }
}
