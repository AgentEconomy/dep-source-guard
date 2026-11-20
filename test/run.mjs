#!/usr/bin/env node
/**
 * Fixture runner. Asserts the expected code for each named fixture.
 * The assumption fixture runs first.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const script = join(repoRoot, 'check.mjs');
const fixturesRoot = join(repoRoot, 'fixtures');
const ZERO = '0000000000000000000000000000000000000000';

const CASES = [
  { name: 'assumption-clean', expect: 'PASS' },
  { name: 't1-npm-override', expect: 'F1' },
  { name: 't2-nested-override', expect: 'F1' },
  { name: 't3-devdep-npm-alias', expect: 'F1' },
  { name: 't4-file', expect: 'F2' },
  { name: 't4-git', expect: 'F2' },
  { name: 't4-github', expect: 'F2' },
  { name: 't4-tarball', expect: 'F2' },
  { name: 't5-non-npmjs-resolved', expect: 'F3' },
  { name: 't6-lock-name-mismatch', expect: 'F4' },
  { name: 't7-missing-integrity', expect: 'F5' },
  { name: 't8-evil-npmrc', expect: 'F6' },
  { name: 't9-malformed-lock', expect: 'F7' },
  { name: 't9-missing-lock', expect: 'F7' },
  { name: 't10-allowlisted', expect: 'F1' },
  { name: 'p1-lockfile-only-alias', expect: 'F4' },
  { name: 'p5-root-lock-npm-alias', expect: 'F1' },
  { name: 'p7', expect: 'F2' },
  { name: 'replay-79592d6', expect: ['F1', 'F4'] },
  { name: 'http-npmrc', expect: 'F6' },
  { name: 'http-npmrc-scoped', expect: 'F6' },
  { name: 'http-publishconfig', expect: 'F6' },
  { name: 'http-resolved', expect: 'F3' },
  { name: 'shrinkwrap-only-clean', expect: 'PASS' },
  { name: 'shrinkwrap-evil', expect: 'F3' },
  { name: 'shrinkwrap-differ', expect: 'F7' },
  { name: 'alt-lock-pnpm', expect: 'F7' },
  { name: 'alt-lock-yarn', expect: 'F7' },
  { name: 'abs-path', expect: 'F2' },
  { name: 'dot-path', expect: 'F2' },
  { name: 'ws-valid', expect: 'PASS', baseFromHead: true },
  { name: 'ws-bad-registry', expect: 'F8', baseFromHead: true },
  { name: 'ws-escape', expect: 'F8', baseFromHead: true },
  { name: 'inbundle-ok', expect: 'PASS' },
  { name: 'inbundle-bad-parent', expect: 'F3' },
  { name: 'shrinkwrap-malformed', expect: 'F7' },
  { name: 'shrinkwrap-v1', expect: 'F7' },
  { name: 'both-equal-but-evil', expect: 'F3' },
  { name: 'shrinkwrap-canon-equal', expect: 'PASS' },
  { name: 'uppercase-http', expect: 'F6' },
  { name: 'crlf', expect: 'F6' },
  { name: 'userinfo', expect: 'F6' },
  { name: 'protocol-relative', expect: 'F6' },
  {
    name: 'interpolated-values',
    expect: 'F6',
    env: { INTERP_REG: 'http://interp.example/' },
  },
  { name: 'argv-skip', expect: 'F7', extraArgs: ['--skip'] },
  { name: 'n8-quoted-registry-key', expect: 'F6' },
  { name: 'n13-quoted-scoped-key', expect: 'F6' },
  { name: 'd1-key-dotdot-outside', expect: 'F8' },
  { name: 'd2-key-tmp-outside', expect: 'F8' },
  { name: 'd6-symlink-to-tmp', expect: 'F8', setup: 'symlink-tmp' },
  { name: 'link-dotdot', expect: 'F8' },
  { name: 'link-dotdot-evil', expect: 'F8' },
  { name: 'link-file-dotdot-evil', expect: 'F8' },
  { name: 'link-packages-dotdot-evil', expect: 'F8' },
  { name: 'ws-glob-node_modules', expect: 'F9', baseFromHead: true },
  { name: 'ws-glob-doublestar', expect: 'F9', baseFromHead: true },
  { name: 'ws-glob-root-star', expect: 'F9', baseFromHead: true },
  { name: 'ws-glob-matches-dotdot', expect: 'F9', baseFromHead: true },
  {
    name: 'ws-head-differs-from-base',
    expect: ['F3', 'F5'],
    basePackage: {
      name: 'ws-head-differs-from-base',
      private: true,
      version: '1.0.0',
    },
  },
  {
    name: 'inbundle-git-under-workspace-parent',
    expect: 'F3',
    baseFromHead: true,
  },
  {
    name: 'inbundle-git-under-link-parent',
    expect: 'F3',
    baseFromHead: true,
  },
  { name: 'inbundle-top-level', expect: 'F3' },
  { name: 'inbundle-under-clean-parent', expect: 'PASS' },
  { name: 'folder-record-resolved-escape', expect: 'F8' },
  {
    name: 'base-unreadable',
    expect: 'F9',
    baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  },
  {
    name: 'npm-config-env-scrubbed',
    expect: 'F6',
    env: { npm_config_registry: 'https://registry.npmjs.org/' },
  },
  {
    name: 'c1-userconfig-env-http',
    expect: 'F6',
    setup: 'userconfig-env',
  },
  {
    name: 'c1-npm_config_registry-env-http',
    expect: 'F6',
    env: { npm_config_registry: 'http://from-env.example/' },
  },
  { name: 'c2-strict-ssl-false', expect: 'F6' },
  { name: 'c2-proxy-set', expect: 'F6' },
  { name: 'c2-replace-registry-host', expect: 'F6' },
  {
    name: 'c5-glob-matches-symlink-out',
    expect: 'F9',
    baseFromHead: true,
    setup: 'glob-symlink-out',
  },
  { name: 'c7-subdir-lock', expect: 'F7' },
  { name: 'c7-bun-lock', expect: 'F7' },
  { name: 'c7-bun-lockb', expect: 'F7' },
  { name: 'c3-dsg-dir-in-pr', expect: 'PASS' },
];

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function initGit(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'dsg@example.test']);
  git(dir, ['config', 'user.name', 'dsg']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function setupCase(dir, spec) {
  if (spec.setup === 'symlink-tmp') {
    mkdirSync(join(dir, 'packages'), { recursive: true });
    const target = mkdtempSync(join(tmpdir(), 'dsg-outside-'));
    writeFileSync(join(target, 'package.json'), '{"name":"outside","private":true,"version":"1.0.0"}\n');
    symlinkSync(target, join(dir, 'packages', 'a'));
  }
  if (spec.setup === 'glob-symlink-out') {
    mkdirSync(join(dir, 'packages'), { recursive: true });
    const target = mkdtempSync(join(tmpdir(), 'dsg-ws-out-'));
    writeFileSync(join(target, 'package.json'), '{"name":"evil","private":true,"version":"1.0.0"}\n');
    symlinkSync(target, join(dir, 'packages', 'evil'));
  }
}

function runCheck(dir, spec, baseSha) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR || tmpdir(),
    LANG: process.env.LANG || 'C',
    ...spec.env,
  };
  if (spec.setup === 'userconfig-env') {
    env.NPM_CONFIG_USERCONFIG = join(dir, 'userconfig.npmrc');
  }
  const args = [script, '--root', dir, '--base-sha', baseSha, ...(spec.extraArgs || [])];
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: dir,
    env,
    timeout: 30_000,
  });
  return {
    status: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error,
  };
}

function expectedCodes(spec) {
  return Array.isArray(spec.expect) ? spec.expect : spec.expect === 'PASS' ? [] : [spec.expect];
}

let passed = 0;
const failures = [];

for (const spec of CASES) {
  const src = join(fixturesRoot, spec.name);
  if (!existsSync(src)) {
    failures.push(`${spec.name}: missing fixture directory`);
    continue;
  }
  const dir = mkdtempSync(join(tmpdir(), `dsg-${spec.name}-`));
  try {
    cpSync(src, dir, { recursive: true });
    setupCase(dir, spec);
    initGit(dir);
    let baseSha = ZERO;
    if (spec.baseSha) {
      commitAll(dir, 'head');
      baseSha = spec.baseSha;
    } else if (spec.basePackage) {
      const pkgPath = join(dir, 'package.json');
      const headPkg = existsSync(pkgPath)
        ? JSON.parse(readFileSync(pkgPath, 'utf8'))
        : null;
      writeFileSync(pkgPath, `${JSON.stringify(spec.basePackage, null, 2)}\n`);
      baseSha = commitAll(dir, 'base');
      if (headPkg) {
        writeFileSync(pkgPath, `${JSON.stringify(headPkg, null, 2)}\n`);
      }
      commitAll(dir, 'head');
    } else if (spec.baseFromHead) {
      baseSha = commitAll(dir, 'base-and-head');
    } else {
      commitAll(dir, 'head');
      baseSha = ZERO;
    }
    const result = runCheck(dir, spec, baseSha);
    if (result.error) {
      failures.push(`${spec.name}: spawn error ${result.error.message}`);
      continue;
    }
    const codes = expectedCodes(spec);
    if (spec.expect === 'PASS') {
      if (result.status !== 0) {
        failures.push(`${spec.name}: expected PASS, got ${result.status}\n${result.out}`);
        continue;
      }
      if (/\bFAIL F\d\b/.test(result.out)) {
        failures.push(`${spec.name}: PASS output contained FAIL\n${result.out}`);
        continue;
      }
    } else {
      if (result.status === 0) {
        failures.push(`${spec.name}: expected ${codes.join('+')}, got PASS\n${result.out}`);
        continue;
      }
      for (const code of codes) {
        const re = new RegExp(`FAIL ${code}\\b`);
        if (!re.test(result.out)) {
          failures.push(`${spec.name}: missing ${code}\n${result.out}`);
        }
      }
    }
    if (failures[failures.length - 1]?.startsWith(`${spec.name}:`)) {
      continue;
    }
    passed += 1;
    process.stdout.write(`ok ${passed} ${spec.name}\n`);
  } catch (err) {
    failures.push(`${spec.name}: ${err instanceof Error ? err.stack : err}`);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} failed, ${passed} passed\n`);
  for (const failure of failures) {
    process.stderr.write(`\n${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(`\n${passed}/${CASES.length} passed\n`);
