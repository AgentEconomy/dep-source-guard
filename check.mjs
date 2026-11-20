#!/usr/bin/env node
/**
 * Shared dependency-source checker (dep-source-guard).
 *
 * Node built-ins only. No network. No skip or env bypass. One self-contained
 * file so a sha256 of this path covers all code that runs (C3).
 *
 * Usage: node check.mjs --root <dir> --base-sha <sha>
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

/** C8: npmjs-only allowlist. Changes only by an SO-reviewed PR. */
const ALLOWED_REGISTRY_HOST = 'registry.npmjs.org';

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
];

const ROOT_SPEC_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const FORBIDDEN_LOCK_NAMES = new Set([
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

const ROOT_LOCK_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);

const ZERO_SHA_RE = /^0+$/;

function pushFinding(findings, code, key, reason) {
  findings.push({ code, key, reason });
}

function failClosed(findings, key, reason) {
  pushFinding(findings, 'F7', key, reason);
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function posixRel(from, to) {
  return relative(from, to).split(sep).join('/');
}

function staysInsideRoot(rootReal, absPath) {
  const relToRoot = relative(rootReal, absPath);
  return !(relToRoot.startsWith('..') || isAbsolute(relToRoot));
}

function isAbsoluteLike(p) {
  const n = String(p).replaceAll('\\', '/');
  return n.startsWith('/') || /^[A-Za-z]:/.test(n);
}

function hasDotDotSegment(p) {
  return String(p)
    .replaceAll('\\', '/')
    .split('/')
    .includes('..');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

function canonicalEqual(a, b) {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/**
 * C8 allowlist: parsed URL, https:, host exactly registry.npmjs.org,
 * no port, no userinfo.
 */
function isAllowedRegistryUrl(value) {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port !== '') return false;
  if (url.hostname !== ALLOWED_REGISTRY_HOST) return false;
  return true;
}

function registryRejectReason(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    if (url.hostname === ALLOWED_REGISTRY_HOST && url.protocol !== 'https:') {
      return 'registry is not https://registry.npmjs.org';
    }
    if (url.username || url.password) {
      return 'registry URL has userinfo';
    }
    if (url.port) {
      return 'registry URL has a port';
    }
  } catch {
    // never print the value
  }
  return 'registry host is not registry.npmjs.org';
}

function isNpmAlias(spec) {
  return spec.startsWith('npm:');
}

function hasProtocol(spec) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec);
}

function isGithubShorthand(spec) {
  if (spec.startsWith('@')) return false;
  if (spec.includes(':')) return false;
  return /^[^/\s]+\/[^/\s]+(?:#.*)?$/.test(spec);
}

function isPathLikeSpec(spec) {
  const t = spec.trim();
  if (!t) return false;
  if (t.startsWith('.') || t.startsWith('/') || t.startsWith('~') || t.startsWith('\\')) {
    return true;
  }
  return /^[A-Za-z]:/.test(t);
}

function classifyManifestSpec(spec) {
  const trimmed = spec.trim();
  if (isNpmAlias(trimmed)) return 'F1';
  if (
    hasProtocol(trimmed) ||
    trimmed.startsWith('git+') ||
    isGithubShorthand(trimmed) ||
    isPathLikeSpec(trimmed)
  ) {
    return 'F2';
  }
  return null;
}

function walkSpecs(value, keyPath, findings) {
  if (value == null) return;
  if (typeof value === 'string') {
    const code = classifyManifestSpec(value);
    if (code === 'F1') {
      pushFinding(findings, 'F1', keyPath, 'npm: alias');
    } else if (code === 'F2') {
      pushFinding(findings, 'F2', keyPath, 'non-registry spec');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkSpecs(item, `${keyPath}[${index}]`, findings);
    });
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      walkSpecs(v, `${keyPath}.${k}`, findings);
    }
  }
}

