import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export interface AgentFile {
  readonly relPath: string;
  readonly absPath: string;
  readonly filenameStem: string;
  readonly content: string;
  readonly frontmatter: Map<string, string>;
}

function gitList(args: readonly string[]): string[] {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function parseFrontmatter(content: string): Map<string, string> {
  const fm = new Map<string, string>();
  if (!content.startsWith('---\n')) return fm;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return fm;
  const block = content.slice(4, end);
  for (const line of block.split('\n')) {
    const match = line.match(/^([a-z][a-z-]+):\s*(.*)$/);
    if (match && match[1] && match[2] !== undefined) {
      fm.set(match[1], match[2].trim());
    }
  }
  return fm;
}

export function listAgentMarkdownCandidates(): string[] {
  const tracked = gitList(['ls-files', '.claude/agents']);
  const untracked = gitList(['ls-files', '--others', '--exclude-standard', '.claude/agents']);
  return [...new Set([...tracked, ...untracked])]
    .filter((relPath) => relPath.endsWith('.md'))
    .filter((relPath) => !relPath.endsWith('/README.md'))
    .filter((relPath) => !relPath.endsWith('/INVOCATION-PACK.md'))
    .filter((relPath) => !relPath.includes('/_shared/'));
}

export function listActiveAgentFiles(): AgentFile[] {
  return listAgentMarkdownCandidates()
    .map((relPath) => {
      const absPath = join(REPO_ROOT, relPath);
      const content = readFileSync(absPath, 'utf8');
      const frontmatter = parseFrontmatter(content);
      return {
        relPath,
        absPath,
        filenameStem: basename(relPath, '.md'),
        content,
        frontmatter,
      };
    })
    .filter((file) => file.frontmatter.has('name'));
}
