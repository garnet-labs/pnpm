// Policy-v2 trusted-host planner. All package-manager/source execution remains
// inside the recorder's nonroot, credential-isolated workload containers.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const join = (dir, file) => dir === '.' ? file : `${dir}/${file}`;
const POETRY = '2.2.1';
const YARN_FALLBACKS = Object.freeze({'4': '2.4.3', '6': '3.8.7', '8': '4.9.2'});

function parents(directory) {
  const result = [];
  for (;;) {
    result.push(directory);
    if (directory === '.') return result;
    directory = path.posix.dirname(directory);
  }
}

function yarnSpec(value) {
  if (value === undefined) return null;
  assert(typeof value === 'string', 'BLOCKED: invalid Yarn packageManager');
  const match = /^yarn@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/.exec(value);
  assert(match, 'BLOCKED: Yarn packageManager must pin a numeric version');
  const major = Number(match[1].split('.')[0]);
  assert(major >= 1 && major <= 4, 'BLOCKED: unreviewed Yarn major version');
  return {version: match[1], major, reference: value};
}

// Bounded workspace globs; unsupported syntax fails instead of silently
// selecting an unrelated ancestor install.
function workspaceMatch(pattern, directory) {
  assert(typeof pattern === 'string' && pattern.length <= 256 &&
    !pattern.startsWith('/') && !pattern.includes('\\') &&
    !/[\x00-\x1f\x7f{}()[\]]/.test(pattern) &&
    !pattern.split('/').includes('..'), 'BLOCKED: unsupported Yarn workspace pattern');
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { regex += '.*'; i++; }
    else if (c === '*') regex += '[^/]*';
    else if (c === '?') regex += '[^/]';
    else regex += c.replace(/[.+^$|]/g, '\\$&');
  }
  return new RegExp(`${regex}/?$`).test(directory);
}

function belongsToWorkspace(pkg, root, directory) {
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
  if (!Array.isArray(patterns)) return false;
  const relative = path.posix.relative(root, directory);
  assert(!relative.startsWith('../'), 'BLOCKED: workspace directory escaped root');
  const include = patterns.filter(p => typeof p === 'string' && !p.startsWith('!'));
  const exclude = patterns.filter(p => typeof p === 'string' && p.startsWith('!')).map(p => p.slice(1));
  return include.some(p => workspaceMatch(p, relative)) && !exclude.some(p => workspaceMatch(p, relative));
}

// Evidence of final unchanged bytes, not a claim to detect transient
// change-and-restore by hostile hooks; package-manager stale-lock checks remain.
const lockBefore = file =>
  `garnet_lock_before=$(/usr/bin/sha256sum ${quote(file)}); readonly garnet_lock_before`;
const lockAfter = "printf '%s\\n' \"$garnet_lock_before\" | /usr/bin/sha256sum --check --status";

/**
 * Additional workload plan, or null to delegate to npm/pnpm/uv/pip/Go/Cargo/Ruby.
 * All reads MUST use the recorder's symlink-safe readSource function.
 */