function impliedNameFromLockKey(key) {
  if (key === '' || key === '.') return null;
  const marker = 'node_modules/';
  const idx = key.lastIndexOf(marker);
  if (idx === -1) return null;
  const rest = key.slice(idx + marker.length);
  if (!rest) return null;
  if (rest.startsWith('@')) {
    const parts = rest.split('/');
    if (parts.length < 2 || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return rest.split('/')[0] || null;
}

function resolvedPathnamePrefix(implied) {
  return `/${implied}/-/`;
}

function resolvedPathnameMatchesImplied(resolved, implied) {
  if (typeof resolved !== 'string' || resolved.length === 0) return true;
  let url;
  try {
    url = new URL(resolved);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }
  return pathname.startsWith(resolvedPathnamePrefix(implied));
}

function lockEntryKey(lockLabel, key) {
  return key === '' ? `${lockLabel}:(root)` : `${lockLabel}:${key}`;
}

function parentLockKey(key) {
  const marker = '/node_modules/';
  const idx = key.lastIndexOf(marker);
  if (idx <= 0) return null;
  return key.slice(0, idx);
}

function stripFileProtocol(raw) {
  const t = String(raw);
  if (t.startsWith('file:')) {
    const rest = t.slice('file:'.length);
    try {
      const url = new URL(t);
      if (url.protocol === 'file:') return url.pathname;
    } catch {
      return rest;
    }
    return rest;
  }
  return t;
}

/**
 * C4: realpath failures never pass. Missing paths use a lexical normalize
 * plus realpath of the nearest existing ancestor. Any error is F8 or F7.
 */
function nearestExistingAncestor(absPath) {
  let cur = absPath;
  for (;;) {
    if (existsSync(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

function containPath(rootReal, rawPath, findings, key, code = 'F8') {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    pushFinding(findings, code, key, 'path escapes repo root');
    return null;
  }
  if (hasProtocol(rawPath) && !rawPath.startsWith('file:')) {
    pushFinding(findings, code, key, 'path escapes repo root');
    return null;
  }
  const posix = stripFileProtocol(rawPath).replaceAll('\\', '/');
  if (hasDotDotSegment(posix) || hasDotDotSegment(rawPath)) {
    pushFinding(findings, code, key, 'path escapes repo root');
    return null;
  }
  let abs;
  try {
    abs = isAbsoluteLike(posix) ? resolve(posix) : resolve(rootReal, posix);
  } catch {
    failClosed(findings, key, 'path check failed');
    return null;
  }
  const ancestor = nearestExistingAncestor(abs);
  let realAncestor;
  try {
    realAncestor = realpathSync(ancestor);
  } catch {
    pushFinding(findings, code, key, 'realpath failed');
    return null;
  }
  let rest;
  try {
    rest = relative(ancestor, abs);
  } catch {
    failClosed(findings, key, 'path check failed');
    return null;
  }
  const reconstructed =
    rest && rest !== '' ? resolve(realAncestor, rest) : realAncestor;
  let finalPath = reconstructed;
  const existing = existsSync(abs) ? abs : existsSync(reconstructed) ? reconstructed : null;
  if (existing) {
    try {
      finalPath = realpathSync(existing);
    } catch {
      pushFinding(findings, code, key, 'realpath failed');
      return null;
    }
  }
  if (
    !staysInsideRoot(rootReal, realAncestor) ||
    !staysInsideRoot(rootReal, reconstructed) ||
    !staysInsideRoot(rootReal, finalPath) ||
    hasDotDotSegment(rest)
  ) {
    pushFinding(findings, code, key, 'path escapes repo root');
    return null;
  }
  return finalPath;
}

function isFolderRecordKey(key) {
  return !key.includes('node_modules/');
}

function parseNpmConfigJson(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  const idx = stdout.indexOf('{');
  if (idx === -1) return null;
  const parsed = parseJson(stdout.slice(idx));
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return null;
  }
  return parsed.value;
}

function scrubNpmConfigEnv(env) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase().startsWith('npm_config_')) {
      delete out[key];
    }
  }
  return out;
}

function isFalseConfigValue(value) {
  if (value === false) return true;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'false') return true;
  return false;
}

