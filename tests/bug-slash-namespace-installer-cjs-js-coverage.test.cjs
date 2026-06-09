/**
 * Regression test for slash-namespace install-time coverage gap (.cjs/.js).
 *
 * Symptom: a user in Claude Code copies a slash command suggested by GSD
 * output and hits `Unknown command: /gsd:<cmd>. Did you mean /gsd-<cmd>?
 * Args from unknown skill: <args>`. Identical symptom previously reported
 * upstream as open-gsd/gsd-core#215.
 *
 * Mechanism: source files use the colon form `/gsd:<cmd>` (canonical per
 * #3443). Sibling fixes #3629, #3680, and #3685 normalize that colon form
 * back to the hyphen form (`/gsd-<cmd>`) at install time so the installed
 * commands match the flat skill registration users actually invoke in
 * `~/.claude/skills/gsd-<cmd>/`.
 *
 *   - #3629: SKILL.md bodies
 *   - #3680: agent bodies
 *   - #3685: command / workflow / reference / template bodies
 *
 * Gap closed by THIS fix: the same normalization for installed `.cjs` and
 * `.js` files. Concretely:
 *
 *   - `~/.claude/get-shit-done/bin/lib/*.cjs` previously carried colon
 *     refs in JS comments. Not directly user-visible at runtime, but they
 *     leak into LLM context when sub-agents (gsd-code-reviewer,
 *     gsd-debugger) read bin/lib source while investigating gsd-tools.
 *   - `~/.claude/hooks/gsd-statusline.js`, `~/.claude/hooks/gsd-update-banner.js`,
 *     `~/.claude/hooks/gsd-workflow-guard.js` previously emitted USER-
 *     FACING strings containing colon-form commands (statusline update
 *     prompts like "⬆ /gsd:update", update-banner system messages, and
 *     workflow-guard hints like "Consider using /gsd:fast"). These are
 *     the actual surface a user copies and runs — the rest of the bug.
 *
 * Both surfaces are now normalized for hyphen-name runtimes (claude /
 * qwen / hermes per HYPHEN_NAME_AGENT_RUNTIMES). Self-converting runtimes
 * (cursor / windsurf / trae / codex / etc.) and colon-canonical runtimes
 * (gemini) are intentionally not affected.
 *
 * This test enforces the invariant for Claude Code as the primary
 * hyphen-name runtime; the same fix transparently covers Qwen and Hermes
 * because the install code path is shared.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const INSTALL_SRC = path.join(REPO_ROOT, 'bin', 'install.js');
const BUILD_HOOKS = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');
const { install } = require(INSTALL_SRC);
const { cleanup } = require('./helpers.cjs');

// Files that intentionally retain colon-form references and are exempt
// from the invariant. Keep this list minimal and explicit so an unexpected
// new exemption surfaces as a test failure rather than a silent regression.
const EXEMPT_BASENAMES = new Set([
  'CHANGELOG.md', // historical entries name commands under their original forms
]);

// build-hooks.js must populate hooks/dist/ before install() can stage
// hooks. Other install tests trigger this in their own before() — match
// that pattern so this test is order-independent under --test-concurrency.
before(() => {
  execFileSync(process.execPath, [BUILD_HOOKS], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
});

function findColonFormViolations(rootDir) {
  // Matches `/gsd:<name>` where `<name>` starts with a lowercase letter and
  // contains lowercase letters / digits / hyphens. The leading `/` is what
  // makes this a USER-TYPED slash command — internal `Skill(skill="gsd:<cmd>")`
  // invocations have no leading slash and are intentionally untouched.
  const pattern = /\/gsd:[a-z][a-z0-9-]*/g;
  const violations = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (EXEMPT_BASENAMES.has(entry.name)) continue;
      const ext = path.extname(entry.name);
      // The fix targets the .cjs/.js and .md surfaces that ship into the
      // user's runtime directory. Skip binary / non-text extensions.
      if (!['.cjs', '.js', '.md', '.sh', '.toml', '.json'].includes(ext)) continue;
      let content;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const matches = content.match(pattern);
      if (matches && matches.length > 0) {
        violations.push({
          file: path.relative(rootDir, full),
          count: matches.length,
          sample: matches.slice(0, 3),
        });
      }
    }
  }

  walk(rootDir);
  return violations;
}

describe('installer normalizes /gsd:<cmd> -> /gsd-<cmd> in .cjs/.js for hyphen-name runtimes', () => {
  let tmpDir;
  let origCwd;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-slash-cjs-install-'));
  });

  afterEach(() => {
    try {
      process.chdir(origCwd);
    } catch { /* origCwd may have been deleted by another test */ }
    cleanup(tmpDir);
  });

  test('fresh global Claude install has zero /gsd:<cmd> refs outside CHANGELOG', () => {
    // install() reads --config-dir via the GSD_INSTALL_CONFIG_DIR env so we
    // don't have to spawn a child process — call it directly.
    const prevClaude = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    try {
      install(true, 'claude');
    } finally {
      if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    }

    const violations = findColonFormViolations(tmpDir);
    assert.deepStrictEqual(
      violations,
      [],
      `Installed Claude tree contains /gsd:<cmd> refs that Claude Code cannot resolve:\n` +
      violations.slice(0, 8).map(v => `  ${v.file} (${v.count}x): ${v.sample.join(', ')}`).join('\n') +
      (violations.length > 8 ? `\n  ... and ${violations.length - 8} more files` : ''),
    );
  });

  test('hooks/gsd-statusline.js emits hyphen-form /gsd-update for Claude install', () => {
    const prevClaude = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    try {
      install(true, 'claude');
    } finally {
      if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    }

    const statusline = path.join(tmpDir, 'hooks', 'gsd-statusline.js');
    assert.ok(
      fs.existsSync(statusline),
      'gsd-statusline.js must be installed for Claude (it is the surface that emits the update prompt user-facing string)',
    );
    const content = fs.readFileSync(statusline, 'utf8');
    assert.ok(
      !/\/gsd:update\b/.test(content),
      'gsd-statusline.js must not emit /gsd:update — Claude Code resolves the user-typed slash command via the flat ~/.claude/skills/gsd-update/ directory (hyphen form)',
    );
    assert.ok(
      /\/gsd-update\b/.test(content),
      'gsd-statusline.js should still reference the update command in hyphen form so the statusline prompt is copy-pastable',
    );
  });

  test('get-shit-done/bin/lib/*.cjs has no /gsd:<cmd> refs in installed copy', () => {
    const prevClaude = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    try {
      install(true, 'claude');
    } finally {
      if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    }

    const binLib = path.join(tmpDir, 'get-shit-done', 'bin', 'lib');
    assert.ok(fs.existsSync(binLib), 'bin/lib/ must be installed under get-shit-done/');
    const violations = findColonFormViolations(binLib);
    assert.deepStrictEqual(
      violations,
      [],
      `Installed bin/lib/ contains /gsd:<cmd> refs that leak into LLM context when ` +
      `sub-agents read gsd-tools source:\n` +
      violations.map(v => `  ${v.file} (${v.count}x): ${v.sample.join(', ')}`).join('\n'),
    );
  });
});