export function planAdditionalLockfile({root, file, kind, read}) {
  assert(typeof read === 'function', 'Missing trusted source reader');
  const text = (directory, name) => read(root, join(directory, name), true);
  const nearest = (directory, name) => parents(directory).find(p => text(p, name) !== null);
  const pkgAt = directory => JSON.parse(read(root, join(directory, 'package.json')));
  const fileDir = path.posix.dirname(file);
  const noCompetingNodeLocks = directory => {
    assert(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json']
      .every(name => text(directory, name) === null),
    'BLOCKED: competing Node lockfiles require reviewed upstream-workflow manager selection; no automatic override');
  };

  if (kind === 'node') {
    const packageDir = nearest(fileDir, 'package.json');
    if (packageDir === undefined) return null;
    const localPkg = pkgAt(packageDir);
    const localSpec = localPkg.packageManager;
    const ownLock = text(packageDir, 'yarn.lock') !== null;
    // Even packageManager is insufficient to waive mixed-lock ambiguity here.
    // An upstream workflow must be reviewed and a separately trusted policy
    // added before such a repo (e.g. mixed npm/Yarn extension) can run.
    if (ownLock) noCompetingNodeLocks(packageDir);
    if (localSpec !== undefined && !String(localSpec).startsWith('yarn@')) {
      assert(!ownLock, 'BLOCKED: Yarn lock conflicts with declared packageManager');
      return null;
    }
    const explicitYarn = localSpec !== undefined;
    const fixture = packageDir.split('/').some(p => /^(?:\.?fixtures|__fixtures__)$/.test(p));
    if (fixture && !explicitYarn && !ownLock) return null;
    const directory = ownLock ? packageDir : nearest(packageDir, 'yarn.lock');
    if (directory === undefined) {
      assert(!explicitYarn, 'BLOCKED: Yarn requires an existing lockfile');
      return null;
    }
    const pkg = pkgAt(directory);
    if (directory !== packageDir && !belongsToWorkspace(pkg, directory, packageDir)) {
      assert(!explicitYarn, 'BLOCKED: Yarn package is not in its ancestor lockfile workspace');
      return null;
    }
    noCompetingNodeLocks(directory);
    assert(path.posix.basename(file) === 'package.json' ||
      (path.posix.basename(file) === 'yarn.lock' && fileDir === directory),
    'BLOCKED: changed lockfile does not belong to the selected Yarn project');
    const spec = yarnSpec(pkg.packageManager);
    if (explicitYarn && directory !== packageDir) {
      const nestedSpec = yarnSpec(localSpec);
      assert(spec && spec.reference === nestedSpec.reference,
        'BLOCKED: conflicting Yarn workspace packageManager versions or integrity');
    }
    const lock = read(root, join(directory, 'yarn.lock'));
    const modern = /(?:^|\n)__metadata:\s*(?:\r?\n|$)/.test(lock);
    const classic = /(?:^|\n)# yarn lockfile v1(?:\r?\n|$)/.test(lock);
    assert(modern !== classic, 'BLOCKED: unknown or ambiguous Yarn lockfile format');
    const metadata = modern ? /(?:^|\n)__metadata:\s*\r?\n((?:[ \t]+[^\n]*\n?)*)/.exec(lock)?.[1] : '';
    const lockVersion = modern ? /^\s+version:\s*["']?(\d+)["']?\s*$/m.exec(metadata || '')?.[1] : '1';
    const version = spec?.version ?? (classic ? '1.22.22' : YARN_FALLBACKS[lockVersion]);
    assert(version, 'BLOCKED: unknown modern Yarn lock version requires packageManager');
    const major = Number(version.split('.')[0]);
    assert((major === 1 && classic) || (major >= 2 && modern), 'BLOCKED: Yarn version/lockfile format mismatch');
    const fallback = spec ? 'packageManager respected' :
      `explicit fallback yarn@${version} from ${classic ? 'classic v1 lock' : `modern metadata version ${lockVersion}`}`;
    return {
      directory, locked: true,
      commands: [
        lockBefore('yarn.lock'),
        // Export (not command-local) so bare `yarn` in lifecycle subprocesses
        // uses the same selected global Corepack release and ignores yarnPath.
        'export COREPACK_ENABLE_PROJECT_SPEC=0 COREPACK_DEFAULT_TO_LATEST=0 YARN_IGNORE_PATH=1',
        `corepack install --global ${quote(spec?.reference ?? `yarn@${version}`)}`,
        'mkdir -p /home/workload/.local/bin',
        'corepack enable --install-directory /home/workload/.local/bin yarn',
        major === 1
          ? 'corepack yarn install --frozen-lockfile --non-interactive --production=false'
          : 'corepack yarn install --immutable',
        lockAfter,
      ],
      scope: 'yarn-locked-install-with-lifecycle-hooks-no-explicit-workspace-build',
      note: `${fallback}; writable Yarn shim; Corepack project reselection/latest lookup and yarnPath delegation disabled for install and inherited lifecycle environment; lifecycle/workspace hooks retained if configured; no separate workspace build; final lock bytes checked`,
    };
  }

  if (kind === 'python' && /^(pyproject\.toml|poetry\.lock|uv\.lock)$/.test(path.posix.basename(file))) {
    const directory = nearest(fileDir, 'pyproject.toml');
    if (directory === undefined || text(directory, 'poetry.lock') === null) return null;
    assert(text(directory, 'uv.lock') === null, 'BLOCKED: both uv.lock and poetry.lock require an explicit ecosystem policy');
    assert(path.posix.basename(file) === 'pyproject.toml' || fileDir === directory,
      'BLOCKED: changed Poetry lock is not at the selected project root');
    const lock = read(root, join(directory, 'poetry.lock'));
    const metadata = /(?:^|\n)\[metadata\]\s*\r?\n([\s\S]*?)(?=\n\[|$)/.exec(lock)?.[1] || '';
    const lockVersion = /^\s*lock-version\s*=\s*["'](\d+\.\d+)["']\s*$/m.exec(metadata)?.[1];
    assert(['1.1', '2.0', '2.1'].includes(lockVersion), 'BLOCKED: unreviewed Poetry lockfile format');
    const poetry = 'POETRY_NO_INTERACTION=1 POETRY_VIRTUALENVS_CREATE=true POETRY_VIRTUALENVS_IN_PROJECT=true poetry';
    return {
      directory, locked: true,
      commands: [
        lockBefore('poetry.lock'),
        `python -m pip install --user poetry==${POETRY}`,
        `${poetry} check --lock`,
        `${poetry} sync --no-root --no-directory --all-groups`,
        lockAfter,
      ],
      scope: 'poetry-locked-all-groups-no-root-or-directory-builds',
      note: `Poetry ${POETRY}, lock format ${lockVersion}; stale locks fail check; all groups including optional groups; root/directory dependencies excluded; extras not automatically enabled; final lock bytes checked`,
    };
  }
  return null;
}

// Reviewed Bun workspace and exact-pair Python image support.
// Pure bounded source-data inspection; no new imports or source execution.
const remainingAssert = (ok, message) => { if (!ok) throw new Error(`BLOCKED: ${message}`); };
const remainingJoin = (a, b) => a === '.' ? b : `${a}/${b}`;
const remainingParent = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
const remainingAncestors = p => {
  const out = [];
  for (;;) {
    out.push(p);
    if (p === '.') return out;
    p = remainingParent(p);
  }
};

export function reviewedImageTag(snapshot, kind, defaultTag) {
  if (kind !== 'python' || snapshot.repository !== 'garnet-labs/gradio-test' ||
      !snapshot.manifests.includes('test/requirements.txt')) return defaultTag;
  remainingAssert(snapshot.baseline_sha === '55041996db69b086ee2a5116ad3db40bced6b056' &&
    snapshot.head?.sha === '36f97efa0200792ebc2b1fea5f32f2cd28efc5eb' &&
    snapshot.manifests.length === 1,
  'Gradio Python 3.10 recipe is reviewed only for this exact source pair and workload');
  // CI test-python.yml explicitly passes python_version: "3.10".
  // Resolve this tag ONCE to linux/amd64 digest, then reuse/verify on both sides.
  return 'python:3.10-bookworm';
}

function remainingWorkspaceMatch(pattern, directory) {
  remainingAssert(typeof pattern === 'string' && pattern.length > 0 && pattern.length <= 512 &&
    !pattern.startsWith('/') && !pattern.includes('\\') &&
    !pattern.split('/').some(x => x === '..' || x === '.' || !x) &&
    /^[A-Za-z0-9_.*@/-]+$/.test(pattern), 'unsupported Bun workspace glob');
  const pieces = pattern.split('/');
  const target = directory.split('/');
  remainingAssert(pieces.length <= 30 && pieces.every(p => !p.includes('*') || ['*', '**'].includes(p)),
    'unsupported Bun workspace glob segment');
  const memo = new Map();
  const compute = (i, j) => {
    if (i === pieces.length) return j === target.length;
    if (pieces[i] === '**') return match(i + 1, j) || j < target.length && match(i, j + 1);
    if (j === target.length) return false;
    return (pieces[i] === '*' || pieces[i] === target[j]) && match(i + 1, j + 1);
  };
  const match = (i, j) => {
    const key = `${i}:${j}`;
    if (!memo.has(key)) memo.set(key, compute(i, j));
    return memo.get(key);
  };
  return match(0, 0);
}

function remainingMember(pkg, rootDirectory, member) {
  if (rootDirectory === member) return true;
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
  if (!Array.isArray(patterns)) return false;
  const relative = rootDirectory === '.' ? member : member.slice(rootDirectory.length + 1);
  remainingAssert(patterns.length <= 100 && relative.split('/').length <= 30,
    'Bun workspace pattern bounds exceeded');
  const positives = [], negatives = [];
  for (const p of patterns) {
    remainingAssert(typeof p === 'string', 'invalid Bun workspace pattern');
    if (p.startsWith('!')) negatives.push(p.slice(1)); else positives.push(p);
  }
  return positives.some(p => remainingWorkspaceMatch(p, relative)) &&
    !negatives.some(p => remainingWorkspaceMatch(p, relative));
}

// Bun's current text lock uses JSON with trailing commas. Do not evaluate it
// or regex-rewrite commas embedded in package names/URLs. Unsupported comment
// syntax fails closed; this intentionally is not a generic Bun lock parser.
function remainingLockData(text) {
  let clean = '', string = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (string) {
      clean += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') string = false;
    } else if (c === '"') {
      string = true; clean += c;
    } else if (c === ',') {
      let next = i + 1;
      while (/\s/.test(text[next] || '') && next < text.length) next++;
      if (!['}', ']'].includes(text[next])) clean += c;
    } else clean += c;
  }
  let data;
  try { data = JSON.parse(clean); } catch { throw new Error('BLOCKED: unsupported Bun lock JSON data'); }
  remainingAssert(data?.lockfileVersion === 1 && data.workspaces &&
    typeof data.workspaces === 'object' && !Array.isArray(data.workspaces), 'unsupported Bun text lock schema');
  return data;
}

function remainingManifestLocked(lock, directory, pkg) {
  const data = lock.workspaces[directory];
  remainingAssert(data && typeof data === 'object', 'Bun lock is missing a selected workspace');
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const canonical = object => {
      remainingAssert(object && typeof object === 'object' && !Array.isArray(object) &&
        Object.values(object).every(x => typeof x === 'string'), 'invalid Bun dependency specification');
      return JSON.stringify(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
    };
    remainingAssert(canonical(pkg[section] || {}) === canonical(data[section] || {}),
      'stale Bun lock: selected workspace dependency specs differ from its immutable manifest; no dependency edits permitted');
  }
}

export function planBunLockfile({root, file, kind, read}) {
  if (kind !== 'node') return null;
  const original = remainingParent(file);
  const readAt = (dir, name) => read(root, remainingJoin(dir, name), true);
  const packageDir = remainingAncestors(original).find(dir => readAt(dir, 'package.json') !== null);
  if (packageDir === undefined) return null;
  const member = JSON.parse(readAt(packageDir, 'package.json'));
  const explicitBun = typeof member.packageManager === 'string' && member.packageManager.startsWith('bun@');
  let candidate;
  for (const dir of remainingAncestors(packageDir)) {
    const textLock = readAt(dir, 'bun.lock'), binaryLock = readAt(dir, 'bun.lockb');
    if (textLock === null && binaryLock === null) continue;
    const manifest = readAt(dir, 'package.json');
    remainingAssert(manifest !== null, 'Bun lockfile has no package manifest');
    const pkg = JSON.parse(manifest);
    if (!remainingMember(pkg, dir, packageDir)) continue;
    candidate = {dir, pkg, textLock, binaryLock};
    break;
  }
  if (!candidate) {
    remainingAssert(!explicitBun && !/\/?bun\.lockb?$/.test(file), 'Bun frozen install requires its owning lockfile');
    return null;
  }
  const {dir, pkg, textLock, binaryLock} = candidate;
  remainingAssert(binaryLock === null && textLock !== null, 'only reviewed Bun text locks are supported');
  const lockData = remainingLockData(textLock);
  // A nested competing manifest/lock must never cause an npm fallback after
  // ancestor selection. Cross-manager and mixed-lock cases require review.
  const chain = remainingAncestors(packageDir).slice(0, remainingAncestors(packageDir).indexOf(dir) + 1);
  for (const d of chain) {
    for (const lock of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json']) {
      remainingAssert(readAt(d, lock) === null, 'competing Node managers on Bun workspace selection path');
    }
    const data = readAt(d, 'package.json');
    if (data !== null) {
      const manager = JSON.parse(data).packageManager;
      remainingAssert(manager === undefined || manager === 'bun@1.3.11',
        'Bun version/manager requires an explicitly reviewed numeric version');
    }
  }
  if (pkg.packageManager === undefined && member.packageManager === undefined) {
    // Source-backed fallback ONLY for the bounded 1.3.11 pin observed in this
    // repository's immutable CI, not a version inferred from @types/bun.
    const pin = read(root, '.github/workflows/agent-tarballs.yml', true) || '';
    const test = read(root, '.github/workflows/test.yml', true) || '';
    remainingAssert(/bun-version:\s*["']1\.3\.11["']/.test(pin) &&
      /uses:\s*oven-sh\/setup-bun@/.test(pin) && /run:\s*bun install\s*(?:\r?\n|$)/.test(test),
    'unversioned Bun project requires a reviewed CI version; no latest fallback');
  }
  remainingManifestLocked(lockData, '', pkg);
  remainingManifestLocked(lockData, dir === packageDir ? '' :
    dir === '.' ? packageDir : packageDir.slice(dir.length + 1), member);
  return {
    directory: dir, locked: true,
    scope: 'bun-locked-workspace-install-with-lifecycle-hooks-and-pinned-toolchain-bootstrap',
    commands: [
      // Bootstrap in /tmp, not the source directory: do not load project npm
      // config while acquiring the bounded runtime. Intended Bun/npm bootstrap
      // lifecycle is retained, and no credentials are forwarded by the wrapper.
      "(cd /tmp && npm install --global --prefix /home/workload/bun-toolchain --registry https://registry.npmjs.org --no-audit --no-fund 'bun@1.3.11')",
      'export PATH="/home/workload/bun-toolchain/bin:$PATH"',
      'test "$(bun --version)" = "1.3.11"',
      'bun_lock_before="$(sha256sum bun.lock)"',
      'bun install --frozen-lockfile',
      'test "$bun_lock_before" = "$(sha256sum bun.lock)"',
    ],
    note: 'Bun 1.3.11 verified against source CI/release and asserted at execution; true owning workspace root; frozen lock and byte-identity check; source-defined lifecycle/trustedDependencies retained (not force-trusted); no tests/build command; stricter immutable-install verification than upstream plain bun install; stale locks block here, not a claim upstream CI cannot regenerate its lock',
  };
}

export function assertNoUnselectedBun({root, directory, selected, read}) {
  if (read(root, remainingJoin(directory, 'bun.lock'), true) !== null ||
      read(root, remainingJoin(directory, 'bun.lockb'), true) !== null) {
    remainingAssert(selected?.scope?.startsWith('bun-locked-'), 'final selected Bun root must not fall through to npm/pnpm/Yarn');
  }
}

// Source-bound Python policy; metadata describes requirements, not observation.
export const REVIEWED_PYTHON_RUNTIME_VERSION = 1;
const pyRuntimeAssert = (ok, text) => { if (!ok) throw new Error(`BLOCKED: ${text}`); };
const pyRuntimeEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pyRuntimeCases = Object.freeze({
  'garnet-labs/anthropic-sdk-python': {
    id: 'anthropic-pr11-uv0102-dev-all-extras-python312-v1',
    repository_id: '1206647001', pr_number: 11,
    base: '9a547ef9903f83e8a34556711533802f538fa069', head: '5644d1642f3396d3743265f4b75ea1ddc7cf2590',
    uv: '0.10.2', groups: ['dev'], extras: ['aiohttp', 'vertex', 'aws', 'bedrock', 'mcp'],
    excluded_groups: ['pydantic-v1', 'pydantic-v2'],
    image: {tag: 'python:3.12-bookworm', digest: null, platform: 'linux/amd64'}, glibc_min: null,
    authority: {
      'pyproject.toml': '0160d27fd7f3c22df5cc7796f576d6eb63db3fb3',
      '.python-version': '43077b246094f0b2ea3a54995d76fe1d320945a1',
      '.github/workflows/ci.yml': 'e4c0a290ad62253f28f62772a9c7953c6e54f92c',
      'scripts/bootstrap': '4638ec6943c1ea4e94adece7f618d29d6eb3e3b4',
      'scripts/test': '03fce0b927214edaad9a639cd89592bf31c45b31',
    },
    locks: {
      '9a547ef9903f83e8a34556711533802f538fa069': '124bb8838f55fcb483c8ef3a3929d63d4afccbb7',
      '5644d1642f3396d3743265f4b75ea1ddc7cf2590': 'ab925c616094d938e0fb738b2a79030148788ae6',
    },
    native_install: 'uv sync --all-extras (default dev); test script separately selects pydantic-v1 without mcp',
    native_scope: 'Dependency-selection subset only: one source-supported Python 3.12 interpreter, not native 3.9/3.14 test variants, project build, mock server or pytest',
    caution: 'Base uv.lock editable anthropic version is 0.88.0 while pyproject version is 0.93.0; retain uv lock --check and report any stale-baseline failure',
  },
  'garnet-labs/openshell-deepagent': {
    id: 'openshell-pr17-python31214-trixie-glibc239-uv0822-v1',
    repository_id: '1206669469', pr_number: 17,
    base: '1fae50e4daa9f9381a51cf19aa84645c5c2367d5', head: '0eb44370ff6d22ebc08f57afab977bda97267c92',
    uv: '0.8.22', groups: [], extras: [], excluded_groups: [],
    image: {tag: 'python:3.12.14-trixie',
      digest: 'python@sha256:dabc147823ae8fd8cf9799a80f9e4ddb67eb2238fb9ca5f2ffc774c13a1d59d0',
      platform: 'linux/amd64'}, glibc_min: '2.39',
    authority: {'pyproject.toml': '5ce526f0f9fac5410f83f87a56387e58128e3747', 'README.md': '86d3211c0038ba4df469fccf44b319d3979a523f'},
    locks: {
      '1fae50e4daa9f9381a51cf19aa84645c5c2367d5': '1febe372bf6100f71959847125487d1adf4cab99',
      '0eb44370ff6d22ebc08f57afab977bda97267c92': 'd3e544c9329caba7c6c5e70b1ccbf7e0fc82781a',
    },
    native_install: 'README uv sync; source defines no dependency groups or optional extras',
    native_scope: 'External dependency install only; no OpenShell gateway, Docker/k3s sandbox, agent execution, local project build or tests. Fork Garnet CI Python 3.11 conflicts with source >=3.12 and is not used as runtime authority',
    caution: 'Wheel ABI compatibility is source/manifest-backed and checked at execution; image and complete workload have not been run in this proposal',
  },
});
function pyRuntimeCase(snapshot) {
  const rule = pyRuntimeCases[snapshot?.repository];
  if (!rule) return null;
  pyRuntimeAssert(snapshot.repository_id === rule.repository_id && snapshot.pr_number === rule.pr_number &&
    snapshot.baseline_sha === rule.base && snapshot.head?.sha === rule.head && snapshot.base?.sha === rule.base &&
    snapshot.head.repository === snapshot.repository && snapshot.base.repository === snapshot.repository &&
    snapshot.head.repository_id === rule.repository_id && snapshot.base.repository_id === rule.repository_id &&
    pyRuntimeEqual(snapshot.manifests, ['uv.lock']) && pyRuntimeEqual(snapshot.changed_files, ['uv.lock']),
  'Python runtime/group policy requires the reviewed repository ID, PR, exact pair and sole root uv.lock');
  return rule;
}
export function reviewedPythonRuntimeImage(snapshot, kind) {
  if (kind !== 'python') return null;
  const rule = pyRuntimeCase(snapshot);
  return rule ? structuredClone(rule.image) : null;
}
export function validateReviewedPythonImage(snapshot, kind, image) {
  const expected = reviewedPythonRuntimeImage(snapshot, kind);
  if (!expected) return;
  pyRuntimeAssert(image?.tag === expected.tag && image.platform === expected.platform, 'Python runtime image tag/platform mismatch');
  if (expected.digest) pyRuntimeAssert(image.digest === expected.digest, 'Python runtime requires the reviewed official image digest');
}
function pyRuntimeCommands(rule) {
  const check = rule.glibc_min
    ? "import os,sys,platform; assert sys.version_info[:3] == (3,12,14); assert platform.machine() == 'x86_64'; libc=os.confstr('CS_GNU_LIBC_VERSION'); assert libc.startswith('glibc '); assert tuple(map(int,libc.split()[1].split('.')[:2])) >= (2,39); print(sys.version.split()[0],libc)"
    : "import sys; assert sys.version_info[:2] == (3,12); print(sys.version.split()[0])";
  const selection = rule.groups.length ? '--group dev --all-extras ' : '';
  return [
    'py_lock_before="$(/usr/bin/sha256sum uv.lock pyproject.toml)"; readonly py_lock_before',
    `/usr/local/bin/python3 -I -c "${check}"`,
    `python -m pip install --user uv==${rule.uv}`,
    `py_uv_version="$(uv --version)"; case "$py_uv_version" in 'uv ${rule.uv}'|'uv ${rule.uv} ('*) ;; *) exit 78 ;; esac`,
    'export UV_PYTHON=/usr/local/bin/python3 UV_PYTHON_DOWNLOADS=never',
    'uv lock --check --python /usr/local/bin/python3',
    `uv sync --frozen --no-default-groups ${selection}--no-install-workspace --python /usr/local/bin/python3`,
    'test "$py_lock_before" = "$(/usr/bin/sha256sum uv.lock pyproject.toml)"',
  ];
}
export function reviewedPythonRuntimeContract(snapshot, executedSha) {
  const rule = pyRuntimeCase(snapshot);
  if (!rule) return null;
  pyRuntimeAssert([rule.base, rule.head].includes(executedSha), 'Python policy executed SHA is outside reviewed pair');
  return {
    version: REVIEWED_PYTHON_RUNTIME_VERSION, policy_id: rule.id,
    repository: snapshot.repository, repository_id: rule.repository_id, pr_number: rule.pr_number,
    baseline_sha: rule.base, head_sha: rule.head, executed_sha: executedSha,
    authority_blobs: {...rule.authority, 'uv.lock': rule.locks[executedSha]},
    uv_version: rule.uv, python: '3.12', interpreter: '/usr/local/bin/python3',
    python_downloads: 'never', image: structuredClone(rule.image), glibc_min: rule.glibc_min,
    default_groups: false, selected_groups: [...rule.groups], selected_extras: [...rule.extras],
    excluded_groups: [...rule.excluded_groups], local_project_install: false, lock_check: true,
    frozen_sync: true, lock_and_pyproject_byte_identity: true,
    native_install: rule.native_install, scope_limit: rule.native_scope, caveat: rule.caution,
  };
}
export function planReviewedPythonRuntime({root, file, kind, context, read, blob}) {
  if (kind !== 'python') return null;
  const rule = pyRuntimeCase(context?.snapshot);
  if (!rule) return null;
  pyRuntimeAssert(file === 'uv.lock', 'Reviewed Python plan cannot select a nested/unreviewed workload');
  const contract = reviewedPythonRuntimeContract(context.snapshot, context.executed_sha);
  for (const [name, hash] of Object.entries(contract.authority_blobs)) {
    pyRuntimeAssert(blob(read(root, name)) === hash, 'Reviewed Python authority or exact lock bytes changed');
  }
  for (const name of ['uv.toml', 'poetry.lock']) pyRuntimeAssert(read(root, name, true) === null, 'Unreviewed Python config or competing lock');
  return {directory: '.', locked: true, commands: pyRuntimeCommands(rule),
    scope: 'reviewed-uv-locked-selected-dependencies-no-workspace-install',
    note: `${rule.native_scope}; ${rule.caution}`, python_runtime_policy: contract};
}
export function validateReviewedPythonRuntimeWorkloads(receipt, snapshot, images) {
  const rule = pyRuntimeCase(snapshot);
  if (!rule) {
    pyRuntimeAssert(receipt.workloads.every(w => w.python_runtime_policy === undefined), 'Unreviewed workload asserted Python runtime policy');
    return [];
  }
  const expected = reviewedPythonRuntimeContract(snapshot, receipt.executed_sha);
  pyRuntimeAssert(receipt.workloads.length === 1, 'Reviewed Python policy requires exactly one workload');
  const [w] = receipt.workloads;
  pyRuntimeAssert(w.id === 'python:.:' && w.ecosystem === 'python' && w.directory === '.' &&
    w.locked === true && w.scope === 'reviewed-uv-locked-selected-dependencies-no-workspace-install' &&
    w.note === `${rule.native_scope}; ${rule.caution}` && pyRuntimeEqual(w.changed_manifests, ['uv.lock']) &&
    pyRuntimeEqual(w.commands, pyRuntimeCommands(rule)) && pyRuntimeEqual(w.python_runtime_policy, expected),
  'Reviewed Python workload metadata or exact commands mismatch');
  validateReviewedPythonImage(snapshot, 'python', images.python);
  pyRuntimeAssert(pyRuntimeEqual(receipt.images, images), 'Reviewed Python receipt image map mismatch');
  pyRuntimeAssert(pyRuntimeEqual(w.image, images.python), 'Reviewed Python workload image mismatch');
  return [{workload_id: w.id, ...expected}];
}

// Complete tracked-inventory commitments are inline in the ONE hash-bound
// helper. No runtime policy JSON, extra helper, remote tree lookup or fetch.
const goFail = (ok, text) => { if (!ok) throw new Error(text); };
const goSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const goSha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const goBlob = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
export const GO_COMMANDS = Object.freeze(['GOWORK=off go mod download']);
export const GO_SCOPE = 'reviewed-go-mod-download-with-uninitialized-submodules';
const GO_COHORT = Object.freeze([
  {policy_id: 'go-ethereum-pr10-go-mod-uninitialized-gitlinks-v1',
    repository: 'garnet-labs/go-ethereum', repository_id: '1211000635', pr_number: 10,
    base: '0b054f5690cfc792e7f6814c7b4e2b58e09ab340', head: '9ceffd5e287699760bfdd2463bb2c75167d32ad7',
    sides: {
      base: {revision: '0b054f5690cfc792e7f6814c7b4e2b58e09ab340',
        entries_sha256: '44fb03a848e65bdcb9af8b0f8b464f9e40f981e4eabe6ff1e3b381a6c84067b6', tracked_blob_count: 2365,
        gitlinks: [{path: 'tests/evm-benchmarks', commit_sha: 'd8b88f4046a87d6b902378cef752591f95427b43'},
          {path: 'tests/testdata', commit_sha: '81862e4848585a438d64f911a19b3825f0f4cd95'}],
        go_mod_blob: '37a2537dd04ca0afc5ed98f02993dd2ad1fbc773',
        go_sum_blob: 'c46560324211f839478aaa4f98ef288773a1c8f6',
        gitmodules_blob: '241c169c4772ce246ffa45f7fa8a63019ffea0e1'},
      head: {revision: '9ceffd5e287699760bfdd2463bb2c75167d32ad7',
        entries_sha256: '370f661e29b4ef28bfd4179680e9881a6613ea84dff38534ad0bfe09d20b7bbf', tracked_blob_count: 2365,
        gitlinks: [{path: 'tests/evm-benchmarks', commit_sha: 'd8b88f4046a87d6b902378cef752591f95427b43'},
          {path: 'tests/testdata', commit_sha: '81862e4848585a438d64f911a19b3825f0f4cd95'}],
        go_mod_blob: '663c14fcc08a3117a692387ae25b064b36192f9f',
        go_sum_blob: '24bbf3abeaa8acae2075f0cdc7e6b0f952a3b1d5',
        gitmodules_blob: '241c169c4772ce246ffa45f7fa8a63019ffea0e1'},
    }},
  {policy_id: 'grype-pr8-go-mod-uninitialized-gitlinks-v1',
    repository: 'garnet-labs/grype', repository_id: '1211000051', pr_number: 8,
    base: 'd3e1ec1f4e5dae225c41f4bd7495371010b3995d', head: '6ea85004173bbd667fc9fabd88529a99d04dc39c',
    sides: {
      base: {revision: 'd3e1ec1f4e5dae225c41f4bd7495371010b3995d',
        entries_sha256: '5234c649f67811a96937a6251706b7c3a32a8308e017450e861e02d0e19043b0', tracked_blob_count: 1170,
        gitlinks: [{path: 'test/quality/vulnerability-match-labels', commit_sha: '2dc3c828717741e26e3e780b24a3263cac450926'}],
        go_mod_blob: '668d74ba9e7b966c724831dab7365409138c71bc',
        go_sum_blob: '4ec2372764755b06b54b133a1cf241005b41ae18',
        gitmodules_blob: '21e606b75a5911167d8ab45c2eacafcb9ff9fda2'},
      head: {revision: '6ea85004173bbd667fc9fabd88529a99d04dc39c',
        entries_sha256: 'e205a0cbb9e59a5c87f47ff99e536274e21c42ebbec9d460eb690b73bbc2cff2', tracked_blob_count: 1170,
        gitlinks: [{path: 'test/quality/vulnerability-match-labels', commit_sha: '2dc3c828717741e26e3e780b24a3263cac450926'}],
        go_mod_blob: '6e15e7c5f12f33a518bb6c2e73796ea2d86474c2',
        go_sum_blob: '2e8e1eabccc4534aa5d736d2892b84bedd4a45d9',
        gitmodules_blob: '21e606b75a5911167d8ab45c2eacafcb9ff9fda2'},
    }},
]);
const goManifests = value => Array.isArray(value) && goSame([...value].sort(), ['go.mod', 'go.sum']);
function selectedGo(context) {
  const s = context?.snapshot;
  return GO_COHORT.find(p => s?.repository === p.repository && s.repository_id === p.repository_id &&
    s.pr_number === p.pr_number && s.baseline_sha === p.base && s.head?.sha === p.head &&
    s.base?.repository === p.repository && s.head.repository === p.repository &&
    s.base.repository_id === p.repository_id && s.head.repository_id === p.repository_id &&
    s.comparison_scope === 'merge-base-to-head' && goManifests(s.manifests) &&
    goManifests(s.changed_files) && [p.base, p.head].includes(context.executed_sha));
}
export function expectedGoMaterialization(context) {
  const p = selectedGo(context);
  if (!p) return null; // ALL other cohorts retain the global submodule block.
  const side = p.sides[context.executed_sha === p.base ? 'base' : 'head'];
  return {schema: 1, policy_id: p.policy_id, source_revision: side.revision,
    scope: GO_SCOPE, git_tree_lookup_sha: side.revision,
    tracked_inventory_sha256: side.entries_sha256,
    tracked_superproject_blob_count: side.tracked_blob_count,
    tracked_superproject_blob_bytes_checked: true, recursive_source_complete: false,
    submodule_contents_present: false, submodule_fetch_performed: false,
    git_metadata_excluded: true, host_git_metadata_exposed: false,
    uninitialized_gitlinks: side.gitlinks.map(x => ({...x})),
    go_work_absent: true, replace_directives_absent: true,
    go_mod_blob: side.go_mod_blob, go_sum_blob: side.go_sum_blob, gitmodules_blob: side.gitmodules_blob,
    verification_phase: 'before-workload-not-a-post-execution-immutability-claim'};
}
function normalizedGo(entries) {
  goFail(Array.isArray(entries) && entries.length > 0 && entries.length <= 400000, 'invalid_inventory_size');
  const rows = entries.map(x => {
    goFail(typeof x.path === 'string' && x.path.length > 0 && x.path.length <= 4096 &&
      !x.path.startsWith('/') && !x.path.includes('\\') && !/[\x00-\x1f]/.test(x.path) &&
      x.path.split('/').every(p => p && p !== '.' && p !== '..' && p !== '.git'), 'unsafe_inventory_path');
    goFail(/^[a-f0-9]{40}$/.test(x.sha), 'invalid_inventory_object');
    goFail((['100644', '100755', '120000'].includes(x.mode) && x.type === 'blob') ||
      (x.mode === '160000' && x.type === 'commit'), 'unsupported_inventory_mode');
    return {path: x.path, mode: x.mode, type: x.type, sha: x.sha};
  }).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  goFail(new Set(rows.map(x => x.path)).size === rows.length, 'duplicate_inventory_path');
  return rows;
}
export function parseGoGitTree(text) {
  return normalizedGo(text.split('\0').filter(Boolean).map(line => {
    const m = /^([0-9]{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(line);
    goFail(m, 'invalid_git_inventory_record');
    return {path: m[4], mode: m[1], type: m[2], sha: m[3]};
  }));
}
export function validateStaticInventory(context, actualEntries) {
  const metadata = expectedGoMaterialization(context);
  goFail(metadata, 'unreviewed_go_pair_or_scope');
  const rows = normalizedGo(actualEntries);
  // Matches the reviewed UTF-8 compact full-inventory bytes, not a selection
  // of manifests. Missing/extra/modified ordinary blobs or gitlinks fail.
  goFail(goSha(JSON.stringify(rows)) === metadata.tracked_inventory_sha256, 'exact_source_inventory_mismatch');
  goFail(!rows.some(x => path.posix.basename(x.path) === 'go.work'), 'go_work_present');
  return metadata;
}
export function auditMaterialization(root, expectedEntries, {allowRootGitMetadata = false} = {}) {
  const entries = normalizedGo(expectedEntries), expected = new Map(entries.map(x => [x.path, x]));
  const dirs = new Set(['']);
  for (const e of entries) {
    const parts = e.path.split('/');
    for (let i=1;i<parts.length;i++) dirs.add(parts.slice(0,i).join('/'));
    if (e.mode === '160000') dirs.add(e.path);
  }
  const rootStat = fs.lstatSync(root);
  goFail(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'unsafe_source_root');
  const seen = new Set(); let totalBytes = 0, visited = 0;
  function walk(relative) {
    goFail(++visited <= 400000, 'source_entry_limit');
    const target = relative ? path.join(root, relative) : root;
    const stat = fs.lstatSync(target), entry = expected.get(relative);
    if (entry?.mode === '160000') {
      goFail(stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(target).length === 0, 'gitlink_content_or_symlink_present');
      seen.add(relative); return;
    }
    if (stat.isSymbolicLink()) {
      goFail(entry?.mode === '120000', 'unexpected_source_symlink');
      goFail(goBlob(fs.readlinkSync(target, {encoding: 'buffer'})) === entry.sha, 'symlink_blob_mismatch');
      seen.add(relative); return;
    }
    if (stat.isDirectory()) {
      goFail(dirs.has(relative), 'untracked_source_directory');
      for (const name of fs.readdirSync(target)) {
        if (name === '.git') { goFail(relative === '' && allowRootGitMetadata, 'git_metadata_present_in_copy'); continue; }
        walk(relative ? `${relative}/${name}` : name);
      }
      return;
    }
    goFail(entry && ['100644','100755'].includes(entry.mode) && stat.isFile() && stat.nlink === 1,
      'untracked_special_or_hardlinked_source');
    goFail(Boolean(stat.mode & 0o111) === (entry.mode === '100755'), 'source_executable_mode_mismatch');
    totalBytes += stat.size;
    goFail(stat.size <= 128*1024**2 && totalBytes <= 3*1024**3, 'source_blob_byte_limit');
    goFail(goBlob(fs.readFileSync(target)) === entry.sha, 'source_blob_mismatch');
    seen.add(relative);
  }
  walk('');
  for (const e of entries) if (e.mode !== '160000') goFail(seen.has(e.path), 'missing_tracked_superproject_blob');
  return {checked_blobs: entries.filter(x => x.type === 'blob').length,
    checked_gitlink_pointers: entries.filter(x => x.mode === '160000').length,
    submodule_contents_present: false, recursive_source_complete: false};
}
export function auditPreparedGoCopy(context, root, actualEntries) {
  const metadata = validateStaticInventory(context, actualEntries);
  auditMaterialization(root, actualEntries);
  const bytes = fs.readFileSync(path.join(root, 'go.mod'));
  goFail(!/\breplace\b/.test(bytes.toString('utf8')), 'go_replace_directive_not_reviewed');
  goFail(goBlob(bytes) === metadata.go_mod_blob, 'go_mod_source_mismatch');
  return metadata;
}
export function expectedGoPlan(context) {
  const metadata = expectedGoMaterialization(context);
  goFail(metadata, 'unreviewed_go_pair_or_scope');
  return {id: 'go:.:', ecosystem: 'go', directory: '.', commands: [...GO_COMMANDS],
    scope: GO_SCOPE, locked: true, changed_manifests: ['go.mod','go.sum'], source_materialization: metadata};
}
export function validateGoReceipt(r, snapshot, capability) {
  goFail([0,1,2].includes(capability), 'unknown_reviewed_capability');
  const metadata = expectedGoMaterialization({snapshot, executed_sha: r.executed_sha});
  if (capability < 2 || !metadata) {
    goFail(!Object.hasOwn(r, 'source_materialization') &&
      (r.workloads || []).every(w => !Object.hasOwn(w, 'source_materialization') && w.scope !== GO_SCOPE),
    'unbound_go_materialization_claim');
    return null;
  }
  goFail(r.reviewed_exceptions_version === 2, 'go_receipt_capability_mismatch');
  goFail(['base','head'].includes(r.side) &&
    r.executed_sha === (r.side === 'base' ? snapshot.baseline_sha : snapshot.head.sha), 'go_side_revision_mismatch');
  goFail(goSame(r.source_materialization, metadata), 'go_receipt_materialization_mismatch');
  goFail(Array.isArray(r.workloads) && r.workloads.length === 1, 'go_workload_count_mismatch');
  const w = r.workloads[0], plan = expectedGoPlan({snapshot, executed_sha: r.executed_sha});
  for (const key of Object.keys(plan)) goFail(goSame(w[key],plan[key]), `go_workload_${key}_mismatch`);
  return {schema: 1, policy_id: metadata.policy_id, source_revision: metadata.source_revision,
    tracked_inventory_sha256: metadata.tracked_inventory_sha256,
    recursive_source_complete: false, submodule_contents_present: false, source_materialization_checked: true};
}


// Append to the existing hash-bound helper; never create an untracked runtime helper.
export const REVIEWED_DIRECTORY_EMPTY_GIT_VERSION = 1;
const dcAssert = (ok, message) => { if (!ok) throw new Error(`BLOCKED: ${message}`); };
const dcEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dcHash = value => crypto.createHash('sha256').update(value).digest('hex');
const dcRule = Object.freeze({
  id: 'directory-connector-pr23-empty-git-node25-npm10-v1',
  repository: 'garnet-labs/directory-connector', repository_id: '1219214388', pr_number: 23,
  base: '499a21ff15ab6685f176031f0bb02de969091e7f', head: 'eb785521e836e327788e0731dac773e7a771468f',
  image: {tag: 'node:25-bookworm', digest: 'node@sha256:0efb427ff710f4943bb3f0641bd3e9ef1ac3cec96c526b67a21b43740becab1f', platform: 'linux/amd64'},
  authority: {
    'package.json': '0ba2ca85b2973c2b34bf7a06c1939840b89a7b00',
    '.nvmrc': 'a682cfb975e0e399490230af930b378b3125f137',
    '.npmrc': '860dc500f0deaed8939cfec299e5f0303a867a9f',
    '.github/workflows/test.yml': '5fd2168d2f15bd3f9098f5f43ad5f3b9f52f1e45',
    'native/package.json': '70103484e61d5cd740c5ebf40d564e0259ca6ca3',
  },
  locks: {
    '499a21ff15ab6685f176031f0bb02de969091e7f': 'ce3555226da4d2eff6d5a137c73a9a84cc54cfa0',
    'eb785521e836e327788e0731dac773e7a771468f': '1ca9203c5507141c4bc68c852a1a592e3f7f7adc',
  },
  inventories: {
    '499a21ff15ab6685f176031f0bb02de969091e7f': '7fa010a57e092bbc193a77146aa47439bba8d4246f78f4c931a9e4aa9e42ae4d',
    'eb785521e836e327788e0731dac773e7a771468f': '7b0461fb0f9569ac9e94d70f6703e6b22b75e6d20cc9bda05003cc1a8ee48d67',
  },
  scope: 'reviewed-npm-ci-with-lifecycle-hooks-and-synthetic-empty-git',
  note: 'Dependency install with existing lifecycle hooks only. Synthetic empty Git metadata is created inside the credential-free container; original host .git is excluded. This is not full-Git or native-CI fidelity: no commits, origin, native-module build, typechecking, tests, app build or packaging is supplied or claimed.',
});
function directoryCase(snapshot) {
  if (snapshot?.repository !== dcRule.repository) return null;
  dcAssert(snapshot.repository_id === dcRule.repository_id && snapshot.pr_number === dcRule.pr_number &&
    snapshot.baseline_sha === dcRule.base && snapshot.base?.sha === dcRule.base && snapshot.head?.sha === dcRule.head &&
    snapshot.base.repository === dcRule.repository && snapshot.head.repository === dcRule.repository &&
    snapshot.base.repository_id === dcRule.repository_id && snapshot.head.repository_id === dcRule.repository_id &&
    dcEqual(snapshot.manifests, ['package-lock.json']) && dcEqual(snapshot.changed_files, ['package-lock.json']),
  'empty-Git exception requires reviewed repository ID, PR, exact source pair and sole root npm lock');
  return dcRule;
}
function directoryExpectedTree(snapshot, executedSha) {
  const rule = directoryCase(snapshot);
  if (!rule) return null;
  dcAssert(Object.hasOwn(rule.inventories, executedSha), 'empty-Git executed SHA is outside the reviewed pair');
  return {scheme: 'git-ls-tree-normalized-v1', executed_sha: executedSha, tracked_entries: 338,
    tree_manifest_sha256: rule.inventories[executedSha], gitlinks: [], gitmodules: []};
}
export function reviewedDirectoryTreeProof({snapshot, executed_sha, raw}) {
  const expected = directoryExpectedTree(snapshot, executed_sha);
  if (!expected) return null;
  dcAssert(typeof raw === 'string' && raw.endsWith('\0'), 'complete NUL-delimited tracked inventory required');
  const seen = new Set();
  const entries = raw.slice(0, -1).split('\0').map(line => {
    const m = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
    dcAssert(m, 'malformed tracked inventory');
    const [, mode, type, sha, path] = m;
    dcAssert(!seen.has(path) && !path.startsWith('/') && !path.split('/').some(x => ['', '.', '..', '.git'].includes(x)),
      'duplicate or unsafe tracked path');
    seen.add(path);
    dcAssert(type === 'blob' && ['100644', '100755', '120000'].includes(mode),
      'gitlinks/submodules are forbidden for the empty-Git policy');
    dcAssert(!path.split('/').includes('.gitmodules'), 'tracked .gitmodules is forbidden for the empty-Git policy');
    return {mode, type, sha, path};
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  dcAssert(entries.length === expected.tracked_entries && dcHash(JSON.stringify(entries)) === expected.tree_manifest_sha256,
    'complete tracked inventory does not match the reviewed immutable source revision');
  return expected;
}
export function reviewedDirectoryImage(snapshot, kind) {
  if (kind !== 'node' || !directoryCase(snapshot)) return null;
  return structuredClone(dcRule.image);
}
export function validateReviewedDirectoryImage(snapshot, kind, image) {
  const expected = reviewedDirectoryImage(snapshot, kind);
  if (expected) dcAssert(dcEqual(image, expected), 'empty-Git Node25 image requires the reviewed digest/tag/platform');
}
function directoryGitGuards() {
  return [
    'test -d .git && test ! -L .git',
    'dc_git_root=$(/usr/bin/git rev-parse --show-toplevel); test "$dc_git_root" = /work',
    'dc_git_remote=$(/usr/bin/git remote); test -z "$dc_git_remote"',
    'dc_git_index=$(/usr/bin/git ls-files); test -z "$dc_git_index"',
    'test -d .git/objects && test ! -L .git/objects; dc_git_objects=$(/usr/bin/find .git/objects ! -type d -print -quit); test -z "$dc_git_objects"',
    'if /usr/bin/git show-ref --head >/dev/null 2>&1; then exit 78; else test "$?" -eq 1; fi',
    'if /usr/bin/git config --local --name-only --get-regexp "^(remote[.]|credential[.]|include[.]|includeif[.])" >/dev/null; then exit 78; else test "$?" -eq 1; fi',
  ];
}
function directoryCommands() {
  return [
    'dc_source_before=$(/usr/bin/sha256sum package-lock.json package.json .nvmrc .npmrc); readonly dc_source_before',
    'test "$(/usr/local/bin/node --version)" = v25.9.0',
    'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0',
    'npm install --global --prefix /home/workload/npm npm@10.9.8',
    'export PATH="/home/workload/npm/bin:$PATH"',
    'test "$(npm --version)" = 10.9.8',
    'test ! -e .git && test ! -L .git && test ! -e .gitmodules && test ! -L .gitmodules',
    'git -c init.templateDir= init',
    ...directoryGitGuards(),
    'npm ci --no-audit --no-fund',
    ...directoryGitGuards(),
    'test ! -e .gitmodules && test ! -L .gitmodules',
    'test "$dc_source_before" = "$(/usr/bin/sha256sum package-lock.json package.json .nvmrc .npmrc)"',
  ];
}
export function reviewedDirectoryContract(snapshot, executedSha) {
  const source_tree = directoryExpectedTree(snapshot, executedSha);
  if (!source_tree) return null;
  return {version: REVIEWED_DIRECTORY_EMPTY_GIT_VERSION, policy_id: dcRule.id,
    repository: dcRule.repository, repository_id: dcRule.repository_id, pr_number: dcRule.pr_number,
    baseline_sha: dcRule.base, head_sha: dcRule.head, executed_sha: executedSha,
    authority_blobs: {...dcRule.authority, 'package-lock.json': dcRule.locks[executedSha]}, source_tree,
    image: structuredClone(dcRule.image), node_version: '25.9.0', npm_version: '10.9.8',
    node_authority: '.nvmrc v25 and engines.node ~25; verified official image supplies exact 25.9.0',
    npm_authority: 'engines.npm ~10; 10.9.8 is an existing official compatible release, not a native CI exact pin',
    synthetic_git_metadata: true, creation_location: 'credential-free-nonroot-workload-container:/work/.git',
    host_git_metadata_copied: false, source_commits_imported: false, remotes: [], index_entries: [],
    initial_templates: 'empty', system_and_global_git_config: 'disabled',
    lifecycle_scripts: 'unchanged-and-enabled', husky: 'unchanged-and-enabled; may set local core.hooksPath normally',
    source_lock_and_manifest_bytes_unchanged_on_success: true,
    full_git_fidelity: false, native_ci_fidelity: false, scope_limit: dcRule.note};
}
export function planReviewedDirectory({root, file, kind, context, read, blob}) {
  if (kind !== 'node' || !directoryCase(context?.snapshot)) return null;
  dcAssert(file === 'package-lock.json', 'empty-Git plan requires sole root npm lock');
  const contract = reviewedDirectoryContract(context.snapshot, context.executed_sha);
  dcAssert(dcEqual(context.directory_tree_proof, contract.source_tree), 'verified complete no-submodule tree proof is missing');
  for (const [name, hash] of Object.entries(contract.authority_blobs))
    dcAssert(blob(read(root, name)) === hash, 'empty-Git authority or side-specific immutable source lock changed');
  for (const name of ['.gitmodules', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'])
    dcAssert(read(root, name, true) === null, 'empty-Git plan found an unreviewed submodule config or competing lock');
  return {directory: '.', commands: directoryCommands(), locked: true, scope: dcRule.scope,
    note: dcRule.note, synthetic_git_policy: contract};
}
export function validateReviewedDirectoryWorkloads(receipt, snapshot, images) {
  const rule = directoryCase(snapshot);
  if (!rule) {
    dcAssert(receipt.workloads.every(w => w.synthetic_git_policy === undefined), 'unreviewed workload asserted synthetic Git policy');
    return [];
  }
  const expected = reviewedDirectoryContract(snapshot, receipt.executed_sha);
  dcAssert(receipt.workloads.length === 1, 'empty-Git policy requires exactly one workload');
  const [w] = receipt.workloads;
  dcAssert(w.id === 'node:.:' && w.ecosystem === 'node' && w.directory === '.' &&
    w.locked === true && w.scope === dcRule.scope && w.note === dcRule.note &&
    dcEqual(w.changed_manifests, ['package-lock.json']) && dcEqual(w.commands, directoryCommands()) &&
    dcEqual(w.synthetic_git_policy, expected), 'empty-Git metadata or exact guarded commands mismatch');
  validateReviewedDirectoryImage(snapshot, 'node', images.node);
  dcAssert(dcEqual(receipt.images, images) && dcEqual(w.image, images.node), 'empty-Git receipt image mismatch');
  return [{workload_id: w.id, ...expected}];
}
