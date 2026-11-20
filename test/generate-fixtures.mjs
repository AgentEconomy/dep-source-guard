#!/usr/bin/env node
/**
 * Writes the fixture corpus under fixtures/. Re-run after editing cases.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'fixtures');

const INTEGRITY =
  'sha512-47DEQpj8HBSa+/TImW+5JCeuQeRkgdO72Gw01BbgLL7lvh2xcrHxCwxP3Ew==';
const NPM_FOO = 'https://registry.npmjs.org/foo/-/foo-1.0.0.tgz';
const NPM_A = 'https://registry.npmjs.org/a/-/a-1.0.0.tgz';
const NPM_B = 'https://registry.npmjs.org/b/-/b-1.0.0.tgz';

function pkg(name, extra = {}) {
  return {
    name,
    private: true,
    version: '1.0.0',
    ...extra,
  };
}

function lock(name, packages = {}) {
  return {
    name,
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name, version: '1.0.0' },
      ...packages,
    },
  };
}

function cleanLock(name, extraRoot = {}, extraPackages = {}) {
  return {
    name,
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name, version: '1.0.0', ...extraRoot },
      ...extraPackages,
    },
  };
}

function write(rel, content) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
  );
}

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

// assumption (runs first): clean tree
write('assumption-clean/package.json', pkg('assumption-clean'));
write('assumption-clean/package-lock.json', cleanLock('assumption-clean'));

write('t1-npm-override/package.json', pkg('t1-npm-override', {
  overrides: { picomatch: 'npm:@ryotsu/picomatch@4.0.7-a' },
}));
write('t1-npm-override/package-lock.json', cleanLock('t1-npm-override'));

write('t2-nested-override/package.json', pkg('t2-nested-override', {
  overrides: { vitest: { picomatch: 'npm:x@1' } },
}));
write('t2-nested-override/package-lock.json', cleanLock('t2-nested-override'));

write('t3-devdep-npm-alias/package.json', pkg('t3-devdep-npm-alias', {
  devDependencies: { foo: 'npm:bar@1' },
}));
write('t3-devdep-npm-alias/package-lock.json', cleanLock('t3-devdep-npm-alias'));

write('t4-file/package.json', pkg('t4-file', { dependencies: { foo: 'file:../x' } }));
write('t4-file/package-lock.json', cleanLock('t4-file'));

write('t4-git/package.json', pkg('t4-git', {
  dependencies: { foo: 'git+https://github.com/user/repo.git' },
}));
write('t4-git/package-lock.json', cleanLock('t4-git'));

write('t4-github/package.json', pkg('t4-github', {
  dependencies: { foo: 'github:user/repo' },
}));
write('t4-github/package-lock.json', cleanLock('t4-github'));

write('t4-tarball/package.json', pkg('t4-tarball', {
  dependencies: { foo: 'https://example.com/foo-1.0.0.tgz' },
}));
write('t4-tarball/package-lock.json', cleanLock('t4-tarball'));

write('t5-non-npmjs-resolved/package.json', pkg('t5-non-npmjs-resolved'));
write('t5-non-npmjs-resolved/package-lock.json', cleanLock('t5-non-npmjs-resolved', {}, {
  'node_modules/foo': {
    version: '1.0.0',
    resolved: 'https://evil.example/foo-1.0.0.tgz',
    integrity: INTEGRITY,
  },
}));

write('t6-lock-name-mismatch/package.json', pkg('t6-lock-name-mismatch'));
write('t6-lock-name-mismatch/package-lock.json', cleanLock('t6-lock-name-mismatch', {}, {
  'node_modules/picomatch': {
    name: '@ryotsu/picomatch',
    version: '4.0.7-a',
    resolved: 'https://registry.npmjs.org/@ryotsu/picomatch/-/picomatch-4.0.7-a.tgz',
    integrity: INTEGRITY,
  },
}));

write('t7-missing-integrity/package.json', pkg('t7-missing-integrity'));
write('t7-missing-integrity/package-lock.json', cleanLock('t7-missing-integrity', {}, {
  'node_modules/foo': {
    version: '1.0.0',
    resolved: NPM_FOO,
  },
}));

write('t8-evil-npmrc/package.json', pkg('t8-evil-npmrc'));
write('t8-evil-npmrc/package-lock.json', cleanLock('t8-evil-npmrc'));
write('t8-evil-npmrc/.npmrc', 'registry=https://evil.example/\n');

write('t9-malformed-lock/package.json', pkg('t9-malformed-lock'));
write('t9-malformed-lock/package-lock.json', '{not json\n');

write('t9-missing-lock/package.json', pkg('t9-missing-lock'));

write('t10-allowlisted/package.json', pkg('t10-allowlisted', {
  devDependencies: { foo: 'npm:bar@1' },
}));
write('t10-allowlisted/package-lock.json', cleanLock('t10-allowlisted'));
write(
  't10-allowlisted/scripts/dependency-sources-allowlist.json',
  '["package.json:devDependencies.foo"]\n',
);

write('p1-lockfile-only-alias/package.json', pkg('p1-lockfile-only-alias'));
write('p1-lockfile-only-alias/package-lock.json', cleanLock('p1-lockfile-only-alias', {}, {
  'node_modules/picomatch': {
    version: '4.0.7-a',
    resolved: 'https://registry.npmjs.org/@ryotsu/picomatch/-/picomatch-4.0.7-a.tgz',
    integrity: 'sha512-AAAA',
  },
}));

write('p5-root-lock-npm-alias/package.json', pkg('p5-root-lock-npm-alias'));
write('p5-root-lock-npm-alias/package-lock.json', cleanLock(
  'p5-root-lock-npm-alias',
  { dependencies: { picomatch: 'npm:@ryotsu/picomatch@4.0.7-a' } },
  {
    'node_modules/picomatch': {
      version: '4.0.7',
      resolved: 'https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz',
      integrity: 'sha512-AAAA',
    },
  },
));

write('p7/package.json', pkg('p7', { dependencies: { foo: '~/foo' } }));
write('p7/package-lock.json', cleanLock('p7'));

write('replay-79592d6/package.json', pkg('replay-79592d6', {
  description: 'Reconstructed from agentpay-mcp commit 79592d6',
  overrides: { picomatch: 'npm:@ryotsu/picomatch@4.0.7-a' },
}));
write('replay-79592d6/package-lock.json', cleanLock('replay-79592d6', {}, {
  'node_modules/picomatch': {
    name: '@ryotsu/picomatch',
    version: '4.0.7-a',
    resolved: 'https://registry.npmjs.org/@ryotsu/picomatch/-/picomatch-4.0.7-a.tgz',
    integrity: INTEGRITY,
  },
}));

write('http-npmrc/package.json', pkg('http-npmrc'));
write('http-npmrc/package-lock.json', cleanLock('http-npmrc'));
write('http-npmrc/.npmrc', 'registry=http://registry.npmjs.org/\n');

write('http-npmrc-scoped/package.json', pkg('http-npmrc-scoped'));
write('http-npmrc-scoped/package-lock.json', cleanLock('http-npmrc-scoped'));
write('http-npmrc-scoped/.npmrc', '@foo:registry=http://evil.example/\n');

write('http-publishconfig/package.json', pkg('http-publishconfig', {
  publishConfig: { registry: 'http://registry.npmjs.org/' },
}));
write('http-publishconfig/package-lock.json', cleanLock('http-publishconfig'));

write('http-resolved/package.json', pkg('http-resolved'));
write('http-resolved/package-lock.json', cleanLock('http-resolved', {}, {
  'node_modules/foo': {
    version: '1.0.0',
    resolved: 'http://registry.npmjs.org/foo/-/foo-1.0.0.tgz',
    integrity: INTEGRITY,
  },
}));

write('shrinkwrap-only-clean/package.json', pkg('shrinkwrap-only-clean'));
write('shrinkwrap-only-clean/npm-shrinkwrap.json', cleanLock('shrinkwrap-only-clean'));

write('shrinkwrap-evil/package.json', pkg('shrinkwrap-evil'));
write('shrinkwrap-evil/npm-shrinkwrap.json', cleanLock('shrinkwrap-evil', {}, {
  'node_modules/foo': {
    version: '1.0.0',
    resolved: 'https://evil.example/foo-1.0.0.tgz',
    integrity: INTEGRITY,
  },
}));

write('shrinkwrap-differ/package.json', pkg('shrinkwrap-differ'));
write('shrinkwrap-differ/package-lock.json', cleanLock('shrinkwrap-differ'));
write('shrinkwrap-differ/npm-shrinkwrap.json', cleanLock('shrinkwrap-differ', {}, {
  'node_modules/foo': {
    version: '1.0.0',
    resolved: 'https://evil.example/foo-1.0.0.tgz',
    integrity: INTEGRITY,
  },
}));

write('alt-lock-pnpm/package.json', pkg('alt-lock-pnpm'));
write('alt-lock-pnpm/package-lock.json', cleanLock('alt-lock-pnpm'));
write('alt-lock-pnpm/pnpm-lock.yaml', 'lockfileVersion: "9.0"\n');

write('alt-lock-yarn/package.json', pkg('alt-lock-yarn'));
write('alt-lock-yarn/package-lock.json', cleanLock('alt-lock-yarn'));
write('alt-lock-yarn/yarn.lock', '# yarn lockfile v1\n');

write('abs-path/package.json', pkg('abs-path', { dependencies: { foo: '/x' } }));
write('abs-path/package-lock.json', cleanLock('abs-path'));

write('dot-path/package.json', pkg('dot-path', { dependencies: { foo: './x' } }));
write('dot-path/package-lock.json', cleanLock('dot-path'));

write('ws-valid/package.json', pkg('ws-valid', { workspaces: ['packages/*'] }));
write('ws-valid/packages/a/package.json', pkg('a'));
write('ws-valid/package-lock.json', lock('ws-valid', {
  'node_modules/a': { resolved: 'packages/a', link: true },
  'packages/a': { name: 'a', version: '1.0.0' },
}));

write('ws-bad-registry/package.json', pkg('ws-bad-registry', { workspaces: ['packages/*'] }));
write('ws-bad-registry/packages/a/package.json', pkg('a'));
write('ws-bad-registry/package-lock.json', lock('ws-bad-registry', {
  'node_modules/a': { resolved: 'packages/a', link: true },
  'packages/a': {
    name: 'a',
    version: '1.0.0',
    resolved: 'https://evil.example/a-1.0.0.tgz',
    integrity: INTEGRITY,
  },
}));

write('ws-escape/package.json', pkg('ws-escape', { workspaces: ['packages/*'] }));
write('ws-escape/package-lock.json', lock('ws-escape', {
  'node_modules/a': { resolved: '../outside', link: true },
}));

write('inbundle-ok/package.json', pkg('inbundle-ok'));
write('inbundle-ok/package-lock.json', cleanLock('inbundle-ok', {}, {
  'node_modules/b': {
    version: '1.0.0',
    resolved: NPM_B,
    integrity: INTEGRITY,
  },
  'node_modules/b/node_modules/c': {
    version: '1.0.0',
    inBundle: true,
  },
}));

write('inbundle-bad-parent/package.json', pkg('inbundle-bad-parent'));
write('inbundle-bad-parent/package-lock.json', cleanLock('inbundle-bad-parent', {}, {
  'node_modules/b': {
    version: '1.0.0',
    resolved: 'https://evil.example/b-1.0.0.tgz',
    integrity: INTEGRITY,
  },
  'node_modules/b/node_modules/c': {
    version: '1.0.0',
    inBundle: true,
  },
}));

write('shrinkwrap-malformed/package.json', pkg('shrinkwrap-malformed'));
write('shrinkwrap-malformed/npm-shrinkwrap.json', '{nope\n');

write('shrinkwrap-v1/package.json', pkg('shrinkwrap-v1'));
write('shrinkwrap-v1/npm-shrinkwrap.json', {
  name: 'shrinkwrap-v1',
  lockfileVersion: 1,
  dependencies: {},
});

write('shrinkwrap-canon-equal/package.json', pkg('shrinkwrap-canon-equal'));
{
  const canon = cleanLock('shrinkwrap-canon-equal', {}, {
    'node_modules/foo': {
      version: '1.0.0',
      resolved: NPM_FOO,
      integrity: INTEGRITY,
    },
  });
  write('shrinkwrap-canon-equal/package-lock.json', canon);
  const reordered = {
    name: canon.name,
    lockfileVersion: canon.lockfileVersion,
    requires: canon.requires,
    version: canon.version,
    packages: {
      'node_modules/foo': canon.packages['node_modules/foo'],
      '': canon.packages[''],
    },
  };
  write('shrinkwrap-canon-equal/npm-shrinkwrap.json', reordered);
}

write('both-equal-but-evil/package.json', pkg('both-equal-but-evil'));
{
  const evil = cleanLock('both-equal-but-evil', {}, {
    'node_modules/foo': {
      version: '1.0.0',
      resolved: 'https://evil.example/foo-1.0.0.tgz',
      integrity: INTEGRITY,
    },
  });
  write('both-equal-but-evil/package-lock.json', evil);
  write('both-equal-but-evil/npm-shrinkwrap.json', evil);
}

write('uppercase-http/package.json', pkg('uppercase-http'));
write('uppercase-http/package-lock.json', cleanLock('uppercase-http'));
write('uppercase-http/.npmrc', 'registry=HTTP://evil.example/\n');

write('crlf/package.json', pkg('crlf'));
write('crlf/package-lock.json', cleanLock('crlf'));
write('crlf/.npmrc', 'registry=http://evil.example/\r\n');

write('userinfo/package.json', pkg('userinfo'));
write('userinfo/package-lock.json', cleanLock('userinfo'));
write('userinfo/.npmrc', 'registry=https://user:pass@registry.npmjs.org/\n');

write('protocol-relative/package.json', pkg('protocol-relative'));
write('protocol-relative/package-lock.json', cleanLock('protocol-relative'));
write('protocol-relative/.npmrc', 'registry=//registry.npmjs.org/\n');

write('interpolated-values/package.json', pkg('interpolated-values'));
write('interpolated-values/package-lock.json', cleanLock('interpolated-values'));
write('interpolated-values/.npmrc', 'registry=${INTERP_REG}\n');

write('argv-skip/package.json', pkg('argv-skip'));
write('argv-skip/package-lock.json', cleanLock('argv-skip'));

write('n8-quoted-registry-key/package.json', pkg('n8-quoted-registry-key'));
write('n8-quoted-registry-key/package-lock.json', cleanLock('n8-quoted-registry-key'));
write('n8-quoted-registry-key/.npmrc', '"registry"=http://evil.example/\n');

write('n13-quoted-scoped-key/package.json', pkg('n13-quoted-scoped-key'));
write('n13-quoted-scoped-key/package-lock.json', cleanLock('n13-quoted-scoped-key'));
write('n13-quoted-scoped-key/.npmrc', '"@foo:registry"=http://evil.example/\n');

write('d1-key-dotdot-outside/package.json', pkg('d1-key-dotdot-outside'));
write('d1-key-dotdot-outside/package-lock.json', cleanLock('d1-key-dotdot-outside', {}, {
  '../outside': {
    version: '1.0.0',
    resolved: NPM_FOO,
    integrity: INTEGRITY,
  },
}));

write('d2-key-tmp-outside/package.json', pkg('d2-key-tmp-outside'));
write('d2-key-tmp-outside/package-lock.json', cleanLock('d2-key-tmp-outside', {}, {
  '/tmp/outside': {
    version: '1.0.0',
    resolved: NPM_FOO,
    integrity: INTEGRITY,
  },
}));

write('d6-symlink-to-tmp/package.json', pkg('d6-symlink-to-tmp'));
write('d6-symlink-to-tmp/package-lock.json', cleanLock('d6-symlink-to-tmp', {}, {
  'packages/a': {
    version: '1.0.0',
    resolved: NPM_A,
    integrity: INTEGRITY,
  },
}));

write('link-dotdot/package.json', pkg('link-dotdot'));
write('link-dotdot/package-lock.json', cleanLock('link-dotdot', {}, {
  'node_modules/a': { resolved: '../outside', link: true },
}));

write('link-dotdot-evil/package.json', pkg('link-dotdot-evil'));
write('link-dotdot-evil/package-lock.json', cleanLock('link-dotdot-evil', {}, {
  'node_modules/a': {
    resolved: '../outside',
    link: true,
    integrity: INTEGRITY,
  },
}));

write('link-file-dotdot-evil/package.json', pkg('link-file-dotdot-evil'));
write('link-file-dotdot-evil/package-lock.json', cleanLock('link-file-dotdot-evil', {}, {
  'packages/local': {
    name: 'local',
    version: '1.0.0',
    resolved: 'file:../outside',
  },
}));

write('link-packages-dotdot-evil/package.json', pkg('link-packages-dotdot-evil'));
write('link-packages-dotdot-evil/package-lock.json', cleanLock('link-packages-dotdot-evil', {}, {
  'packages/../outside': {
    name: 'outside',
    version: '1.0.0',
  },
}));

write('ws-glob-node_modules/package.json', pkg('ws-glob-node_modules', {
  workspaces: ['node_modules/*'],
}));
write('ws-glob-node_modules/package-lock.json', cleanLock('ws-glob-node_modules'));

write('ws-glob-doublestar/package.json', pkg('ws-glob-doublestar', {
  workspaces: ['packages/**'],
}));
write('ws-glob-doublestar/package-lock.json', cleanLock('ws-glob-doublestar'));

write('ws-glob-root-star/package.json', pkg('ws-glob-root-star', {
  workspaces: ['*'],
}));
write('ws-glob-root-star/package-lock.json', cleanLock('ws-glob-root-star'));

write('ws-glob-matches-dotdot/package.json', pkg('ws-glob-matches-dotdot', {
  workspaces: ['packages/foo/../bar'],
}));
write('ws-glob-matches-dotdot/package-lock.json', cleanLock('ws-glob-matches-dotdot'));

write('ws-head-differs-from-base/package.json', pkg('ws-head-differs-from-base', {
  workspaces: ['packages/*'],
}));
write('ws-head-differs-from-base/packages/a/package.json', pkg('a'));
write('ws-head-differs-from-base/package-lock.json', lock('ws-head-differs-from-base', {
  'node_modules/a': { resolved: 'packages/a', link: true },
  'packages/a': { name: 'a', version: '1.0.0' },
}));

write('inbundle-git-under-workspace-parent/package.json', pkg('inbundle-git-under-workspace-parent', {
  workspaces: ['packages/*'],
}));
write('inbundle-git-under-workspace-parent/packages/a/package.json', pkg('a'));
write('inbundle-git-under-workspace-parent/package-lock.json', lock('inbundle-git-under-workspace-parent', {
  'packages/a': { name: 'a', version: '1.0.0' },
  'packages/a/node_modules/evil': {
    version: '1.0.0',
    inBundle: true,
    resolved: 'git+https://evil.example/evil.git',
  },
}));

write('inbundle-git-under-link-parent/package.json', pkg('inbundle-git-under-link-parent', {
  workspaces: ['packages/*'],
}));
write('inbundle-git-under-link-parent/packages/a/package.json', pkg('a'));
write('inbundle-git-under-link-parent/package-lock.json', lock('inbundle-git-under-link-parent', {
  'node_modules/a': { resolved: 'packages/a', link: true },
  'packages/a': { name: 'a', version: '1.0.0' },
  'node_modules/a/node_modules/evil': {
    version: '1.0.0',
    inBundle: true,
    resolved: 'git+https://evil.example/evil.git',
  },
}));

write('inbundle-top-level/package.json', pkg('inbundle-top-level'));
write('inbundle-top-level/package-lock.json', cleanLock('inbundle-top-level', {}, {
  'node_modules/evil': {
    version: '1.0.0',
    inBundle: true,
    resolved: 'git+https://evil.example/evil.git',
  },
}));

write('inbundle-under-clean-parent/package.json', pkg('inbundle-under-clean-parent'));
write('inbundle-under-clean-parent/package-lock.json', cleanLock('inbundle-under-clean-parent', {}, {
  'node_modules/b': {
    version: '1.0.0',
    resolved: NPM_B,
    integrity: INTEGRITY,
  },
  'node_modules/b/node_modules/c': {
    version: '1.0.0',
    inBundle: true,
  },
}));

write('folder-record-resolved-escape/package.json', pkg('folder-record-resolved-escape'));
write('folder-record-resolved-escape/packages/a/package.json', pkg('a'));
write('folder-record-resolved-escape/package-lock.json', lock('folder-record-resolved-escape', {
  'packages/a': {
    name: 'a',
    version: '1.0.0',
    resolved: '../../evil',
  },
}));

write('base-unreadable/package.json', pkg('base-unreadable'));
write('base-unreadable/package-lock.json', cleanLock('base-unreadable'));

write('npm-config-env-scrubbed/package.json', pkg('npm-config-env-scrubbed'));
write('npm-config-env-scrubbed/package-lock.json', cleanLock('npm-config-env-scrubbed'));
write('npm-config-env-scrubbed/.npmrc', 'registry=http://from-npmrc.example/\n');

write('c1-userconfig-env-http/package.json', pkg('c1-userconfig-env-http'));
write('c1-userconfig-env-http/package-lock.json', cleanLock('c1-userconfig-env-http'));
write('c1-userconfig-env-http/userconfig.npmrc', 'registry=http://from-userconfig.example/\n');

write('c1-npm_config_registry-env-http/package.json', pkg('c1-npm_config_registry-env-http'));
write('c1-npm_config_registry-env-http/package-lock.json', cleanLock('c1-npm_config_registry-env-http'));

write('c2-strict-ssl-false/package.json', pkg('c2-strict-ssl-false'));
write('c2-strict-ssl-false/package-lock.json', cleanLock('c2-strict-ssl-false'));
write('c2-strict-ssl-false/.npmrc', 'strict-ssl=false\n');

write('c2-proxy-set/package.json', pkg('c2-proxy-set'));
write('c2-proxy-set/package-lock.json', cleanLock('c2-proxy-set'));
write('c2-proxy-set/.npmrc', 'proxy=http://127.0.0.1:9\n');

write('c2-replace-registry-host/package.json', pkg('c2-replace-registry-host'));
write('c2-replace-registry-host/package-lock.json', cleanLock('c2-replace-registry-host'));
write('c2-replace-registry-host/.npmrc', 'replace-registry-host=always\n');

write('c5-glob-matches-symlink-out/package.json', pkg('c5-glob-matches-symlink-out', {
  workspaces: ['packages/*'],
}));
write('c5-glob-matches-symlink-out/packages/ok/package.json', pkg('ok'));
write('c5-glob-matches-symlink-out/package-lock.json', lock('c5-glob-matches-symlink-out', {
  'packages/ok': { name: 'ok', version: '1.0.0' },
}));

write('c7-subdir-lock/package.json', pkg('c7-subdir-lock'));
write('c7-subdir-lock/package-lock.json', cleanLock('c7-subdir-lock'));
write('c7-subdir-lock/packages/nested/package.json', pkg('nested'));
write('c7-subdir-lock/packages/nested/package-lock.json', cleanLock('nested'));

write('c7-bun-lock/package.json', pkg('c7-bun-lock'));
write('c7-bun-lock/package-lock.json', cleanLock('c7-bun-lock'));
write('c7-bun-lock/bun.lock', '{\n  "lockfileVersion": 1\n}\n');

write('c7-bun-lockb/package.json', pkg('c7-bun-lockb'));
write('c7-bun-lockb/package-lock.json', cleanLock('c7-bun-lockb'));
write('c7-bun-lockb/bun.lockb', '\x00bun-lockb\n');

write('c3-dsg-dir-in-pr/package.json', pkg('c3-dsg-dir-in-pr'));
write('c3-dsg-dir-in-pr/package-lock.json', cleanLock('c3-dsg-dir-in-pr'));
write(
  'c3-dsg-dir-in-pr/.dsg/check.mjs',
  '#!/usr/bin/env node\nprocess.exit(0);\n',
);

process.stdout.write('fixtures written\n');