function isSetOverride(value) {
  if (value == null) return false;
  if (value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) {
    return value.some((item) => typeof item === 'string' && item.trim().length > 0);
  }
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function configBasename(key) {
  const lower = String(key).toLowerCase();
  const colon = lower.lastIndexOf(':');
  if (colon === -1) return lower;
  return lower.slice(colon + 1);
}

function isRegistryConfigKey(key) {
  const lower = String(key).toLowerCase();
  return lower === 'registry' || lower.endsWith(':registry');
}

const ALLOWED_REPLACE_REGISTRY_HOST = new Set(['default', 'never', 'npmjs']);

function checkNpmConfigText(text, source, findings) {
  if (typeof text !== 'string' || text.length === 0) return;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!isRegistryConfigKey(key)) continue;
    if (value.includes('***') || value.includes('@')) {
      if (value.includes('***') || /https?:\/\/[^/]*@/.test(value)) {
        pushFinding(
          findings,
          'F6',
          `npm-config:${source}:${key}`,
          'registry URL has userinfo',
        );
        continue;
      }
    }
    if (!isAllowedRegistryUrl(value)) {
      pushFinding(
        findings,
        'F6',
        `npm-config:${source}:${key}`,
        registryRejectReason(value),
      );
    }
  }
}

function checkNpmConfigObject(cfg, source, findings) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    failClosed(findings, `npm-config:${source}`, 'unparsable npm config');
    return;
  }
  if (!Object.hasOwn(cfg, 'registry')) {
    pushFinding(
      findings,
      'F6',
      `npm-config:${source}:registry`,
      'registry is protected or missing',
    );
  }
  for (const [key, value] of Object.entries(cfg)) {
    if (isRegistryConfigKey(key)) {
      if (!isAllowedRegistryUrl(value)) {
        pushFinding(
          findings,
          'F6',
          `npm-config:${source}:${key}`,
          registryRejectReason(value),
        );
      }
      continue;
    }
    const base = configBasename(key);
    if (base === 'strict-ssl' && isFalseConfigValue(value)) {
      pushFinding(findings, 'F6', `npm-config:${source}:${key}`, 'strict-ssl=false');
      continue;
    }
    if (base === 'proxy' || base === 'https-proxy' || base === 'http-proxy') {
      if (isSetOverride(value)) {
        pushFinding(findings, 'F6', `npm-config:${source}:${key}`, 'proxy override');
      }
      continue;
    }
    if (base === 'noproxy' || base === 'no-proxy') {
      if (isSetOverride(value)) {
        pushFinding(findings, 'F6', `npm-config:${source}:${key}`, 'noproxy override');
      }
      continue;
    }
    if (base === 'ca' || base === 'cafile' || base === 'cert') {
      if (isSetOverride(value)) {
        pushFinding(findings, 'F6', `npm-config:${source}:${key}`, `${base} set`);
      }
      continue;
    }
    if (base === 'replace-registry-host') {
      const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
      if (v != null && v !== '' && !ALLOWED_REPLACE_REGISTRY_HOST.has(String(v))) {
        pushFinding(
          findings,
          'F6',
          `npm-config:${source}:${key}`,
          'replace-registry-host is not default or never',
        );
      }
    }
  }
}

