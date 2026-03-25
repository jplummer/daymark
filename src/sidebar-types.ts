export interface TreeNode {
  name: string;
  title: string;
  relPath: string;
  isDir: boolean;
  children?: TreeNode[];
}

/** Virtual "Recent" folder in the sidebar (not a filesystem path). */
export const RECENT_FOLDER_KEY = '__recent__';
