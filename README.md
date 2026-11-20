# dep-source-guard

Shared dependency-source checker. One self-contained `check.mjs` (Node built-ins only, no network, no skip or env bypass) plus a fixture suite. Nothing is published to npm.

Consumers pin a full 40-character git SHA **and** the sha256 of `check.mjs`. The file is fetched **outside** the repo tree so a committed `.dsg/` cannot replace it (C3).

## Run the suite

```
node test/run.mjs
```

Requires `node` and `npm` on `PATH`. No `package.json` dependencies.

## Consumer step (before `npm ci`)

Fetch at a 40-character SHA into `$RUNNER_TEMP/dsg`, verify the sha256, then run. Do **not** check the file into the consumer tree.

```
DSG_SHA=<40-char-sha>
DSG_SHA256=<sha256-of-check.mjs>
DSG_DIR="$RUNNER_TEMP/dsg"
git init -q "$DSG_DIR"
git -C "$DSG_DIR" fetch -q --depth=1 https://github.com/AgentEconomy/dep-source-guard "$DSG_SHA"
git -C "$DSG_DIR" checkout -q FETCH_HEAD
echo "$DSG_SHA256  $DSG_DIR/check.mjs" | sha256sum -c -
BASE_SHA="${{ github.event.pull_request.base.sha || github.event.before }}"
git fetch --no-tags --depth=1 origin "$BASE_SHA"
node "$DSG_DIR/check.mjs" --root . --base-sha "$BASE_SHA"
```

On a first commit, `github.event.before` is all zeros; the checker treats that as an empty workspace set.

Job names, workflow names, triggers, permissions, and rulesets in consuming repos stay byte-identical. Archive any previous local checker, tests, and fixtures to a **branch or tag** (for example `archive/depcheck-local-20261119`), not an in-tree `archive/` folder (C6). This repo does not change other repositories.

## Codes

| Code | Meaning |
| --- | --- |
| F1 | `npm:` alias |
| F2 | Non-registry spec (git, github, tarball URL, `file:`, path-like) |
| F3 | Lock `resolved` is not on `https://registry.npmjs.org` (C8) |
| F4 | Lock `name` or resolved pathname does not match the path-implied name |
| F5 | Missing integrity |
| F6 | Unsafe registry or transport config (C1, C2, C8) |
| F7 | Structural / fail-closed (malformed lock, v1, extra lockfiles, argv, npm missing) |
| F8 | Path escapes the repo root (C4) |
| F9 | Unsafe or unreadable workspace set (C5) |

The npmjs allowlist is a constant in `check.mjs` (C8): parsed URL, `https:`, host exactly `registry.npmjs.org`, no port, no userinfo. It changes only by an SO-reviewed PR.

C7: any lockfile other than the root `package-lock.json` or `npm-shrinkwrap.json`, at any depth (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, nested locks), fails F7. There are no path exclusions.

When both a root lock and shrinkwrap exist, they must be equal after canonical JSON (parse, deep-equal with sorted keys) (C9).
