import eslint from '@eslint/js';
import markdown from '@eslint/markdown';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

const codeFiles = ['**/*.{js,mjs,cjs}'];

export default [
  {
    ignores: [
      '**/node_modules/**',
      // Agent-owned linked worktrees are full repository copies. ESLint does
      // not read ignore files, so without these entries `eslint .` in the main
      // checkout would lint every worktree too.
      '.claude/worktrees/**',
      '.codex/worktrees/**',
      '**/*.local.md',
      'coverage/**',
      // release-please writes the changelogs.
      '**/CHANGELOG.md',
    ],
  },
  {
    ...eslint.configs.recommended,
    files: codeFiles,
    languageOptions: { globals: globals.node },
  },
  // eslint-config-prettier only turns code rules off, so it stays on code
  // files and never reaches Markdown.
  { ...prettier, files: codeFiles },
  // Markdown uses the plugin's recommended rules with the GitHub-Flavored
  // parser, so tables are parsed as tables. These rules report problems such
  // as broken links and wrong table column counts; they never reformat text.
  ...markdown.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.md'],
    language: 'markdown/gfm',
    languageOptions: { frontmatter: 'yaml' },
  })),
];
