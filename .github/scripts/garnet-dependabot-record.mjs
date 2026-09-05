#!/usr/bin/env node
// Trusted host code. No third-party JS dependencies, eval, PR scripts, or shell
// interpolation on the host. All package-manager execution is inside Docker.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planAdditionalLockfile} from './garnet-additional-lockfiles.mjs';

export const POLICY = 'garnet-dependabot-container-v2';
export const ACTION = 'e546567a72e4fede11ec39d6e9f75b539adef22c';
export const SENSOR = 'v2.16.0';
export const IMAGE_TAGS = Object.freeze({
  node: 'node:22-bookworm', python: 'python:3.12-bookworm',
  go: 'golang:1.26-bookworm', rust: 'rust:1-bookworm', ruby: 'ruby:3.3-bookworm',
});
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/;
const MAX_JSON = 128 * 1024 * 1024;
const MAX_LOG = 64 * 1024 * 1024;
const PRIVATE_NETS = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4'];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
// Always derive these from the trusted control checkout, never artifact or PR
// paths. A present-but-replaced helper must not satisfy policy-v2 verification.
export function recorderCodeHashes() {
  return {
    recorder_script_sha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
    recorder_helpers_sha256: {
      '.github/scripts/garnet-additional-lockfiles.mjs':
        digest(fs.readFileSync(new URL('./garnet-additional-lockfiles.mjs', import.meta.url))),
    },
  };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`;
const json = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, {mode: 0o600});
const envJSON = name => JSON.parse(process.env[name] || 'null');
const ancestors = dir => {
  const result = [];
  for (;;) {
    result.push(dir);
    if (dir === '.') return result;
    dir = path.posix.dirname(dir);
  }
};

export function safePath(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !value.startsWith('/') && !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value) &&
    value.split('/').every(p => p && !['.', '..', '.git'].includes(p)), 'Unsafe source path');
  return value;
}

export function validateSnapshot(s) {
  assert(s?.schema === 1 && /^garnet-labs\/[A-Za-z0-9_.-]+$/.test(s.repository), 'Invalid repository');
  assert(/^[1-9]\d*$/.test(s.repository_id) && /^[1-9]\d*$/.test(s.owner_id), 'Invalid repository IDs');
  assert(Number.isSafeInteger(s.pr_number) && s.pr_number > 0, 'Invalid PR number');
  assert(s.author?.login === 'dependabot[bot]' && s.author.id === '49699333', 'Unexpected PR author');
  for (const side of ['base', 'head']) {
    assert(SHA.test(s[side]?.sha) && s[side].repository === s.repository &&
      s[side].repository_id === s.repository_id, 'Invalid exact PR revisions or repository identity');
  }
  assert(SHA.test(s.baseline_sha) && s.pr_base_tip === s.base.sha &&
    s.comparison_scope === 'merge-base-to-head', 'Invalid explicit comparison baseline');
  assert(s.baseline_sha !== s.head.sha, 'BLOCKED: merge-base equals head; no dependency-change comparison');
  assert(SHA.test(s.control_sha) && SHA.test(s.recorder_sha) && SHA.test(s.github_sha), 'Invalid control SHA');
  assert(s.workflow_path === '.github/workflows/garnet-dependabot-record.yml' &&
    s.control_ref.startsWith(`${s.repository}/${s.workflow_path}@`) && SHA.test(s.workflow_blob),
  'Unexpected control workflow');
  assert(['pull_request', 'workflow_dispatch'].includes(s.event), 'Invalid source event');
  assert(/^[1-9]\d*$/.test(s.run_id) && /^[1-9]\d*$/.test(s.run_attempt), 'Invalid run identity');
  assert(Array.isArray(s.changed_files) && s.changed_files.length > 0 &&
    s.changed_files.length <= 6000 && Array.isArray(s.manifests), 'Missing/bounded changed-file list');
  s.changed_files.forEach(safePath);
  s.manifests.forEach(p => { safePath(p); assert(s.changed_files.includes(p), 'Unexpected manifest'); });
  assert(!Number.isNaN(Date.parse(s.resolved_at)), 'Missing resolution time');
  return s;
}

export function ecosystem(file) {
  const name = path.posix.basename(safePath(file));
  if (/^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock)$/.test(name)) return 'node';
  if (/^(pyproject\.toml|uv\.lock|poetry\.lock|requirements[^/]*\.txt)$/.test(name)) return 'python';
  if (/^go\.(mod|sum)$/.test(name)) return 'go';
  if (/^Cargo\.(toml|lock)$/.test(name)) return 'rust';
  if (/^Gemfile(\.lock)?$/.test(name)) return 'ruby';
  return null;
}

// Reject symlink parents as well as the leaf before any host file read. Whole
// checkout validation later also rejects outbound/dangling symlinks and gitlinks.
export function readSource(root, relative, optional = false) {
  safePath(relative);
  let cursor = root;
  for (const component of relative.split('/')) {
    cursor = path.join(cursor, component);
    if (!fs.existsSync(cursor)) {
      if (optional) return null;
      throw new Error(`Missing required manifest: ${relative}`);
    }
    assert(!fs.lstatSync(cursor).isSymbolicLink(), 'Symlink manifest or parent is blocked');
  }
  const stat = fs.statSync(cursor);
  assert(stat.isFile() && stat.size <= 8 * 1024 * 1024, 'Manifest is not a bounded regular file');
  return fs.readFileSync(cursor, 'utf8');
}
const joined = (dir, file) => dir === '.' ? file : `${dir}/${file}`;
const exists = (root, dir, file) => readSource(root, joined(dir, file), true) !== null;
const nearest = (root, dir, file) => ancestors(dir).find(d => exists(root, d, file));
const packageData = (root, dir) => JSON.parse(readSource(root, joined(dir, 'package.json')));
const fixturePath = dir => dir.split('/').some(p => /^(?:\.?fixtures|__fixtures__)$/.test(p));

function managerSpec(value) {
  if (value === undefined) return null;
  assert(typeof value === 'string', 'Invalid packageManager');
  const match = /^(npm|pnpm|yarn)@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/.exec(value);
  assert(match, 'packageManager must pin a supported numeric version');
  return {name: match[1], version: match[2]};
}

// Pure planner: file contents are data. It never imports package code, parses
// Ruby as code, or installs planner dependencies from the source repository.
export function planWorkloads(root, changed) {
  const plans = new Map();
  const recognized = changed.filter(file => ecosystem(file));
  assert(recognized.length > 0, 'BLOCKED: no supported changed dependency manifests (including action-only PRs)');
  for (const file of recognized) {
    readSource(root, file); // additions/deletions must not silently select an unrelated ancestor
    const kind = ecosystem(file);
    let dir = path.posix.dirname(file);
    const commands = [];
    let scope = 'dependency-install-with-lifecycle-hooks';
    let locked = true;
    let note = '';
    const additional = planAdditionalLockfile({root, file, kind, read: readSource});
    if (additional) {
      dir = additional.directory;
      commands.push(...additional.commands);
      scope = additional.scope;
      locked = additional.locked;
      note = additional.note;
    } else if (kind === 'node') {
      const packageRoot = nearest(root, dir, 'package.json');
      assert(packageRoot !== undefined, 'BLOCKED: missing package.json');
      dir = packageRoot;
      let pkg = packageData(root, dir);
      let spec = managerSpec(pkg.packageManager);
      // A standalone fixture without its own packageManager is intentionally
      // NOT promoted to the pnpm repository's root workspace.
      const standalone = fixturePath(dir) && !spec && !exists(root, dir, 'pnpm-lock.yaml');
      const workspace = nearest(root, dir, 'pnpm-workspace.yaml');
      if (!standalone && workspace !== undefined && exists(root, workspace, 'pnpm-lock.yaml')) {
        dir = workspace;
        pkg = packageData(root, dir);
        spec = managerSpec(pkg.packageManager);
        assert(!spec || spec.name === 'pnpm', 'BLOCKED: conflicting workspace packageManager');
      }
      const pnpmLock = readSource(root, joined(dir, 'pnpm-lock.yaml'), true);
      if (spec?.name === 'yarn' || (!spec && exists(root, dir, 'yarn.lock'))) {
        throw new Error('BLOCKED: Yarn project could not be resolved by the reviewed lockfile policy');
      }
      if (spec?.name === 'pnpm' || (!standalone && pnpmLock !== null)) {
        assert(pnpmLock !== null, 'BLOCKED: pnpm frozen install requires a lockfile');
        const lockVersion = /(?:^|\n)lockfileVersion:\s*['"]?(\d+)/.exec(pnpmLock)?.[1];
        const version = spec?.version || ({'9': '9.15.9', '6': '8.15.9', '5': '7.33.7'})[lockVersion];
        assert(version, 'BLOCKED: unsupported pnpm lockfile version without packageManager');
        commands.push(`corepack install --global ${quote(`pnpm@${version}`)}`,
          'mkdir -p /home/workload/.local/bin',
          'corepack enable --install-directory /home/workload/.local/bin pnpm',
          'corepack pnpm install --frozen-lockfile');
        note = spec ? 'packageManager respected' : 'pnpm fallback version selected from lockfile version';
      } else {
        const hasLock = exists(root, dir, 'package-lock.json') || exists(root, dir, 'npm-shrinkwrap.json');
        locked = hasLock;
        if (spec?.name === 'npm') {
          commands.push(`npm install --global --prefix /home/workload/npm ${quote(`npm@${spec.version}`)}`);
        }
        const npm = spec?.name === 'npm' ? '/home/workload/npm/bin/npm' : 'npm';
        commands.push(`${npm} ${hasLock ? 'ci' : 'install --no-package-lock'} --no-audit --no-fund`);
        note = standalone ? 'standalone fixture, not repository workspace' : 'npm project';
      }
    } else if (kind === 'python') {
      if (/^requirements.*\.txt$/.test(path.posix.basename(file))) {
        readSource(root, file);
        commands.push(`python -m pip install -r ${quote(path.posix.basename(file))}`);
        locked = false;
        scope = 'requirements-install';
      } else {
        const project = nearest(root, dir, 'pyproject.toml');
        assert(project !== undefined, 'BLOCKED: missing pyproject.toml');
        dir = nearest(root, project, 'uv.lock') ?? project;
        readSource(root, joined(dir, 'pyproject.toml'));
        assert(!exists(root, dir, 'poetry.lock') || exists(root, dir, 'uv.lock'),
          'BLOCKED: Poetry project could not be resolved by the reviewed lockfile policy');
        if (exists(root, dir, 'uv.lock')) {
          commands.push('python -m pip install --user uv==0.8.22',
            'uv lock --check',
            'uv sync --frozen --all-groups --no-install-workspace');
          scope = 'uv-locked-dependencies-all-groups-no-workspace-install';
          note = 'Stale uv.lock fails explicitly at uv lock --check; project/workspace builds excluded';
        } else {
          commands.push('python -m pip install .');
          locked = false;
          scope = 'pyproject-install-with-build-hooks-no-lock';
          note = 'No uv.lock: unlocked pip install of the exact local project';
        }
      }
    } else if (kind === 'go') {
      dir = nearest(root, dir, 'go.mod');
      assert(dir !== undefined, 'BLOCKED: missing go.mod');
      commands.push('go mod download');
      scope = 'module-download-only';
    } else if (kind === 'rust') {
      dir = nearest(root, dir, 'Cargo.lock');
      assert(dir !== undefined && exists(root, dir, 'Cargo.toml'), 'BLOCKED: missing Cargo workspace lock or manifest');
      commands.push('set -- /usr/local/rustup/toolchains/*/bin/cargo',
        'test "$#" -eq 1 && test -x "$1"',
        'export PATH="${1%/cargo}:$PATH"',
        '"$1" fetch --locked');
      scope = 'crate-fetch-only';
      note = 'Use the immutable image’s installed cargo directly, without rustup channel updates; no project compilation';
    } else if (kind === 'ruby') {
      dir = nearest(root, dir, 'Gemfile');
      assert(dir !== undefined, 'BLOCKED: missing Gemfile');
      const lock = readSource(root, joined(dir, 'Gemfile.lock'));
      const version = /(?:^|\n)BUNDLED WITH\s*\n\s+(\d+\.\d+\.\d+)\s*(?:\n|$)/.exec(lock)?.[1];
      assert(version, 'BLOCKED: missing exact BUNDLED WITH version');
      commands.push(`gem install bundler --version ${quote(version)} --no-document`,
        `bundle _${version}_ install`);
      note = 'BUNDLE_FROZEN=true, exact lockfile bundler version';
    }
    // Ancestor promotion can occur after the additional helper delegates.
    // Enforce ambiguity guards on the FINAL project, not just the changed path.
    if (kind === 'node' && exists(root, dir, 'yarn.lock')) {
      assert(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json']
        .every(name => !exists(root, dir, name)),
      'BLOCKED: competing Node lockfiles at final selected project require reviewed upstream-workflow manager selection');
    }
    if (kind === 'python') {
      assert(!(exists(root, dir, 'uv.lock') && exists(root, dir, 'poetry.lock')),
        'BLOCKED: both uv.lock and poetry.lock at final selected project require an explicit ecosystem policy');
    }
    const key = `${kind}:${dir}:${kind === 'python' && scope === 'requirements-install' ? path.posix.basename(file) : ''}`;
    if (plans.has(key)) plans.get(key).changed_manifests.push(file);
    else plans.set(key, {id: key, ecosystem: kind, directory: dir, commands, scope, locked, note, changed_manifests: [file]});
  }
  assert(plans.size > 0 && plans.size <= 12, 'BLOCKED: workload count outside pilot bounds');
  return [...plans.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// All host child output is captured, never streamed into the Actions command
// channel. Error messages deliberately contain only trusted executable names.
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: MAX_JSON,
    timeout: 240000, stdio: ['ignore', 'pipe', 'pipe'], ...options});
  assert(!result.error && result.status === 0, `Trusted command failed: ${command}`);
  return result.stdout.trim();
}
const sudo = (...args) => run('sudo', ['--', ...args]);
const expectedSHA = (s, side) => side === 'base' ? s.baseline_sha : s.head.sha;
const profileJob = (s, side) => `dependabot-${side}-attempt-${s.run_attempt}`;
const artifactName = (s, side) => `garnet-record-${s.run_id}-${s.run_attempt}-${side}`;

function validateImages(images, snapshot) {
  for (const kind of new Set(snapshot.manifests.map(ecosystem).filter(Boolean))) {
    assert(DIGEST.test(images?.[kind]?.digest) && images[kind].tag === IMAGE_TAGS[kind],
      'Missing or invalid immutable image');
    const repository = IMAGE_TAGS[kind].split(':')[0];
    assert(images[kind].digest.startsWith(`${repository}@`) ||
      images[kind].digest.startsWith(`docker.io/library/${repository}@`), 'Image repository mismatch');
  }
  return images;
}

async function resolveImages() {
  const s = validateSnapshot(envJSON('RECORDER_SNAPSHOT'));
  const images = {};
  for (const kind of new Set(s.manifests.map(ecosystem).filter(Boolean))) {
    const tag = IMAGE_TAGS[kind];
    run('docker', ['pull', '--platform', 'linux/amd64', tag], {timeout: 600000});
    const digests = JSON.parse(run('docker', ['image', 'inspect', tag, '--format', '{{json .RepoDigests}}']));
    assert(Array.isArray(digests), 'Image digest missing');
    const image = digests.find(d => d.startsWith(`${tag.split(':')[0]}@`));
    assert(DIGEST.test(image), 'Image did not resolve to a digest');
    images[kind] = {tag, digest: image, platform: 'linux/amd64'};
  }
  validateImages(images, s);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `images=${JSON.stringify(images)}\n`);
}

function locations() {
  const output = path.resolve(process.env.RECORDER_OUTPUT);
  const state = path.resolve(process.env.RECORDER_STATE);
  return {output, state, receipt: path.join(output, 'receipt.json'), stateFile: path.join(state, 'state.json')};
}
function initialize() {
  const s = validateSnapshot(envJSON('RECORDER_SNAPSHOT'));
  const side = process.env.RECORDER_SIDE;
  assert(['base', 'head'].includes(side), 'Invalid matrix side');
  const p = locations();
  fs.mkdirSync(p.output, {recursive: true, mode: 0o700});
  fs.mkdirSync(p.state, {recursive: true, mode: 0o700});
  const receipt = {
    schema: 1, policy: POLICY, snapshot: s, side, expected_sha: expectedSHA(s, side),
    ...recorderCodeHashes(),
    executed_sha: null, control_sha: s.control_sha, recorder_sha: s.recorder_sha,
    run_id: s.run_id, run_attempt: s.run_attempt, profile_job: profileJob(s, side),
    native_profile_sha_is_execution_proof: false, action_sha: ACTION, sensor_version: SENSOR,
    artifact_name: artifactName(s, side), recording_complete: false, workload_success: false,
    workload_exit: null, workloads: [], sensor: {ready: false, stopped_cleanly: false},
    profile: {state: 'missing'}, status: 'initialized', initialized_at: now(),
    isolation: {
      boundary: 'nonroot-container-shared-host-kernel-not-a-VM',
      capabilities: [], no_new_privileges: true, host_credentials_mounted: false,
      env_policy: 'explicit-nonsecret-allowlist', public_dependency_egress: true,
      ipv6: 'disabled', caches: 'disposable-per-workload', logs: 'captured-not-streamed',
    },
  };
  json(p.receipt, receipt);
  json(p.stateFile, {receipt, pids: [], containers: []});
  fs.writeFileSync(path.join(p.output, 'workload.log'), '', {mode: 0o600});
  return receipt;
}
const loadState = () => JSON.parse(fs.readFileSync(locations().stateFile, 'utf8'));
function saveState(state) {
  const p = locations();
  json(p.stateFile, state);
  json(p.receipt, state.receipt);
}

export function copyExactSource(source, destination) {
  let entries = 0, total = 0;
  const root = fs.realpathSync(source);
  const inside = resolved => (resolved === root || resolved.startsWith(`${root}${path.sep}`)) &&
    !path.relative(root, resolved).split(path.sep).includes('.git');
  function validateLink(from, target) {
    assert(!path.isAbsolute(target), 'Absolute source symlink blocked');
    assert(inside(path.resolve(path.dirname(from), target)), 'Outbound source symlink blocked');
    // Preserve dangling links, but still inspect existing symlink prefixes.
    // A lexical-only check can miss "shortcut/../../missing" escapes when
    // shortcut points to a shallower directory. No file contents are read.
    let cursor = path.dirname(from), links = 0;
    const pending = target.split(path.sep);
    while (pending.length) {
      const part = pending.shift();
      if (!part || part === '.') continue;
      const next = path.resolve(cursor, part);
      assert(inside(next), 'Outbound source symlink blocked');
      let stat;
      try { stat = fs.lstatSync(next); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        cursor = next; continue;
      }
      if (stat.isSymbolicLink()) {
        assert(++links <= 40, 'Cyclic source symlink blocked');
        const nested = fs.readlinkSync(next);
        assert(!path.isAbsolute(nested), 'Absolute source symlink blocked');
        pending.unshift(...nested.split(path.sep));
      } else cursor = next;
    }
    try {
      assert(inside(fs.realpathSync(from)), 'Outbound source symlink blocked');
    } catch (error) {
      // Only an absent target is permissible; ELOOP, EACCES, etc. fail closed.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  function visit(from, to) {
    const stat = fs.lstatSync(from);
    assert(++entries <= 400000, 'Source entry limit exceeded');
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(from);
      validateLink(from, target);
      fs.symlinkSync(target, to);
    } else if (stat.isDirectory()) {
      fs.mkdirSync(to, {mode: 0o755});
      for (const entry of fs.readdirSync(from)) {
        if (entry !== '.git') visit(path.join(from, entry), path.join(to, entry));
      }
    } else {
      assert(stat.isFile() && stat.nlink === 1, 'Special or hardlinked source file blocked');
      total += stat.size;
      assert(total <= 3 * 1024 ** 3, 'Source byte limit exceeded');
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, stat.mode & 0o111 ? 0o755 : 0o644);
    }
  }
  visit(root, destination);
}

async function prepare() {
  const state = loadState(), r = state.receipt, s = r.snapshot;
  const source = path.resolve(process.env.RECORDER_SOURCE);
  assert(!fs.lstatSync(source).isSymbolicLink(), 'Source root may not be a symlink');
  const actual = run('git', ['-C', source, 'rev-parse', 'HEAD']);
  assert(actual === r.expected_sha, 'Checkout does not match expected immutable SHA');
  const tree = run('git', ['-C', source, 'ls-tree', '-rz', 'HEAD']);
  assert(!tree.split('\0').some(line => line.startsWith('160000 ')), 'BLOCKED: submodules require explicit policy');
  r.executed_sha = actual;
  Object.assign(r, recorderCodeHashes());
  r.images = validateImages(envJSON('RECORDER_IMAGES'), s);
  // Validate the entire copy before the sensor can expose host credentials.
  state.sourceCopy = path.join(locations().state, 'source');
  copyExactSource(source, state.sourceCopy);
  saveState(state);
  r.workloads = planWorkloads(state.sourceCopy, s.manifests).map(plan => ({
    ...plan, image: r.images[plan.ecosystem], exit_code: null, pids: [], started_at: null,
    finished_at: null, marker: null,
  }));
  r.status = 'prepared';
  saveState(state);
}

async function restrictNetwork(state) {
  const bridge = 'grnet0';
  const name = `garnet-${state.receipt.run_id}-${state.receipt.side}`;
  run('docker', ['network', 'create', '--driver', 'bridge',
    '--opt', `com.docker.network.bridge.name=${bridge}`,
    '--opt', 'com.docker.network.bridge.enable_icc=false', name]);
  state.network = name;
  saveState(state);
  const network = JSON.parse(run('docker', ['network', 'inspect', name]))[0];
  assert(network.EnableIPv6 === false, 'Unexpected IPv6 bridge');
  sudo('iptables', '-N', 'GARNET-WORKLOAD');
  const hostIPs = JSON.parse(run('ip', ['-j', '-4', 'address', 'show']))
    .flatMap(i => i.addr_info || []).map(i => i.local).filter(Boolean);
  const garnetIPs = [...new Set((await Promise.all(
    ['api.garnet.ai', 'app.garnet.ai'].map(host => dns.resolve4(host)))).flat())];
  assert(garnetIPs.length > 0, 'Could not resolve Garnet control plane for egress deny rules');
  for (const ip of [...hostIPs, ...garnetIPs]) assert(/^\d+\.\d+\.\d+\.\d+$/.test(ip), 'Invalid deny address');
  for (const destination of [...PRIVATE_NETS, ...hostIPs, ...garnetIPs]) {
    sudo('iptables', '-A', 'GARNET-WORKLOAD', '-d', destination, '-j', 'REJECT');
  }
  sudo('iptables', '-A', 'GARNET-WORKLOAD', '-j', 'RETURN');
  sudo('iptables', '-I', 'DOCKER-USER', '1', '-i', bridge, '-j', 'GARNET-WORKLOAD');
  // Locally routed destinations traverse INPUT, NOT DOCKER-USER.
  sudo('iptables', '-I', 'INPUT', '1', '-i', bridge, '-j', 'DROP');
  sudo('iptables', '-C', 'DOCKER-USER', '-i', bridge, '-j', 'GARNET-WORKLOAD');
  sudo('iptables', '-C', 'INPUT', '-i', bridge, '-j', 'DROP');
  state.receipt.isolation.network = {
    bridge, docker_user_enforced: true, host_input_blocked: true,
    denied_cidrs: PRIVATE_NETS, denied_host_ipv4: hostIPs, denied_garnet_ipv4: garnetIPs,
    dns: ['1.1.1.1', '8.8.8.8'],
    limitation: 'Garnet A records are a startup snapshot, not a domain firewall; public Internet is intentionally reachable',
  };
  saveState(state);
}

export function containerArgs({name, network, copy, plan, marker}) {
  assert(DIGEST.test(plan.image.digest) && /^[a-z0-9-]+$/.test(marker), 'Invalid container provenance');
  const allowEnv = {
    HOME: '/home/workload', CI: 'true', LANG: 'C.UTF-8',
    PATH: '/home/workload/.local/bin:/home/workload/gems/bin:/usr/local/cargo/bin:/usr/local/go/bin:/usr/local/bundle/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    COREPACK_HOME: '/home/workload/.cache/corepack', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    npm_config_cache: '/home/workload/.npm', npm_config_update_notifier: 'false',
    PIP_DISABLE_PIP_VERSION_CHECK: '1', UV_CACHE_DIR: '/home/workload/.cache/uv',
    GEM_HOME: '/home/workload/gems', GEM_PATH: '/home/workload/gems',
    BUNDLE_PATH: '/home/workload/bundle', BUNDLE_APP_CONFIG: '/home/workload/.bundle', BUNDLE_FROZEN: 'true',
    GOPATH: '/home/workload/go', GOCACHE: '/home/workload/.cache/go-build',
    GOTOOLCHAIN: 'auto', GOFLAGS: '-mod=readonly',
    CARGO_HOME: '/home/workload/.cargo', RUSTUP_HOME: '/usr/local/rustup', RUSTUP_TOOLCHAIN: 'stable',
  };
  const script = `set -eu\n${plan.commands.join('\n')}\n`;
  // A uniquely named shell remains in the process ancestry. Only the trusted
  // commands above are interpolated, with manifest-derived arguments quoted.
  const launcher = `cp /bin/bash /tmp/${marker}; /tmp/${marker} -c ${quote(script)}`;
  return ['create', '--name', name, '--platform', 'linux/amd64',
    '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--read-only', '--init', '--pids-limit', '512', '--memory', '5g', '--cpus', '2',
    '--ulimit', 'fsize=1073741824:1073741824',
    '--network', network, '--dns', '1.1.1.1', '--dns', '8.8.8.8',
    '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1',
    '--tmpfs', '/tmp:rw,nosuid,nodev,exec,size=2g,mode=1777',
    '--tmpfs', '/home/workload:rw,nosuid,nodev,exec,size=4g,uid=10001,gid=10001,mode=0700',
    '--mount', `type=bind,source=${copy},target=/work,bind-propagation=rprivate`,
    '--workdir', plan.directory === '.' ? '/work' : `/work/${plan.directory}`,
    '--log-driver', 'none',
    ...Object.entries(allowEnv).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--entrypoint', '/bin/bash', plan.image.digest, '-c', launcher];
}

async function executeContainer(state, workload, index) {
  const p = locations();
  const name = `gr-${state.receipt.run_id}-${state.receipt.side}-${index}`;
  const marker = `garnet-workload-${state.receipt.run_id}-${state.receipt.side}-${index}`;
  const copy = path.join(p.state, `work-${index}`);
  copyExactSource(state.sourceCopy, copy);
  // chown never follows source symlinks. The container gets only this copy.
  sudo('chown', '-hR', '10001:10001', copy);
  run('docker', ['pull', '--platform', 'linux/amd64', workload.image.digest], {timeout: 600000});
  run('docker', containerArgs({name, network: state.network, copy, plan: workload, marker}));
  state.containers.push(name);
  workload.container = name;
  workload.marker = marker;
  workload.started_at = now();
  saveState(state);
  const log = fs.openSync(path.join(p.output, 'workload.log'), 'a', 0o600);
  fs.writeSync(log, `\n=== trusted workload ${index}: ${workload.ecosystem} ===\n`);
  const child = spawn('docker', ['start', '--attach', name], {stdio: ['ignore', 'pipe', 'pipe']});
  let bytes = fs.fstatSync(log).size, truncated = false, timedOut = false, spawnError = false;
  const capture = chunk => {
    if (bytes + chunk.length > MAX_LOG) { truncated = true; return; }
    fs.writeSync(log, chunk); bytes += chunk.length;
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const collectPids = () => {
    const result = spawnSync('docker', ['top', name, '-eo', 'pid'], {encoding: 'utf8', timeout: 5000});
    if (result.status === 0) {
      const pids = result.stdout.trim().split(/\s+/).filter(x => /^[1-9]\d*$/.test(x)).map(Number);
      workload.pids = [...new Set([...workload.pids, ...pids])];
      saveState(state);
    }
  };
  const timer = setInterval(collectPids, 250);
  const timeout = setTimeout(() => {
    timedOut = true;
    spawnSync('docker', ['kill', name], {timeout: 10000, stdio: 'ignore'});
  }, 15 * 60 * 1000);
  await new Promise(resolve => {
    child.once('error', () => { spawnError = true; resolve(); });
    child.once('close', resolve);
  });
  clearInterval(timer); clearTimeout(timeout); fs.closeSync(log);
  const inspected = JSON.parse(run('docker', ['inspect', name]))[0].State;
  assert(inspected.Status === 'exited', 'Container did not exit');
  workload.exit_code = timedOut ? 124 : spawnError ? 125 : inspected.ExitCode;
  workload.finished_at = now();
  workload.output_truncated = truncated;
  workload.oom_killed = inspected.OOMKilled === true;
  workload.timed_out = timedOut;
  saveState(state);
}

async function record() {
  const state = loadState(), r = state.receipt;
  assert(r.status === 'prepared' && r.workloads.length > 0, 'Workload was not prepared');
  assert(sudo('systemctl', 'is-active', 'jibril.service') === 'active', 'Sensor is not active (OIDC/setup may have failed)');
  r.sensor.ready = true;
  r.sensor.ready_at = now();
  r.sensor.main_pid = Number(sudo('systemctl', 'show', 'jibril.service', '--property=MainPID', '--value'));
  assert(r.sensor.main_pid > 0, 'Sensor process is missing');
  saveState(state);
  await restrictNetwork(state);
  for (let i = 0; i < r.workloads.length; i++) await executeContainer(state, r.workloads[i], i);
  r.workload_exit = r.workloads.find(w => w.exit_code !== 0)?.exit_code ?? 0;
  r.workload_success = r.workloads.every(w => w.exit_code === 0 && !w.oom_killed && !w.output_truncated);
  r.status = r.workload_success ? 'workload-finished' : 'workload-failed';
  saveState(state);
  assert(r.workload_success, 'Dependency workload failed; see captured workload.log and receipt');
}

function readBounded(file, max = MAX_JSON) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= max, 'Missing, empty, oversized or unsafe evidence file');
  return fs.readFileSync(file);
}

// Raw Jibril 0.2.0 shape, as used by the pinned action's summarizeProfile.
// A host curl/node/background flow does NOT satisfy workload coverage: each
// planned workload needs a flow tied to a captured container PID or its unique
// executable ancestry marker. No fabricated "smoke" traffic is added.
export function validateProfile(raw, receipt) {
  const envelope = JSON.parse(raw);
  const p = envelope?.data && typeof envelope.data === 'object' ? envelope.data : envelope;
  assert(p?.metadata?.kind === 'profile' && p.metadata.format === 'profile' &&
    p.metadata.version === '0.2.0', 'Unknown raw profile schema');
  assert(typeof p.uuid === 'string' && /^[a-f0-9-]{36}$/i.test(p.uuid) &&
    typeof p.timestamp === 'string' && !Number.isNaN(Date.parse(p.timestamp)), 'Invalid profile identity/time');
  const g = p?.scenarios?.github || p?.github;
  assert(g && String(g.repository) === receipt.snapshot.repository &&
    String(g.run_id) === receipt.run_id, 'Profile repository/run mismatch');
  assert(['record', receipt.profile_job].includes(String(g.job)), 'Profile job mismatch');
  assert(String(g.run_attempt) === receipt.run_attempt, 'Profile attempt mismatch');
  // Raw sensor and hosted envelope can use different native SHA labels.
  // Neither is execution provenance: only the trusted checkout receipt is.
  assert([receipt.snapshot.github_sha, receipt.snapshot.head.sha].includes(String(g.sha)),
    'Unexpected native profile SHA');
  const peers = p?.network?.egress?.peers;
  assert(Array.isArray(peers) && peers.length > 0 && peers.length < 1000000, 'No real egress peer records');
  const evidence = receipt.workloads.map(w => {
    const pids = new Set(w.pids.map(String));
    let count = 0;
    for (const peer of peers) {
      if (!peer || !(peer.remote_address || peer.remote_names?.length) ||
        peer.protocol !== 'TCP' || !Array.isArray(peer.remote_ports) ||
        !peer.remote_ports.some(port => !/^53(?:\s|$)/.test(String(port))) ||
        !Array.isArray(peer.proc_trees)) continue;
      for (const tree of peer.proc_trees) {
        if (!tree || !tree.process || !/^[1-9]\d*$/.test(String(tree.pid))) continue;
        const ancestry = [tree.process, tree.executable, ...(Array.isArray(tree.ancestry) ? tree.ancestry : [])];
        const markerMatch = w.marker && ancestry.some(x =>
          typeof x === 'string' && x.split(/[^A-Za-z0-9-]+/).includes(w.marker));
        if (pids.has(String(tree.pid)) || markerMatch) count++;
      }
    }
    assert(count > 0, 'No network/process evidence attributable to a planned container workload');
    return {workload_id: w.id, network_process_associations: count};
  });
  return {state: 'valid', sha256: digest(raw), bytes: Buffer.byteLength(raw),
    native_github: {repository: String(g.repository), run_id: String(g.run_id),
      job: String(g.job), sha: String(g.sha), run_attempt: g.run_attempt ?? null},
    egress_peers: peers.length, workload_evidence: evidence};
}

async function finalize() {
  const p = locations();
  let state;
  try { state = loadState(); } catch { initialize(); state = loadState(); }
  const r = state.receipt;
  let failure = false;
  // Stop any lingering workload first. Cancellation/error is never a success.
  for (const name of state.containers) {
    try {
      const status = JSON.parse(run('docker', ['inspect', name]))[0].State;
      if (status.Running) { run('docker', ['stop', '--time', '10', name]); failure = true; }
    } catch { failure = true; }
  }
  try {
    assert(r.sensor.ready, 'Sensor never became ready');
    assert(sudo('systemctl', 'is-active', 'jibril.service') === 'active', 'Sensor ended before finalization');
    // Leave >=30 seconds after the workload for short recordings to settle.
    await sleep(30000);
    r.sensor.settle_seconds = 30;
    sudo('systemctl', 'stop', 'jibril.service');
    const status = sudo('systemctl', 'show', 'jibril.service',
      '--property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus');
    const fields = Object.fromEntries(status.split('\n').map(line => line.split('=')));
    r.sensor.stop_details = fields;
    assert(fields.ActiveState === 'inactive' && fields.SubState === 'dead' &&
      fields.Result === 'success' && fields.ExecMainStatus === '0', 'Sensor did not stop/flush cleanly');
    r.sensor.stopped_cleanly = true;
    r.sensor.stopped_at = now();
    const profile = '/var/log/jibril.profile.json';
    sudo('test', '-f', profile);
    sudo('test', '!', '-L', profile);
    sudo('test', '-s', profile);
    sudo('cp', '--no-dereference', profile, path.join(p.output, 'jibril.profile.json'));
    sudo('chown', `${process.getuid()}:${process.getgid()}`, path.join(p.output, 'jibril.profile.json'));
    const raw = readBounded(path.join(p.output, 'jibril.profile.json'));
    r.profile = validateProfile(raw, r);
  } catch {
    failure = true;
    r.profile.state = fs.existsSync(path.join(p.output, 'jibril.profile.json')) ? 'invalid' : 'missing';
    r.finalization_error = 'Missing/invalid profile, no workload evidence, or unclean sensor lifecycle; review trusted stop details';
  }
  r.recording_complete = !failure && r.sensor.ready && r.sensor.stopped_cleanly &&
    r.profile.state === 'valid' && r.workloads.length > 0 &&
    r.workloads.every(w => Number.isInteger(w.exit_code) && w.started_at && w.finished_at);
  r.workload_success = r.workloads.length > 0 &&
    r.workloads.every(w => w.exit_code === 0 && !w.output_truncated && !w.oom_killed);
  r.workload_exit = r.workloads.find(w => w.exit_code !== 0)?.exit_code ??
    (r.workload_success ? 0 : null);
  r.status = r.recording_complete && r.workload_success ? 'recorded' : 'incomplete-or-failed';
  r.finalized_at = now();
  const log = fs.readFileSync(path.join(p.output, 'workload.log'));
  r.workload_log = {sha256: digest(log), bytes: log.length};
  saveState(state);
  assert(r.recording_complete && r.workload_success, 'Recording incomplete or workload failed; artifacts retained');
}

export function validateReceipt(r, s, side, images, codeHashes = recorderCodeHashes()) {
  assert(r?.schema === 1 && r.policy === POLICY, 'Receipt schema/policy mismatch');
  assert(r.recorder_script_sha256 === codeHashes.recorder_script_sha256, 'Recorder script hash mismatch');
  assert(r.recorder_helpers_sha256 &&
    JSON.stringify(r.recorder_helpers_sha256) === JSON.stringify(codeHashes.recorder_helpers_sha256),
  'Recorder helper hash binding mismatch');
  assert(JSON.stringify(r.snapshot) === JSON.stringify(s), 'Receipt snapshot mismatch');
  assert(r.side === side && r.expected_sha === expectedSHA(s, side) &&
    r.executed_sha === r.expected_sha, 'Receipt executed SHA mismatch');
  assert(r.control_sha === s.control_sha && r.recorder_sha === s.recorder_sha &&
    r.run_id === s.run_id && r.run_attempt === s.run_attempt, 'Receipt control/run mismatch');
  assert(r.profile_job === profileJob(s, side) && r.artifact_name === artifactName(s, side),
    'Receipt artifact/job identity mismatch');
  assert(r.action_sha === ACTION && r.sensor_version === SENSOR &&
    r.native_profile_sha_is_execution_proof === false, 'Recorder policy/version mismatch');
  assert(r.recording_complete === true && r.workload_success === true &&
    r.workload_exit === 0 && r.status === 'recorded', 'Recording is incomplete or workload failed');
  assert(r.sensor?.ready === true && r.sensor.stopped_cleanly === true &&
    r.sensor.settle_seconds >= 30, 'Incomplete sensor lifecycle');
  assert(r.isolation?.network?.docker_user_enforced === true &&
    r.isolation.network.host_input_blocked === true, 'Missing network containment evidence');
  assert(Array.isArray(r.workloads) && r.workloads.length > 0 && r.workloads.length <= 12,
    'No workload evidence');
  for (const w of r.workloads) {
    assert(w.exit_code === 0 && w.oom_killed === false && w.output_truncated === false &&
      w.timed_out === false, 'Workload exit failure');
    assert(w.image?.digest === images[w.ecosystem]?.digest, 'Base/head immutable image mismatch');
    assert(Array.isArray(w.commands) && w.commands.length > 0 && Array.isArray(w.pids) &&
      typeof w.marker === 'string' && w.marker.startsWith(`garnet-workload-${s.run_id}-${side}-`),
    'Missing command/container provenance');
    assert(!Number.isNaN(Date.parse(w.started_at)) && Date.parse(w.finished_at) >= Date.parse(w.started_at),
      'Invalid workload times');
  }
  return r;
}

async function verify() {
  const s = validateSnapshot(envJSON('RECORDER_SNAPSHOT'));
  const images = validateImages(envJSON('RECORDER_IMAGES'), s);
  const output = path.resolve(process.env.RECORDER_SUMMARY);
  fs.mkdirSync(output, {recursive: true});
  const summary = {schema: 1, policy: POLICY, snapshot: s, verified: false,
    decision: 'HOLD', meaning: 'Recording verification only; not dependency safety or PR approval',
    cloud_ingestion_verified: false, verified_at: now(), sides: []};
  let error;
  try {
    assert(process.env.RECORDER_RECORD_RESULT === 'success', 'One or both recording jobs failed');
    const root = path.resolve(process.env.RECORDER_EVIDENCE);
    const names = fs.readdirSync(root).sort();
    assert(JSON.stringify(names) === JSON.stringify(['base', 'head'].map(side => artifactName(s, side)).sort()),
      'Missing, duplicate, or unexpected attempt artifacts');
    const codeHashes = recorderCodeHashes();
    Object.assign(summary, codeHashes);
    for (const side of ['base', 'head']) {
      const directory = path.join(root, artifactName(s, side));
      assert(!fs.lstatSync(directory).isSymbolicLink(), 'Unsafe artifact directory');
      assert(JSON.stringify(fs.readdirSync(directory).sort()) === JSON.stringify(
        ['jibril.profile.json', 'receipt.json', 'workload.log']), 'Unexpected evidence payload');
      const r = validateReceipt(JSON.parse(readBounded(path.join(directory, 'receipt.json'), 1024 * 1024)), s, side, images, codeHashes);
      const raw = readBounded(path.join(directory, 'jibril.profile.json'));
      const checked = validateProfile(raw, r);
      assert(r.profile.sha256 === checked.sha256 && r.profile.bytes === checked.bytes &&
        JSON.stringify(r.profile.workload_evidence) === JSON.stringify(checked.workload_evidence), 'Profile digest/evidence mismatch');
      const log = readBounded(path.join(directory, 'workload.log'), MAX_LOG);
      assert(log.length <= MAX_LOG && r.workload_log.sha256 === digest(log) &&
        r.workload_log.bytes === log.length, 'Workload log digest mismatch');
      summary.sides.push({side, executed_sha: r.executed_sha, profile_sha256: checked.sha256,
        recorder_script_sha256: r.recorder_script_sha256, recorder_helpers_sha256: r.recorder_helpers_sha256,
        profile_job: r.profile_job, workloads: r.workloads, evidence: checked.workload_evidence});
    }
    const [base, head] = summary.sides;
    assert(JSON.stringify(base.workloads.map(w => w.id)) === JSON.stringify(head.workloads.map(w => w.id)),
      'Base/head workload targets differ; review scope before comparison');
    summary.command_policy_diverged = base.workloads.some((w, i) =>
      JSON.stringify(w.commands) !== JSON.stringify(head.workloads[i].commands));
    summary.comparison_scope_equivalent = !summary.command_policy_diverged;
    summary.verified = true;
    summary.decision = summary.command_policy_diverged ? 'HOLD' : 'RECORDING_VERIFIED';
    if (summary.command_policy_diverged) summary.hold_reason =
      'Both records validated, but command policy differs; do not claim a scope-equivalent dependency comparison';
  } catch (e) {
    error = e;
    // Diagnostic data is never inserted into a shell or PR comment here.
    summary.error = String(e.message).slice(0, 500);
  }
  json(path.join(output, 'verification.json'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Garnet Dependabot recording\n\n${summary.verified ? 'Recording verified for both exact source revisions.' : 'HOLD: recording is incomplete or validation failed.'}\n\nThis is not a safety verdict or PR approval. See the verification artifact for exact provenance.\n`);
  if (error) throw error;
}

const commands = {images: resolveImages, init: initialize, prepare, run: record, finalize, verify};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = commands[process.argv[2]];
  if (!command) { console.error('Unknown trusted recorder command'); process.exitCode = 1; }
  else Promise.resolve().then(command).catch(error => {
    // Do not echo source text, subprocess output, or attacker-controlled paths.
    console.error(`Garnet recorder failed (${process.argv[2]}). Inspect retained receipt and workload.log.`);
    try {
      if (['prepare', 'run'].includes(process.argv[2])) {
        const state = loadState();
        state.receipt.status = 'blocked-or-failed';
        state.receipt.failure = String(error.message).slice(0, 500);
        saveState(state);
      }
    } catch { /* initialization/checkout failure remains visible to finalizer */ }
    process.exitCode = 1;
  });
}