function runNpmConfigList(root, env, extraArgs) {
  return spawnSync('npm', ['config', 'list', '--json', ...extraArgs], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

/**
 * C1: two passes. Scrubbed (case-insensitive npm_config_* strip, temp HOME,
 * empty user/global config files) and the job's real env. Either pass unsafe
 * is F6. npm missing / non-zero / unparsable is F7.
 *
 * npm 10 refuses --userconfig=/dev/null --globalconfig=/dev/null (same inode
 * double-load), so the scrubbed pass uses two empty files in the temp HOME.
 */
function checkNpmConfigPasses(root, findings) {
  let tempHome;
  try {
    tempHome = mkdtempSync(join(tmpdir(), 'dsg-home-'));
    mkdirSync(tempHome, { recursive: true });
    const userconfig = join(tempHome, 'userconfig');
    const globalconfig = join(tempHome, 'globalconfig');
    writeFileSync(userconfig, '');
    writeFileSync(globalconfig, '');

    const scrubbedEnv = scrubNpmConfigEnv(process.env);
    scrubbedEnv.HOME = tempHome;
    delete scrubbedEnv.npm_config_userconfig;
    delete scrubbedEnv.NPM_CONFIG_USERCONFIG;

    const scrubbedArgs = [
      '--userconfig',
      userconfig,
      '--globalconfig',
      globalconfig,
    ];
    const scrubbed = runNpmConfigList(root, scrubbedEnv, scrubbedArgs);
    if (scrubbed.error && scrubbed.error.code === 'ENOENT') {
      failClosed(findings, 'npm', 'npm is missing');
    } else if (scrubbed.status !== 0) {
      failClosed(findings, 'npm-config:scrubbed', 'npm config list exited non-zero');
    } else {
      const cfg = parseNpmConfigJson(scrubbed.stdout);
      if (!cfg) {
        failClosed(findings, 'npm-config:scrubbed', 'unparsable npm config');
      } else {
        checkNpmConfigObject(cfg, 'scrubbed', findings);
      }
    }
    const scrubbedText = spawnSync('npm', ['config', 'list', ...scrubbedArgs], {
      cwd: root,
      env: scrubbedEnv,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (scrubbedText.status === 0) {
      checkNpmConfigText(scrubbedText.stdout, 'scrubbed', findings);
    }

    const real = runNpmConfigList(root, process.env, []);
    if (real.error && real.error.code === 'ENOENT') {
      failClosed(findings, 'npm', 'npm is missing');
    } else if (real.status !== 0) {
      failClosed(findings, 'npm-config:effective', 'npm config list exited non-zero');
    } else {
      const cfg = parseNpmConfigJson(real.stdout);
      if (!cfg) {
        failClosed(findings, 'npm-config:effective', 'unparsable npm config');
      } else {
        checkNpmConfigObject(cfg, 'effective', findings);
      }
    }
    const realText = spawnSync('npm', ['config', 'list'], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (realText.status === 0) {
      checkNpmConfigText(realText.stdout, 'effective', findings);
    }
  } catch {
    failClosed(findings, 'npm-config', 'npm config check failed');
  } finally {
    if (tempHome) {
      try {
        rmSync(tempHome, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

function checkPublishConfig(pkg, findings) {
  const pc = pkg.publishConfig;
  if (!pc || typeof pc !== 'object' || Array.isArray(pc)) return;
  for (const [key, value] of Object.entries(pc)) {
    if (!isRegistryConfigKey(key)) continue;
    if (!isAllowedRegistryUrl(value)) {
      pushFinding(
        findings,
        'F6',
        `package.json:publishConfig.${key}`,
        registryRejectReason(value),
      );
    }
  }
}

function checkManifest(pkg, findings) {
  for (const field of DEP_FIELDS) {
    if (!Object.hasOwn(pkg, field)) continue;
    walkSpecs(pkg[field], `package.json:${field}`, findings);
  }
  checkPublishConfig(pkg, findings);
}

function workspacesFromPkg(pkg) {
  if (!pkg || typeof pkg !== 'object') return [];
  const ws = pkg.workspaces;
  if (Array.isArray(ws)) return ws.filter((p) => typeof p === 'string');
  if (ws && typeof ws === 'object' && Array.isArray(ws.packages)) {
    return ws.packages.filter((p) => typeof p === 'string');
  }
  return [];
}

function isUnsafeWorkspacePattern(pattern) {
  const p = String(pattern).replaceAll('\\', '/');
  if (isAbsoluteLike(p)) return true;
  if (p.includes('**')) return true;
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.includes('..')) return true;
  if (segs.includes('node_modules')) return true;
  if (segs.length === 0) return true;
  if (segs.length === 1 && segs[0] === '*') return true;
  if (p === '*' || p === './*') return true;
  const last = segs[segs.length - 1];
  const head = segs.slice(0, -1);
  if (last === '*') {
    if (head.length === 0) return true;
    if (head.some((s) => s.includes('*'))) return true;
    return false;
  }
  if (p.includes('*')) return true;
  return false;
}

function matchWorkspacePattern(rootReal, pattern) {
  const p = String(pattern).replaceAll('\\', '/').replace(/^\.\//, '');
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segs[segs.length - 1] === '*') {
    const dir = segs.slice(0, -1).join('/');
    const absDir = resolve(rootReal, dir);
    if (!existsSync(absDir)) return [];
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const matches = [];
    for (const ent of entries) {
      if (ent.name === '.' || ent.name === '..') continue;
      matches.push(`${dir}/${ent.name}`);
    }
    return matches;
  }
  return [segs.join('/')];
}

function loadBaseWorkspaceSet(root, rootReal, baseSha, findings) {
  const matched = new Set();
  if (typeof baseSha !== 'string' || baseSha.length === 0) {
    pushFinding(findings, 'F9', 'BASE_SHA', 'unsafe or unreadable workspace set');
    return matched;
  }
  if (ZERO_SHA_RE.test(baseSha)) {
    return matched;
  }
  const shown = spawnSync('git', ['show', `${baseSha}:package.json`], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (shown.error || shown.status !== 0) {
    pushFinding(findings, 'F9', 'BASE_SHA', 'unsafe or unreadable workspace set');
    return matched;
  }
  const parsed = parseJson(shown.stdout);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    pushFinding(findings, 'F9', 'BASE_SHA', 'unsafe or unreadable workspace set');
    return matched;
  }
  const patterns = workspacesFromPkg(parsed.value);
  for (const pattern of patterns) {
    if (isUnsafeWorkspacePattern(pattern)) {
      pushFinding(
        findings,
        'F9',
        `workspaces:${pattern}`,
        'unsafe workspace pattern',
      );
      continue;
    }
    let matches;
    try {
      matches = matchWorkspacePattern(rootReal, pattern);
    } catch {
      pushFinding(findings, 'F9', `workspaces:${pattern}`, 'unsafe or unreadable workspace set');
      continue;
    }
    for (const match of matches) {
      const segs = String(match).replaceAll('\\', '/').split('/');
      if (segs.includes('node_modules') || segs.includes('..') || isAbsoluteLike(match)) {
        pushFinding(
          findings,
          'F9',
          `workspaces-match:${match}`,
          'workspace match is unsafe',
        );
        continue;
      }
      const contained = containPath(rootReal, match, findings, `workspaces-match:${match}`, 'F9');
      if (!contained) continue;
      matched.add(String(match).replaceAll('\\', '/'));
      try {
        matched.add(posixRel(rootReal, contained));
      } catch {
        // keep the lexical match
      }
    }
  }
  return matched;
}

function isWorkspaceMatch(workspaceSet, relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  const n = relPath.replaceAll('\\', '/').replace(/^\.\//, '');
  return workspaceSet.has(n);
}

function collectPathEscapeFindings(rootReal, lockLabel, key, entry, findings) {
  const lockKey = lockEntryKey(lockLabel, key);
  const folderRecord = isFolderRecordKey(key);
  if (folderRecord) {
    containPath(rootReal, key, findings, lockKey, 'F8');
  }
  if (entry.link === true) {
    if (typeof entry.resolved !== 'string' || entry.resolved.length === 0) {
      pushFinding(findings, 'F8', lockKey, 'path escapes repo root');
    } else {
      containPath(rootReal, entry.resolved, findings, lockKey, 'F8');
    }
  }
  if (folderRecord && typeof entry.resolved === 'string' && entry.resolved.length > 0) {
    if (hasProtocol(entry.resolved) && !entry.resolved.startsWith('file:')) {
      pushFinding(findings, 'F8', lockKey, 'path escapes repo root');
    } else {
      containPath(rootReal, entry.resolved, findings, lockKey, 'F8');
    }
  }
}

function isWorkspaceExempt(rootReal, workspaceSet, key, entry) {
  if (typeof entry.resolved === 'string' && hasProtocol(entry.resolved) && !entry.resolved.startsWith('file:')) {
    return false;
  }
  if (entry.link === true) {
    if (typeof entry.resolved !== 'string') return false;
    const n = entry.resolved.replaceAll('\\', '/').replace(/^\.\//, '');
    return isWorkspaceMatch(workspaceSet, n);
  }
  if (isFolderRecordKey(key)) {
    const n = key.replaceAll('\\', '/').replace(/^\.\//, '');
    return isWorkspaceMatch(workspaceSet, n);
  }
  return false;
}

function baseRecordFindings(rootReal, workspaceSet, lockLabel, key, entry) {
  const findings = [];
  collectPathEscapeFindings(rootReal, lockLabel, key, entry, findings);
  const lockKey = lockEntryKey(lockLabel, key);
  const workspace = isWorkspaceExempt(rootReal, workspaceSet, key, entry);
  if (workspace) {
    return { workspace: true, findings };
  }
  if (!isAllowedRegistryUrl(entry.resolved)) {
    pushFinding(
      findings,
      'F3',
      lockKey,
      'resolved is not https://registry.npmjs.org/',
    );
  }
  if (typeof entry.integrity !== 'string' || entry.integrity.length === 0) {
    pushFinding(findings, 'F5', lockKey, 'missing integrity');
  }
  const implied = impliedNameFromLockKey(key);
  if (implied) {
    if (typeof entry.name === 'string' && entry.name.length > 0 && entry.name !== implied) {
      pushFinding(
        findings,
        'F4',
        lockKey,
        `name differs from path-implied ${implied}`,
      );
    }
    if (!resolvedPathnameMatchesImplied(entry.resolved, implied)) {
      pushFinding(
        findings,
        'F4',
        lockKey,
        `resolved pathname does not start with ${resolvedPathnamePrefix(implied)}`,
      );
    }
  }
  return { workspace: false, findings };
}

function checkLockObject(lock, lockLabel, rootReal, workspaceSet, findings) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    failClosed(findings, lockLabel, 'parse error');
    return;
  }
  if (typeof lock.lockfileVersion !== 'number' || lock.lockfileVersion < 2) {
    failClosed(findings, lockLabel, 'lockfileVersion < 2');
    return;
  }
  const packages = lock.packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    failClosed(findings, lockLabel, 'parse error');
    return;
  }

  const bases = new Map();
  for (const [key, entry] of Object.entries(packages)) {
    const lockKey = lockEntryKey(lockLabel, key);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      failClosed(findings, lockKey, 'parse error');
      continue;
    }
    if (key === '') {
      for (const field of ROOT_SPEC_FIELDS) {
        if (!Object.hasOwn(entry, field)) continue;
        walkSpecs(entry[field], `${lockKey}.${field}`, findings);
      }
      continue;
    }
    bases.set(key, {
      entry,
      ...baseRecordFindings(rootReal, workspaceSet, lockLabel, key, entry),
    });
  }

  for (const [key, base] of bases) {
    if (base.workspace) {
      findings.push(...base.findings);
      continue;
    }
    const bundled = base.entry.inBundle === true;
    const parent = parentLockKey(key);
    const parentBase = parent ? bases.get(parent) : undefined;
    const parentAllowsInBundle =
      Boolean(parentBase) &&
      parentBase.workspace === false &&
      parentBase.entry.link !== true &&
      parentBase.findings.length === 0;
    if (bundled && parentAllowsInBundle) {
      for (const finding of base.findings) {
        if (finding.code === 'F4' || finding.code === 'F8') findings.push(finding);
      }
      continue;
    }
    findings.push(...base.findings);
  }
}

function loadLockObject(path, label, findings) {
  if (!existsSync(path)) return null;
  const parsed = parseJson(readText(path));
  if (!parsed.ok) {
    failClosed(findings, label, 'parse error');
    return null;
  }
  return parsed.value;
}

function checkLockfiles(root, rootReal, workspaceSet, findings) {
  const lockPath = join(root, 'package-lock.json');
  const shrinkPath = join(root, 'npm-shrinkwrap.json');
  const hasLock = existsSync(lockPath);
  const hasShrink = existsSync(shrinkPath);
  if (!hasLock && !hasShrink) {
    failClosed(findings, 'package-lock.json', 'missing lockfile');
    return;
  }
  if (hasLock && hasShrink) {
    const lock = loadLockObject(lockPath, 'package-lock.json', findings);
    const shrink = loadLockObject(shrinkPath, 'npm-shrinkwrap.json', findings);
    if (!lock || !shrink) return;
    if (!canonicalEqual(lock, shrink)) {
      failClosed(findings, 'npm-shrinkwrap.json', 'differs from package-lock.json');
      return;
    }
    checkLockObject(lock, 'package-lock.json', rootReal, workspaceSet, findings);
    return;
  }
  if (hasLock) {
    const lock = loadLockObject(lockPath, 'package-lock.json', findings);
    if (!lock) return;
    checkLockObject(lock, 'package-lock.json', rootReal, workspaceSet, findings);
    return;
  }
  const shrink = loadLockObject(shrinkPath, 'npm-shrinkwrap.json', findings);
  if (!shrink) return;
  checkLockObject(shrink, 'npm-shrinkwrap.json', rootReal, workspaceSet, findings);
}

function isForbiddenLockfile(name, relPath) {
  if (FORBIDDEN_LOCK_NAMES.has(name)) return true;
  if (ROOT_LOCK_NAMES.has(name)) return relPath !== name;
  return false;
}

/** C7: any lockfile other than the root package-lock/shrinkwrap, at any depth. */
function checkForbiddenLockfiles(rootReal, findings) {
  const stack = [rootReal];
  const seen = new Set();
  while (stack.length > 0) {
    const dir = stack.pop();
    let realDir;
    try {
      realDir = realpathSync(dir);
    } catch {
      failClosed(findings, posixRel(rootReal, dir) || '.', 'unreadable directory');
      continue;
    }
    if (!staysInsideRoot(rootReal, realDir)) continue;
    if (seen.has(realDir)) continue;
    seen.add(realDir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      failClosed(findings, posixRel(rootReal, dir) || '.', 'unreadable directory');
      continue;
    }
    for (const ent of entries) {
      if (ent.name === '.' || ent.name === '..') continue;
      if (ent.name === '.git') continue;
      const full = join(dir, ent.name);
      const relPath = posixRel(rootReal, full);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        failClosed(findings, relPath, 'unreadable path');
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (isForbiddenLockfile(ent.name, relPath)) {
          failClosed(findings, relPath, 'forbidden lockfile');
        }
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (stat.isFile() && isForbiddenLockfile(ent.name, relPath)) {
        failClosed(findings, relPath, 'forbidden lockfile');
      }
    }
  }
}

function printFinding(prefix, finding) {
  process.stderr.write(`${prefix} ${finding.code} ${finding.key} (${finding.reason})\n`);
}

function parseArgs(argv) {
  const out = { root: null, baseSha: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' || arg.startsWith('--root=')) {
      const value = arg === '--root' ? argv[++i] : arg.slice('--root='.length);
      if (typeof value !== 'string' || value.length === 0) {
        return { error: 'missing --root value' };
      }
      out.root = value;
      continue;
    }
    if (arg === '--base-sha' || arg.startsWith('--base-sha=')) {
      const value = arg === '--base-sha' ? argv[++i] : arg.slice('--base-sha='.length);
      if (typeof value !== 'string' || value.length === 0) {
        return { error: 'missing --base-sha value' };
      }
      out.baseSha = value;
      continue;
    }
    if (arg.startsWith('-')) {
      return { error: 'unknown flag; no skip or bypass is supported' };
    }
    return { error: 'extra arguments' };
  }
  return out;
}

function run(root, baseSha) {
  const findings = [];
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch {
    failClosed(findings, 'root', 'realpath failed');
    for (const finding of findings) printFinding('FAIL', finding);
    return 1;
  }

  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    failClosed(findings, 'package.json', 'missing package.json');
  }
  let pkg = null;
  if (existsSync(pkgPath)) {
    const parsedPkg = parseJson(readText(pkgPath));
    if (!parsedPkg.ok || !parsedPkg.value || typeof parsedPkg.value !== 'object' || Array.isArray(parsedPkg.value)) {
      failClosed(findings, 'package.json', 'parse error');
    } else {
      pkg = parsedPkg.value;
    }
  }

  checkForbiddenLockfiles(rootReal, findings);
  checkNpmConfigPasses(root, findings);
  const workspaceSet = loadBaseWorkspaceSet(root, rootReal, baseSha, findings);
  if (pkg) checkManifest(pkg, findings);
  checkLockfiles(root, rootReal, workspaceSet, findings);

  if (findings.length === 0) {
    process.stdout.write('PASS\n');
    return 0;
  }
  for (const finding of findings) printFinding('FAIL', finding);
  return 1;
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`FAIL F7 argv (${parsed.error})\n`);
    return 1;
  }
  if (parsed.root == null || parsed.baseSha == null) {
    process.stderr.write('FAIL F7 argv (required --root and --base-sha)\n');
    return 1;
  }
  const root = resolve(parsed.root);
  return run(root, parsed.baseSha);
}

const invokedDirectly =
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
