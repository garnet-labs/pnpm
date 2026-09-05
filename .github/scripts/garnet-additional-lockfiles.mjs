// Policy-v2 trusted-host planner. All package-manager/source execution remains
// inside the recorder's nonroot, credential-isolated workload containers.
import path from 'node:path';

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
