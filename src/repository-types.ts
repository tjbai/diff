export interface RepoSnapshot {
  repo: string;
  /** The branch name, or the full commit ID when the URL pinned a commit. */
  branch: string;
  defaultBranch: string;
  private: boolean;
  sha: string;
  tree: string;
  message: string;
  author: string;
  authorAvatar: string;
  date: string;
  /** The path that followed the branch name in the URL. */
  path: string;
  root: RepoTree;
}

export interface RepoEntry {
  path: string;
  type: 'tree' | 'blob' | 'commit';
  mode: string;
  sha: string;
  size?: number;
}

export interface RepoTree {
  entries: RepoEntry[];
  truncated: boolean;
}

export interface RepoPaths {
  paths: string[];
  truncated: boolean;
}

export interface RepoBranches {
  names: string[];
  cursor: string | null;
  more: boolean;
  total: number;
}

export interface RepoFile {
  size: number;
  binary: boolean;
  text: string | null;
  tooLarge: boolean;
  lang: string;
}

export interface RepoPull {
  number: number;
  title: string;
  author: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  /** When it was opened, or closed or merged for a closed PR. */
  at: string;
}

export interface RepoPulls {
  open: number;
  closed: number;
  pulls: RepoPull[];
  cursor: string | null;
  more: boolean;
}
