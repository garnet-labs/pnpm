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
import {planAdditionalLockfile, planBunLockfile, reviewedImageTag, assertNoUnselectedBun,
  planReviewedPythonRuntime, reviewedPythonRuntimeImage, validateReviewedPythonImage,
  validateReviewedPythonRuntimeWorkloads, expectedGoMaterialization, validateStaticInventory,
  auditMaterialization, auditPreparedGoCopy, expectedGoPlan, validateGoReceipt,
  parseGoGitTree} from './garnet-additional-lockfiles.mjs';

import {planReviewedDirectory, reviewedDirectoryImage, validateReviewedDirectoryImage,
  reviewedDirectoryTreeProof, validateReviewedDirectoryWorkloads} from './garnet-additional-lockfiles.mjs';
export const REVIEWED_DIRECTORY_POLICIES_VERSION = 1;

export const POLICY = 'garnet-dependabot-container-v2';
// Additive capability marker for the independent publisher. Legacy v2 code
// without this marker must retain its own historical validation contract.
export const REVIEWED_EXCEPTIONS_VERSION = 2;
export const REVIEWED_PYTHON_POLICIES_VERSION = 1;
export const REVIEWED_STORAGE_POLICIES_VERSION = 1;
// C1: capture validity is separate from scope-equivalent comparison validity.
export const RECORDING_RESULT_CONTRACT_VERSION = 1;
export const ACTION = 'e546567a72e4fede11ec39d6e9f75b539adef22c';
export const SENSOR = 'v2.16.0';
// These bounds are ALREADY deployed in the audited failed sensor runs; they
// are coordinated limits, not evidence that a heavy flush will finish.
export const FINALIZATION_LIMITS = Object.freeze({
  sensor_stop_seconds: 180, stop_command_ms: 240000,
  settle_ms: 30000, step_minutes: 6, diagnostic_command_ms: 10000,
});
export const STOP_EXPERIMENT = 'diagnostic-stop-420-v1';
// Diagnostic only, NOT a known fix. One new dispatch per pair is an operator
// limit: a stateless attempt-1 guard cannot prevent a second NEW dispatch.
const STOP_EXPERIMENT_PAIRS = Object.freeze([
  {repository: 'garnet-labs/n8n', repository_id: '1206112160', pr_number: 34,
    baseline_sha: 'f461114870a31dbdf650abcff9a09ad5a86bdafd', pr_base_tip: 'f461114870a31dbdf650abcff9a09ad5a86bdafd',
    head_sha: '65fca3909cfa5a986ff618b5984e091fb068a0ec', manifests: ['packages/cli/package.json', 'pnpm-lock.yaml']},
  {repository: 'garnet-labs/supabase', repository_id: '1206332384', pr_number: 143,
    baseline_sha: 'f28139579a7c017ff90a8414ae1f5929d018d3d2', pr_base_tip: 'f28139579a7c017ff90a8414ae1f5929d018d3d2',
    head_sha: '0d7c5b981b6ee494709fdf590b6b44e8e0ae5a5a', manifests: ['examples/todo-list/nextjs-todo-list/package-lock.json']},
  {repository: 'garnet-labs/OpenHands', repository_id: '1337697001', pr_number: 5,
    baseline_sha: 'c41bda23d6b648bf3a30422ab9d71bd7675caea1', pr_base_tip: 'c41bda23d6b648bf3a30422ab9d71bd7675caea1',
    head_sha: 'f2689932d9b8a025d0eef961dd9a962c11c5697c', manifests: ['package-lock.json']},
  {repository: 'garnet-labs/phantom-connect-sdk', repository_id: '1206647047', pr_number: 23,
    baseline_sha: '8eb39b151cedacddf55fc7715b3469b67743f78e', pr_base_tip: '8eb39b151cedacddf55fc7715b3469b67743f78e',
    head_sha: '112a60b79f4c7cb7e736bd34a4a78afe809590a1', manifests: ['yarn.lock']},
  {repository: 'garnet-labs/next.js', repository_id: '1206332346', pr_number: 40,
    baseline_sha: '2d069943639fd0fc67a26bbb337d8a726f50924d', pr_base_tip: '2d069943639fd0fc67a26bbb337d8a726f50924d',
    head_sha: 'bcae068be948a03cba54813aea6cffb5c03adf63', manifests: ['package.json', 'pnpm-lock.yaml']},
]);
export function finalizationLimits(s) {
  const requested = s.finalization_experiment ?? 'none';
  if (requested === 'none') return {...FINALIZATION_LIMITS, experiment: false, job_minutes: 45};
  assert(requested === STOP_EXPERIMENT, 'Unknown finalization experiment');
  const permit = STOP_EXPERIMENT_PAIRS.find(p => p.repository === s.repository &&
    p.repository_id === s.repository_id && p.pr_number === s.pr_number &&
    p.baseline_sha === s.baseline_sha && p.pr_base_tip === s.pr_base_tip &&
    p.head_sha === s.head?.sha && s.base?.sha === p.pr_base_tip &&
    s.head?.repository === p.repository && s.base?.repository === p.repository &&
    s.head?.repository_id === p.repository_id && s.base?.repository_id === p.repository_id &&
    JSON.stringify([...s.manifests].sort()) === JSON.stringify(p.manifests));
  assert(permit && s.event === 'workflow_dispatch' && s.run_attempt === '1',
    'Stop experiment requires an exact reviewed pair and a new manual attempt-1 dispatch');
  return {...FINALIZATION_LIMITS, experiment: true, experiment_id: STOP_EXPERIMENT,
    sensor_stop_seconds: 420, stop_command_ms: 480000, step_minutes: 10, job_minutes: 60};
}
export function systemdDurationMs(value) {
  const text = String(value ?? '').trim(), tokens = [...text.matchAll(/(\d+(?:\.\d+)?)(us|ms|min|s|h|d)/g)];
  assert(tokens.length && tokens.map(t => t[0]).join('') === text.replace(/\s/g, ''), 'Missing or unbounded systemd stop timeout');
  const scale = {us: 0.001, ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000};
  return tokens.reduce((sum, t) => sum + Number(t[1]) * scale[t[2]], 0);
}
export function validateStopExperiment(r, s) {
  const limits = finalizationLimits(s);
  if (!limits.experiment) {
    if (r.sensor.finalization_limits !== undefined)
      assert(equalData(r.sensor.finalization_limits, limits), 'Unbound stop experiment budget');
    return;
  }
  assert(equalData(r.sensor.finalization_limits, limits), 'Stop experiment receipt budget mismatch');
  assert(systemdDurationMs(r.sensor.stop_details?.TimeoutStopUSec) === 420000, 'Stop experiment effective systemd timeout mismatch');
  assert(r.sensor.stop_details.ActiveState === 'inactive' && r.sensor.stop_details.SubState === 'dead' &&
    r.sensor.stop_details.Result === 'success' && r.sensor.stop_details.ExecMainStatus === '0', 'Stop experiment did not stop cleanly');
  assert(Number.isFinite(r.sensor.stop_elapsed_ms) && r.sensor.stop_elapsed_ms >= 0 &&
    r.sensor.stop_elapsed_ms < limits.stop_command_ms &&
    Number.isFinite(r.sensor.finalization_elapsed_ms) && r.sensor.finalization_elapsed_ms >= 0 &&
    r.sensor.finalization_elapsed_ms < limits.step_minutes * 60000 &&
    !r.sensor.finalization_error && !r.finalization_error, 'Stop experiment timing/lifecycle failure');
}
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
  if (/^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?)$/.test(name)) return 'node';
  if (/^(pyproject\.toml|uv\.lock|poetry\.lock|requirements[^/]*\.txt)$/.test(name)) return 'python';
  if (/^go\.(mod|sum)$/.test(name)) return 'go';
  if (/^Cargo\.(toml|lock)$/.test(name)) return 'rust';
  if (/^Gemfile(\.lock)?$/.test(name)) return 'ruby';
  return null;
}

// Reject symlink parents/leaves before host reads, including dangling optional
// manifests. The only opaque copy exception below never waives this reader.
export function readSource(root, relative, optional = false) {
  safePath(relative);
  assertWorkloadDirectory(root, '.');
  let cursor = root;
  for (const component of relative.split('/')) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (optional) return null;
      throw new Error(`Missing required manifest: ${relative}`);
    }
    assert(!stat.isSymbolicLink(), 'Symlink manifest or parent is blocked');
  }
  const stat = fs.lstatSync(cursor);
  assert(stat.isFile() && stat.size <= 8 * 1024 * 1024, 'Manifest is not a bounded regular file');
  return fs.readFileSync(cursor, 'utf8');
}
export function assertWorkloadDirectory(root, directory) {
  if (directory !== '.') safePath(directory);
  let cursor = root;
  for (const component of ['', ...(directory === '.' ? [] : directory.split('/'))]) {
    if (component) cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Symlink or non-directory workload path blocked');
  }
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

// Parent-reviewed, immutable-pair exceptions. No PR-controlled policy file,
// dispatch flag, broad manager override or general allowAbsolute switch.
const REVIEWED_EXTENSION = Object.freeze({
  repository: 'garnet-labs/vscode-extension-test', repository_id: '899092823', pr_number: 5,
  baseline_sha: '393e349d14a10f2db1ce266c42db378ac6391a93',
  head_sha: 'f43f9f252cab4c3ee9f29a7bcf58f859a35b759b',
  manifests: ['sema4ai/package-lock.json', 'sema4ai/yarn.lock'],
});
const REVIEWED_NEXT = Object.freeze({
  repository: 'garnet-labs/next.js', repository_id: '1206332346', pr_number: 40,
  baseline_sha: '2d069943639fd0fc67a26bbb337d8a726f50924d',
  head_sha: 'bcae068be948a03cba54813aea6cffb5c03adf63',
  manifests: ['package.json', 'pnpm-lock.yaml'],
});
// Both immutable release workflows set working-directory ./sema4ai and
// execute yarn install. Same blobs at both reviewed revisions:
// https://github.com/garnet-labs/vscode-extension-test/blob/393e349d14a10f2db1ce266c42db378ac6391a93/.github/workflows/release-robocorp-code-vscode.yml#L9-L23
// https://github.com/garnet-labs/vscode-extension-test/blob/f43f9f252cab4c3ee9f29a7bcf58f859a35b759b/.github/workflows/pre-release-robocorp-code.yml#L11-L29
const EXTENSION_AUTHORITY = Object.freeze({
  '.github/workflows/release-robocorp-code-vscode.yml': '41a3063623d70bc9d6c61f7b0aa85c42db85481d',
  '.github/workflows/pre-release-robocorp-code.yml': 'da08cb83e92c0a6576bdf824f2d2dbe6b20dd07a',
  'sema4ai/package.json': '448bde4b09f254aee686b3bf63362c619bc60ff6',
});
const EXTENSION_LOCKS = Object.freeze({
  [REVIEWED_EXTENSION.baseline_sha]: {
    'sema4ai/yarn.lock': 'a2e2ba93941e47895ba816f633f3bff22f30c08e',
    'sema4ai/package-lock.json': '322988a2e68ed3d3a2b5bdd11cceedaca9ded1f2',
  },
  [REVIEWED_EXTENSION.head_sha]: {
    'sema4ai/yarn.lock': '38877bfff2c010707b9998c37cd3102f56630490',
    'sema4ai/package-lock.json': '785df566266e81c25259a41390be9ded26889201',
  },
});
// Same Git symlink blob on both revisions; outside declared workspace globs:
// https://api.github.com/repos/garnet-labs/next.js/git/blobs/07ab05517e672a857a940573789969bfb1de3848
// https://github.com/garnet-labs/next.js/blob/2d069943639fd0fc67a26bbb337d8a726f50924d/pnpm-workspace.yaml
const NEXT_OPAQUE_FIXTURE = Object.freeze({
  path: 'test/development/app-dir/ssr-in-rsc/node_modules/random-react-library',
  target: '/Users/sebbie/repos/next.js/test/development/app-dir/ssr-in-rsc/random-react-library/',
  blob_sha: '07ab05517e672a857a940573789969bfb1de3848',
  host_target_resolved: false,
});
const gitBlob = text => crypto.createHash('sha1')
  .update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const equalData = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function reviewedPair(context, approved) {
  const s = context?.snapshot;
  const matches = s?.repository === approved.repository && s.repository_id === approved.repository_id &&
    s.pr_number === approved.pr_number && s.baseline_sha === approved.baseline_sha &&
    s.head?.sha === approved.head_sha && [approved.baseline_sha, approved.head_sha].includes(context.executed_sha) &&
    Array.isArray(s.manifests) && s.manifests.length === approved.manifests.length &&
    approved.manifests.every(file => s.manifests.includes(file));
  if (matches) validateSnapshot(s);
  return matches;
}
export function reviewedExceptionContract(context) {
  const extension = reviewedPair(context, REVIEWED_EXTENSION);
  const next = reviewedPair(context, REVIEWED_NEXT);
  return {
    manager_selection: extension ? {
      policy_id: 'vscode-extension-test-pr5-sema4ai-yarn-v1',
      manager: 'yarn', version: '1.22.22', version_authority: 'trusted-classic-lock-fallback',
      selected_lockfile: 'sema4ai/yarn.lock',
      unused_competing_lockfiles: ['sema4ai/package-lock.json'],
      changed_lockfiles_not_independently_exercised: ['sema4ai/package-lock.json'],
      authority_blobs: {...EXTENSION_AUTHORITY},
      authority_commit_pair: [REVIEWED_EXTENSION.baseline_sha, REVIEWED_EXTENSION.head_sha],
      source_lock_blobs: {...EXTENSION_LOCKS[context.executed_sha]},
    } : null,
    source_copy_fidelity: next ? {
      policy_id: 'nextjs-pr40-exact-fixture-link-preservation-v1',
      method: 'no-dereference-copy', git_metadata_excluded: true,
      excluded_tracked_source_paths: [], rewritten_symlink_targets: [],
      preserved_opaque_symlinks: [{...NEXT_OPAQUE_FIXTURE}],
      fidelity: 'regular-file bytes and symlink target bytes preserved; existing git-metadata exclusion and executable-mode normalization unchanged',
    } : null,
  };
}
function reviewedExtensionCommands() {
  return [
    "garnet_locks_before=$(/usr/bin/sha256sum 'yarn.lock' 'package-lock.json'); readonly garnet_locks_before",
    'export COREPACK_ENABLE_PROJECT_SPEC=0 COREPACK_DEFAULT_TO_LATEST=0 YARN_IGNORE_PATH=1',
    "corepack install --global 'yarn@1.22.22'",
    'mkdir -p /home/workload/.local/bin',
    'corepack enable --install-directory /home/workload/.local/bin yarn',
    'corepack yarn install --frozen-lockfile --non-interactive --production=false',
    "printf '%s\\n' \"$garnet_locks_before\" | /usr/bin/sha256sum --check --status",
  ];
}
function reviewedNodePlan(root, file, kind, context) {
  if (kind !== 'node' || !REVIEWED_EXTENSION.manifests.includes(file)) return null;
  const selection = reviewedExceptionContract(context).manager_selection;
  if (!selection) return null;
  for (const [file, blob] of Object.entries({...selection.authority_blobs, ...selection.source_lock_blobs})) {
    assert(gitBlob(readSource(root, file)) === blob, 'BLOCKED: reviewed Yarn authority/source bytes changed');
  }
  for (const file of ['sema4ai/pnpm-lock.yaml', 'sema4ai/npm-shrinkwrap.json']) {
    assert(readSource(root, file, true) === null, 'BLOCKED: additional competing lockfile');
  }
  return {
    directory: 'sema4ai', locked: true, commands: reviewedExtensionCommands(),
    scope: 'reviewed-yarn-locked-install-with-lifecycle-hooks-no-explicit-workspace-build',
    note: 'Immutable release workflows choose Yarn in sema4ai; 1.22.22 is the trusted classic-lock fallback, not an upstream version pin. npm lock retained but its graph is not independently installed.',
    manager_selection: selection,
  };
}

// Pure planner: file contents are data. It never imports package code, parses
// Ruby as code, or installs planner dependencies from the source repository.
export function planWorkloads(root, changed, context) {
  const plans = new Map();
  if (reviewedExceptionContract(context).manager_selection) {
    assert(equalData([...changed].sort(), [...REVIEWED_EXTENSION.manifests].sort()),
      'BLOCKED: reviewed Yarn changed-manifest scope mismatch');
  }
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
    const reviewed = reviewedNodePlan(root, file, kind, context);
    const bun = reviewed ? null : planBunLockfile({root, file, kind, read: readSource});
    const python = planReviewedPythonRuntime({root, file, kind, context, read: readSource, blob: gitBlob});
    const directoryGit = planReviewedDirectory({root, file, kind, context, read: readSource, blob: gitBlob});
    const additional = reviewed ?? bun ?? python ?? directoryGit ?? planAdditionalLockfile({root, file, kind, read: readSource});
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
    if (kind === 'node') assertNoUnselectedBun({root, directory: dir, selected: bun, read: readSource});
    if (kind === 'node' && exists(root, dir, 'yarn.lock') && !reviewed) {
      assert(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json']
        .every(name => !exists(root, dir, name)),
      'BLOCKED: competing Node lockfiles at final selected project require reviewed upstream-workflow manager selection');
    }
    if (kind === 'python') {
      assert(!(exists(root, dir, 'uv.lock') && exists(root, dir, 'poetry.lock')),
        'BLOCKED: both uv.lock and poetry.lock at final selected project require an explicit ecosystem policy');
    }
    assertWorkloadDirectory(root, dir);
    const key = `${kind}:${dir}:${kind === 'python' && scope === 'requirements-install' ? path.posix.basename(file) : ''}`;
    if (plans.has(key)) plans.get(key).changed_manifests.push(file);
    else plans.set(key, {id: key, ecosystem: kind, directory: dir, commands, scope, locked, note, changed_manifests: [file],
      ...(reviewed ? {manager_selection: reviewed.manager_selection} : {}),
      ...(python ? {python_runtime_policy: python.python_runtime_policy} : {}),
      ...(directoryGit ? {synthetic_git_policy: directoryGit.synthetic_git_policy} : {})});
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

export function validateImages(images, snapshot) {
  for (const kind of new Set(snapshot.manifests.map(ecosystem).filter(Boolean))) {
    const selectedTag = reviewedDirectoryImage(snapshot, kind)?.tag ?? reviewedPythonRuntimeImage(snapshot, kind)?.tag ?? reviewedImageTag(snapshot, kind, IMAGE_TAGS[kind]);
    validateReviewedDirectoryImage(snapshot, kind, images?.[kind]);
    validateReviewedPythonImage(snapshot, kind, images?.[kind]);
    assert(DIGEST.test(images?.[kind]?.digest) && images[kind].tag === selectedTag,
      'Missing or invalid immutable image');
    const repository = selectedTag.split(':')[0];
    assert(images[kind].digest.startsWith(`${repository}@`) ||
      images[kind].digest.startsWith(`docker.io/library/${repository}@`), 'Image repository mismatch');
  }
  return images;
}

async function resolveImages() {
  const s = validateSnapshot(envJSON('RECORDER_SNAPSHOT'));
  const limits = finalizationLimits(s); // reject mismatched opt-in BEFORE image pull
  const images = {};
  for (const kind of new Set(s.manifests.map(ecosystem).filter(Boolean))) {
    const reviewedPython = reviewedDirectoryImage(s, kind) ?? reviewedPythonRuntimeImage(s, kind);
    const tag = reviewedPython?.tag ?? reviewedImageTag(s, kind, IMAGE_TAGS[kind]);
    const reference = reviewedPython?.digest ?? tag;
    run('docker', ['pull', '--platform', 'linux/amd64', reference], {timeout: 600000});
    const digests = JSON.parse(run('docker', ['image', 'inspect', reference, '--format', '{{json .RepoDigests}}']));
    assert(Array.isArray(digests), 'Image digest missing');
    const image = digests.find(d => d.startsWith(`${tag.split(':')[0]}@`));
    assert(DIGEST.test(image), 'Image did not resolve to a digest');
    images[kind] = {tag, digest: image, platform: 'linux/amd64'};
  }
  validateImages(images, s);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `images=${JSON.stringify(images)}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `stop_budget=${JSON.stringify(limits)}\n`);
}

function locations() {
  const output = path.resolve(process.env.RECORDER_OUTPUT);
  const state = path.resolve(process.env.RECORDER_STATE);
  return {output, state, receipt: path.join(output, 'receipt.json'), stateFile: path.join(state, 'state.json')};
}
function initialize() {
  const s = validateSnapshot(envJSON('RECORDER_SNAPSHOT'));
  finalizationLimits(s);
  const side = process.env.RECORDER_SIDE;
  assert(['base', 'head'].includes(side), 'Invalid matrix side');
  const p = locations();
  fs.mkdirSync(p.output, {recursive: true, mode: 0o700});
  fs.mkdirSync(p.state, {recursive: true, mode: 0o700});
  const receipt = {
    schema: 1, policy: POLICY, snapshot: s, side, expected_sha: expectedSHA(s, side),
    reviewed_exceptions_version: REVIEWED_EXCEPTIONS_VERSION,
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

export function copyExactSource(source, destination, context) {
  let entries = 0, total = 0;
  assertWorkloadDirectory(source, '.');
  const root = fs.realpathSync(source);
  const fidelity = reviewedExceptionContract(context).source_copy_fidelity;
  const preserved = [];
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
      const relative = path.relative(root, from).split(path.sep).join('/');
      if (fidelity && relative === NEXT_OPAQUE_FIXTURE.path &&
          target === NEXT_OPAQUE_FIXTURE.target && gitBlob(target) === NEXT_OPAQUE_FIXTURE.blob_sha) {
        // Opaque bytes only: NEVER resolve/stat/read the absolute target.
        preserved.push({...NEXT_OPAQUE_FIXTURE});
      } else validateLink(from, target);
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
  if (fidelity) {
    assert(equalData(preserved, fidelity.preserved_opaque_symlinks),
      'Reviewed source fixture missing or copy fidelity mismatch');
    return fidelity;
  }
}

async function prepare() {
  const state = loadState(), r = state.receipt, s = r.snapshot;
  const source = path.resolve(process.env.RECORDER_SOURCE);
  assert(!fs.lstatSync(source).isSymbolicLink(), 'Source root may not be a symlink');
  const actual = run('git', ['-C', source, 'rev-parse', 'HEAD']);
  assert(actual === r.expected_sha, 'Checkout does not match expected immutable SHA');
  const tree = run('git', ['-C', source, 'ls-tree', '-rz', 'HEAD']);
  const context = {snapshot: s, executed_sha: actual};
  const directoryTree = reviewedDirectoryTreeProof({snapshot: s, executed_sha: actual, raw: tree});
  if (directoryTree) context.directory_tree_proof = directoryTree;
  const go = expectedGoMaterialization(context);
  if (go) {
    const inventory = parseGoGitTree(tree);
    validateStaticInventory(context, inventory);
    auditMaterialization(source, inventory, {allowRootGitMetadata: true});
    state.goInventory = inventory;
  } else {
    assert(!tree.split('\0').some(line => line.startsWith('160000 ')), 'BLOCKED: submodules require explicit policy');
  }
  r.executed_sha = actual;
  Object.assign(r, recorderCodeHashes());
  r.images = validateImages(envJSON('RECORDER_IMAGES'), s);
  // Validate the entire copy before the sensor can expose host credentials.
  state.sourceCopy = path.join(locations().state, 'source');
  const fidelity = copyExactSource(source, state.sourceCopy, context);
  if (fidelity) r.source_copy_fidelity = fidelity;
  if (go) r.source_materialization = auditPreparedGoCopy(context, state.sourceCopy, state.goInventory);
  saveState(state);
  let plans;
  if (go) {
    const {source_materialization: expected, ...plan} = expectedGoPlan(context);
    // Workload-level materialization is attached only AFTER its actual private
    // copy passes the same audit in executeContainer, never from expected shape.
    assert(equalData(expected, r.source_materialization), 'Go source materialization mismatch');
    plans = [plan];
  } else plans = planWorkloads(state.sourceCopy, s.manifests, context);
  r.workloads = plans.map(plan => ({
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

// Isolated proposal: one exact-pair disk-home experiment, never runner HOME.
export function gradioStoragePolicy(s, executedSha) {
  if (s?.repository !== 'garnet-labs/gradio-test' || s.pr_number !== 4 ||
    !Array.isArray(s.manifests) || !s.manifests.includes('test/requirements.txt')) return null;
  const base = '55041996db69b086ee2a5116ad3db40bced6b056';
  const head = '36f97efa0200792ebc2b1fea5f32f2cd28efc5eb';
  assert(s.repository_id === '899240340' && s.pr_number === 4 &&
    s.baseline_sha === base && s.pr_base_tip === base && s.base?.sha === base && s.head?.sha === head &&
    [s.base, s.head].every(x => x.repository === s.repository && x.repository_id === s.repository_id) &&
    s.comparison_scope === 'merge-base-to-head' && s.event === 'workflow_dispatch' && s.run_attempt === '1' &&
    equalData(s.manifests, ['test/requirements.txt']) && equalData(s.changed_files, s.manifests) &&
    [base, head].includes(executedSha), 'Unreviewed Gradio storage pair, identity or attempt');
  return {version: 1, policy_id: 'gradio-pr4-private-disk-home-v1',
    repository: s.repository, repository_id: s.repository_id, pr_number: 4,
    baseline_sha: base, head_sha: head, executed_sha: executedSha,
    requirements_blob: executedSha === base ? 'ff75a5c4be16f7cb948ae5585d38b691820f4834' : '29a22d53b4766c091e56bb0970e6c72b11f82257',
    home: '/home/workload', tmpdir: '/home/workload/tmp',
    home_backing: 'fresh-private-runner-temp-disk-directory',
    initial_home_contents: ['tmp'], uid: 10001, gid: 10001, mode: 0o700,
    tmpfs_tmp_bytes: 2 * 1024 ** 3, minimum_disk_available_bytes: 16 * 1024 ** 3,
    minimum_disk_available_inodes: 65536, minimum_tmp_available_bytes: 1024 ** 3,
    permitted_disk_types: ['ext2/ext3', 'ext4', 'xfs', 'btrfs'],
    preflight: 'trusted-image-python-isolated-mode-no-source-execution-network-none',
    memory_bytes: 5 * 1024 ** 3, cpus: 2, workload_timeout_seconds: 900, job_minutes: 45,
    dependency_command_unchanged: true, admission_is_peak_usage_guarantee: false};
}
export const GRADIO_STORAGE_PROBE = [
  'import os,json,subprocess',
  "paths=['/home/workload','/tmp','/work']",
  "rows=[]",
  "for p in paths:",
  " s=os.statvfs(p); rows.append(dict(path=p,device=os.stat(p).st_dev,block_bytes=s.f_frsize,blocks=s.f_blocks,free_blocks=s.f_bfree,available_blocks=s.f_bavail,inodes=s.f_files,free_inodes=s.f_ffree,available_inodes=s.f_favail))",
  "df=subprocess.run(['/bin/df','-P','-T','-B1','--',*paths],check=True,capture_output=True,text=True,timeout=5).stdout",
  "print(json.dumps(dict(schema=1,phase='before-untrusted-workload',paths=rows,df=df)))",
].join('\n');
const storageDiskMagic = {61267: ['ext2/ext3', 'ext4'], 1481003842: ['xfs'], 2435016766: ['btrfs']};
function diskStat(location) {
  const s = fs.statfsSync(location);
  return {type: s.type, block_bytes: s.bsize, blocks: s.blocks, free_blocks: s.bfree,
    available_blocks: s.bavail, inodes: s.files, free_inodes: s.ffree};
}
export function validateGradioStorageObservation(o, policy) {
  const exact = (value, keys) => assert(value && equalData(Object.keys(value).sort(), [...keys].sort()), 'Storage observation shape mismatch');
  exact(o, ['schema','created_empty','tmp_created_empty','host_uid','host_gid','host_mode','host_home','host_work','docker_mounts_checked','observed_at','initial']);
  assert(o.schema === 1 && o.created_empty === true && o.tmp_created_empty === true &&
    o.host_uid === 10001 && o.host_gid === 10001 && o.host_mode === 0o700 && o.docker_mounts_checked === true &&
    typeof o.observed_at === 'string' && Number.isFinite(Date.parse(o.observed_at)),
  'Storage directory creation/ownership/mount evidence missing');
  const numeric = (value, keys) => {
    for (const key of keys) assert(Number.isSafeInteger(value[key]) && value[key] >= 0, 'Invalid storage measurement');
    assert(value.block_bytes > 0 && value.available_blocks <= value.free_blocks && value.free_blocks <= value.blocks &&
      value.free_inodes <= value.inodes, 'Inconsistent storage capacity');
  };
  for (const h of [o.host_home, o.host_work]) {
    exact(h, ['type','block_bytes','blocks','free_blocks','available_blocks','inodes','free_inodes']);
    numeric(h, ['type','block_bytes','blocks','free_blocks','available_blocks','inodes','free_inodes']);
    assert(storageDiskMagic[h.type] && Number.isSafeInteger(h.available_blocks * h.block_bytes) &&
      h.available_blocks * h.block_bytes >= policy.minimum_disk_available_bytes &&
      h.free_inodes >= policy.minimum_disk_available_inodes, 'Insufficient or non-disk host storage');
  }
  exact(o.initial, ['schema','phase','paths','df']);
  assert(o.initial.schema === 1 && o.initial.phase === 'before-untrusted-workload' &&
    Array.isArray(o.initial.paths) && equalData(o.initial.paths.map(x => x.path), ['/home/workload','/tmp','/work']) &&
    typeof o.initial.df === 'string' && o.initial.df.length < 4096, 'Storage probe evidence missing');
  const df = o.initial.df.trim().split('\n');
  assert(df.length === 4 && df[0].startsWith('Filesystem'), 'Invalid initial df output');
  for (let i=0;i<3;i++) {
    const row = o.initial.paths[i];
    exact(row, ['path','device','block_bytes','blocks','free_blocks','available_blocks','inodes','free_inodes','available_inodes']);
    numeric(row, ['device','block_bytes','blocks','free_blocks','available_blocks','inodes','free_inodes','available_inodes']);
    assert(row.available_inodes <= row.free_inodes, 'Invalid available inode count');
    const m = /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\S+)$/.exec(df[i+1]);
    assert(m && m[7] === row.path && Number(m[3]) === row.blocks * row.block_bytes &&
      Number.isSafeInteger(Number(m[3])) && Number(m[4]) <= Number(m[3]) && Number(m[5]) <= Number(m[3]),
    'Initial df/statvfs capacity mismatch');
    if (i === 1) {
      assert(m[2] === 'tmpfs' && Number(m[3]) === policy.tmpfs_tmp_bytes &&
        Number(m[5]) >= policy.minimum_tmp_available_bytes &&
        row.available_blocks * row.block_bytes >= policy.minimum_tmp_available_bytes, 'Unexpected /tmp backing or capacity');
    } else {
      const host = i === 0 ? o.host_home : o.host_work;
      assert(storageDiskMagic[host.type].includes(m[2]) &&
        Number(m[3]) === host.blocks * host.block_bytes &&
        Number(m[5]) >= policy.minimum_disk_available_bytes &&
        row.available_blocks * row.block_bytes >= policy.minimum_disk_available_bytes &&
        row.available_inodes >= policy.minimum_disk_available_inodes, 'Insufficient or unproven disk-backed container mount');
    }
  }
  return o;
}
export function validateGradioStorageReceipt(r, s) {
  const expected = gradioStoragePolicy(s, r.executed_sha);
  if (!expected) {
    assert(r.workloads.every(w => !Object.hasOwn(w, 'storage_policy') && !Object.hasOwn(w, 'storage_observation')),
      'Unbound storage metadata');
    return [];
  }
  assert(r.workloads.length === 1, 'Gradio storage workload count mismatch');
  const [w] = r.workloads;
  assert(w.id === 'python:test:requirements.txt' && w.ecosystem === 'python' && w.directory === 'test' &&
    w.scope === 'requirements-install' && w.locked === false &&
    equalData(w.commands, ["python -m pip install -r 'requirements.txt'"]) &&
    equalData(w.changed_manifests, ['test/requirements.txt']) &&
    equalData(w.storage_policy, expected), 'Gradio storage policy/unchanged command mismatch');
  validateGradioStorageObservation(w.storage_observation, expected);
  assert(Date.parse(w.storage_observation.observed_at) <= Date.parse(w.started_at),
    'Storage observation must precede untrusted workload');
  return [{workload_id: w.id, policy_id: expected.policy_id, executed_sha: r.executed_sha,
    storage_admission_verified: true, peak_usage_guaranteed: false}];
}
export function validatePrivateStorageMounts(inspected, home, copy) {
  const mounts = inspected.Mounts;
  assert(Array.isArray(mounts) &&
    mounts.filter(m => m.Type === 'bind').length === 2 &&
    mounts.every(m => ['/work','/home/workload'].includes(m.Destination) ||
      m.Destination === '/tmp' && m.Type === 'tmpfs'), 'Unexpected storage preflight mount');
  for (const [target, source] of [['/home/workload',home],['/work',copy]]) {
    const matches = mounts.filter(m => m.Destination === target);
    assert(matches.length === 1 && matches[0].Type === 'bind' && matches[0].Source === source &&
      matches[0].RW === true && matches[0].Propagation === 'rprivate', 'Storage bind-source mismatch');
  }
  assert(equalData(inspected.HostConfig.Tmpfs, {'/tmp':'rw,nosuid,nodev,exec,size=2g,mode=1777'}),
    'Unexpected tmpfs storage configuration');
}
export async function prepareGradioStorage(state, workload, copy, name, marker) {
  const policy = gradioStoragePolicy(state.receipt.snapshot, state.receipt.executed_sha);
  if (!policy) return null;
  assert(workload.id === 'python:test:requirements.txt' &&
    equalData(workload.commands, ["python -m pip install -r 'requirements.txt'"]) &&
    gitBlob(readSource(copy, 'test/requirements.txt')) === policy.requirements_blob, 'Gradio dependency source/command changed');
  assert(typeof process.env.RUNNER_TEMP === 'string' && path.isAbsolute(process.env.RUNNER_TEMP), 'Missing trusted runner temp');
  const parent = path.resolve(process.env.RUNNER_TEMP);
  assert(fs.realpathSync(parent) === parent && /^[A-Za-z0-9_/-]+$/.test(parent) &&
    parent !== path.resolve(os.homedir()) && parent !== '/', 'Unsafe private-home parent');
  const home = fs.mkdtempSync(path.join(parent, `garnet-gradio-home-${state.receipt.run_id}-${state.receipt.side}-`));
  fs.chmodSync(home, 0o700);
  const createdEmpty = fs.readdirSync(home).length === 0;
  const tmp = path.join(home, 'tmp'); fs.mkdirSync(tmp, {mode:0o700});
  const tmpEmpty = fs.readdirSync(tmp).length === 0;
  sudo('chown', '-h', '10001:10001', home, tmp); // fixed fresh paths; never recursive runner HOME
  const st = fs.lstatSync(home);
  assert(st.isDirectory() && !st.isSymbolicLink(), 'Unsafe private-home root');
  workload.storage_policy = policy;
  const o = {schema:1,created_empty:createdEmpty,tmp_created_empty:tmpEmpty,
    host_uid:st.uid,host_gid:st.gid,host_mode:st.mode & 0o777,
    host_home:diskStat(home),host_work:diskStat(copy),docker_mounts_checked:false,observed_at:null,initial:null};
  workload.storage_observation = o; saveState(state); // retain failed admission diagnostics
  const probeName = `${name}-storage`, context = {snapshot:state.receipt.snapshot,executed_sha:state.receipt.executed_sha};
  const probe = {...workload,commands:[`/usr/local/bin/python3 -I -c ${quote(GRADIO_STORAGE_PROBE)}`]};
  run('docker', containerArgs({name:probeName,network:'none',copy,plan:probe,marker:`${marker}-storage`,storageHome:home,context}), {timeout:30000});
  state.containers.push(probeName); saveState(state);
  validatePrivateStorageMounts(JSON.parse(run('docker',['inspect',probeName],{timeout:10000}))[0],home,copy);
  o.docker_mounts_checked = true; saveState(state);
  const started = spawnSync('docker',['start','--attach',probeName],
    {encoding:'utf8',timeout:30000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
  // Preserve bounded diagnostics even if the probe fails; never stream them.
  fs.appendFileSync(path.join(locations().output,'workload.log'),
    `\n=== trusted storage preflight (not dependency execution) ===\n${(started.stdout || '').slice(0,65536)}\n${(started.stderr || '').slice(0,65536)}\n`,
    {mode:0o600});
  assert(!started.error && started.status === 0, 'Storage preflight failed');
  const finished = JSON.parse(run('docker',['inspect',probeName],{timeout:10000}))[0].State;
  assert(finished.Status === 'exited' && finished.ExitCode === 0 && finished.OOMKilled === false,
    'Storage preflight failed');
  o.initial = JSON.parse(started.stdout); o.observed_at = now(); saveState(state);
  validateGradioStorageObservation(o,policy); // insufficient space => no pip; no cleanup/fallback
  return home;
}

export function containerArgs({name, network, copy, plan, marker, storageHome, context}) {
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
  if (storageHome) {
    const expectedStorage = context && gradioStoragePolicy(context.snapshot, context.executed_sha);
    assert(expectedStorage && equalData(plan.storage_policy, expectedStorage) &&
      /^[A-Za-z0-9_/-]+$/.test(storageHome) && path.isAbsolute(storageHome) &&
      /^garnet-gradio-home-\d+-(base|head)-[A-Za-z0-9]+$/.test(path.basename(storageHome)),
    'Unbound private disk-home mount');
    allowEnv.TMPDIR = '/home/workload/tmp';
  }
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
    ...(storageHome ? ['--mount', `type=bind,source=${storageHome},target=/home/workload,bind-propagation=rprivate`] :
      ['--tmpfs', '/home/workload:rw,nosuid,nodev,exec,size=4g,uid=10001,gid=10001,mode=0700']),
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
  const fidelity = copyExactSource(state.sourceCopy, copy,
    {snapshot: state.receipt.snapshot, executed_sha: state.receipt.executed_sha});
  assert(equalData(fidelity, state.receipt.source_copy_fidelity), 'Per-workload source copy fidelity mismatch');
  if (fidelity) workload.source_copy_fidelity = fidelity;
  if (state.receipt.source_materialization) {
    const materialization = auditPreparedGoCopy(
      {snapshot: state.receipt.snapshot, executed_sha: state.receipt.executed_sha},
      copy, state.goInventory);
    assert(equalData(materialization, state.receipt.source_materialization), 'Go per-workload copy mismatch');
    workload.source_materialization = materialization;
  }
  assertWorkloadDirectory(copy, workload.directory);
  // chown never follows source symlinks. The container gets only this copy.
  sudo('chown', '-hR', '10001:10001', copy);
  run('docker', ['pull', '--platform', 'linux/amd64', workload.image.digest], {timeout: 600000});
  const storageHome = await prepareGradioStorage(state, workload, copy, name, marker);
  const context = {snapshot: state.receipt.snapshot, executed_sha: state.receipt.executed_sha};
  run('docker', containerArgs({name, network: state.network, copy, plan: workload, marker, storageHome, context}));
  state.containers.push(name);
  saveState(state);
  if (storageHome) validatePrivateStorageMounts(JSON.parse(run('docker',['inspect',name],{timeout:10000}))[0], storageHome, copy);
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
// planned workload needs a package-tool leaf, Docker ancestry AND a captured
// PID or unique marker on non-DNS TCP. Generic init/shell ancestors alone do
// not prove package-tool egress. Keep the broad historical counter unchanged.
const PACKAGE_TOOL = Object.freeze({
  node: /^(node|npm|pnpm|corepack|yarn|bun)$/,
  python: /^(python(?:\d+(?:\.\d+)*)?|pip(?:\d+(?:\.\d+)*)?|uv|poetry)$/,
  go: /^go$/, rust: /^(cargo|rustup)$/,
  ruby: /^(ruby(?:\d+(?:\.\d+)*)?|bundle|bundler|gem)$/,
});
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
  const packageEvidence = [];
  const evidence = receipt.workloads.map(w => {
    const pids = new Set(w.pids.map(String));
    let count = 0, packageCount = 0;
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
        if (pids.has(String(tree.pid)) || markerMatch) {
          count++; // Existing broad counter: preserve publisher compatibility.
          const container = Array.isArray(tree.ancestry) && tree.ancestry.some(x =>
            typeof x === 'string' && ['containerd-shim-runc-v2', 'containerd-shim'].includes(path.posix.basename(x)));
          const packageTool = typeof tree.executable === 'string' &&
            PACKAGE_TOOL[w.ecosystem]?.test(path.posix.basename(tree.executable));
          // Same numeric port contract as the independent publisher, NOT the
          // historical broad "anything except 53" heuristic.
          const nonDnsTcp = peer.remote_ports.some(port => {
            const number = Number(/^(\d+)(?:\s|$)/.exec(String(port))?.[1]);
            return Number.isInteger(number) && number > 0 && number <= 65535 && number !== 53;
          });
          if (container && packageTool && nonDnsTcp) packageCount++;
        }
      }
    }
    packageEvidence.push({workload_id: w.id, package_tool_non_dns_tcp_associations: packageCount});
    return {workload_id: w.id, network_process_associations: count};
  });
  const result = {state: 'valid', sha256: digest(raw), bytes: Buffer.byteLength(raw),
    native_github: {repository: String(g.repository), run_id: String(g.run_id),
      job: String(g.job), sha: String(g.sha), run_attempt: g.run_attempt ?? null},
    egress_peers: peers.length, workload_evidence: evidence, package_tool_evidence: packageEvidence};
  const reason = !evidence.length || evidence.some(e => e.network_process_associations === 0)
    ? 'No network/process evidence attributable to a planned container workload'
    : packageEvidence.some(e => e.package_tool_non_dns_tcp_associations === 0)
      ? 'No package-tool non-DNS TCP evidence attributable to a planned container workload with Docker ancestry'
      : null;
  if (reason) {
    const error = new Error(reason);
    error.profile_result = {...result, state: 'invalid', validation_error: reason};
    throw error;
  }
  return result;
}

// Finalization must retain raw digests/counters even when validation rejects
// a profile. This reports invalid evidence; it never converts failure to GO.
export function retainedProfile(raw, receipt) {
  try { return validateProfile(raw, receipt); }
  catch (error) {
    return error.profile_result ?? {state: 'invalid', sha256: digest(raw), bytes: Buffer.byteLength(raw),
      validation_error: 'Profile schema or identity validation failed'};
  }
}

export function recordingOutcome(r, finalizationFailed) {
  const recording_complete = !finalizationFailed && r.sensor.ready && r.sensor.stopped_cleanly &&
    r.profile.state === 'valid' && r.workloads.length > 0 &&
    r.workloads.every(w => Number.isInteger(w.exit_code) && w.started_at && w.finished_at);
  const workload_success = r.workloads.length > 0 &&
    r.workloads.every(w => w.exit_code === 0 && !w.output_truncated && !w.oom_killed);
  return {
    recording_complete, workload_success,
    workload_exit: r.workloads.find(w => w.exit_code !== 0)?.exit_code ?? (workload_success ? 0 : null),
    status: recording_complete && workload_success ? 'recorded' : 'incomplete-or-failed',
  };
}

async function finalize() {
  const p = locations();
  let state;
  try { state = loadState(); } catch { initialize(); state = loadState(); }
  const r = state.receipt;
  const limits = finalizationLimits(r.snapshot), finalizationStart = performance.now();
  const deadline = finalizationStart + limits.step_minutes * 60000 - 5000;
  const finalRun = (command, args, requested = limits.diagnostic_command_ms) => {
    const remaining = Math.floor(deadline - performance.now());
    assert(remaining > 0, 'Finalization diagnostic/export budget exhausted');
    return run(command, args, {timeout: Math.min(requested, remaining)});
  };
  const finalSudo = (...args) => finalRun('sudo', ['--', ...args]);
  const unitState = () => Object.fromEntries(finalSudo('systemctl', 'show', 'jibril.service',
    '--property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,TimeoutStopUSec,CPUUsageNSec,MemoryCurrent,TasksCurrent'
  ).split('\n').map(line => line.split('=')));
  r.recording_complete = false;
  r.sensor.stopped_cleanly = false;
  r.sensor.finalization_started_at = now();
  r.sensor.finalization_limits = limits;
  saveState(state);
  let failure = false;
  // Stop any lingering workload first. Cancellation/error is never a success.
  for (const name of state.containers) {
    try {
      const status = JSON.parse(finalRun('docker', ['inspect', name]))[0].State;
      if (status.Running) { finalRun('docker', ['stop', '--time', '10', name], 15000); failure = true; }
    } catch { failure = true; }
  }
  try {
    assert(r.sensor.ready, 'Sensor never became ready');
    r.sensor.pre_stop_details = unitState();
    saveState(state);
    assert(r.sensor.pre_stop_details.ActiveState === 'active', 'Sensor ended before finalization');
    assert(systemdDurationMs(r.sensor.pre_stop_details.TimeoutStopUSec) === limits.sensor_stop_seconds * 1000,
      'Effective systemd timeout does not match the selected bounded budget');
    // Leave >=30 seconds after the workload for short recordings to settle.
    await sleep(limits.settle_ms);
    r.sensor.settle_seconds = 30;
    assert(deadline - performance.now() >= limits.stop_command_ms + limits.diagnostic_command_ms,
      'Insufficient remaining finalization budget for the full stop and state query');
    r.sensor.stop_command_timeout_ms = limits.stop_command_ms;
    r.sensor.stop_started_at = now();
    saveState(state);
    const stopStart = performance.now();
    try {
      finalRun('sudo', ['--', 'systemctl', 'stop', 'jibril.service'], limits.stop_command_ms);
    } finally {
      // Even a stop subprocess error must not discard available unit state.
      r.sensor.stop_elapsed_ms = Math.round(performance.now() - stopStart);
      r.sensor.stop_finished_at = now();
      saveState(state);
      r.sensor.stop_details = unitState();
      saveState(state);
    }
    const fields = r.sensor.stop_details;
    assert(fields.ActiveState === 'inactive' && fields.SubState === 'dead' &&
      fields.Result === 'success' && fields.ExecMainStatus === '0', 'Sensor did not stop/flush cleanly');
    r.sensor.stopped_cleanly = true;
    r.sensor.stopped_at = now();
  } catch {
    failure = true;
    r.sensor.finalization_error = 'Sensor did not become ready or stop/flush cleanly within the bounded finalization';
  }
  // An unclean stop can still leave diagnostic raw bytes. Retain them, but
  // failure above remains sticky: even a valid partial profile cannot give GO.
  try {
    const profile = '/var/log/jibril.profile.json';
    finalSudo('test', '-f', profile);
    finalSudo('test', '!', '-L', profile);
    finalSudo('test', '-s', profile);
    finalSudo('cp', '--no-dereference', profile, path.join(p.output, 'jibril.profile.json'));
    finalSudo('chown', `${process.getuid()}:${process.getgid()}`, path.join(p.output, 'jibril.profile.json'));
    const raw = readBounded(path.join(p.output, 'jibril.profile.json'));
    r.profile = retainedProfile(raw, r);
    assert(r.profile.state === 'valid', 'Raw profile did not satisfy strict workload evidence');
  } catch {
    failure = true;
    r.profile.state = fs.existsSync(path.join(p.output, 'jibril.profile.json')) ? 'invalid' : 'missing';
  }
  r.sensor.finalization_elapsed_ms = Math.round(performance.now() - finalizationStart);
  if (r.sensor.finalization_elapsed_ms >= limits.step_minutes * 60000) failure = true;
  if (failure) r.finalization_error = 'Missing/invalid profile, no package-tool workload evidence, or unclean sensor lifecycle; review retained raw bytes and trusted stop details';
  Object.assign(r, recordingOutcome(r, failure));
  r.finalized_at = now();
  const log = fs.readFileSync(path.join(p.output, 'workload.log'));
  r.workload_log = {sha256: digest(log), bytes: log.length};
  saveState(state);
  assert(r.recording_complete && r.workload_success, 'Recording incomplete or workload failed; artifacts retained');
}

export function validateReviewedExceptions(r, s = r.snapshot) {
  assert(r.reviewed_exceptions_version === REVIEWED_EXCEPTIONS_VERSION, 'Reviewed exceptions capability mismatch');
  const expected = reviewedExceptionContract({snapshot: s, executed_sha: r.executed_sha});
  assert(Array.isArray(r.workloads) && r.workloads.length > 0, 'Missing workloads for reviewed exception checks');
  assert(equalData(r.source_copy_fidelity, expected.source_copy_fidelity ?? undefined),
    'Missing, unexpected or altered reviewed source copy fidelity');
  if (expected.manager_selection || expected.source_copy_fidelity) {
    assert(r.workloads.length === 1, 'Reviewed exception workload scope mismatch');
  }
  for (const w of r.workloads) {
    assert(equalData(w.manager_selection, expected.manager_selection ?? undefined),
      'Missing, unexpected or altered reviewed manager selection');
    assert(equalData(w.source_copy_fidelity, expected.source_copy_fidelity ?? undefined),
      'Missing, unexpected or altered workload copy fidelity');
    if (expected.manager_selection) {
      assert(w.id === 'node:sema4ai:' && w.directory === 'sema4ai' && w.ecosystem === 'node' &&
        w.locked === true && w.scope === 'reviewed-yarn-locked-install-with-lifecycle-hooks-no-explicit-workspace-build' &&
        equalData(w.commands, reviewedExtensionCommands()) &&
        equalData([...(w.changed_manifests ?? [])].sort(), [...REVIEWED_EXTENSION.manifests].sort()),
      'Reviewed Yarn workload commands/scope mismatch');
    }
    if (expected.source_copy_fidelity) {
      assert(w.id === 'node:.:' && w.directory === '.' && w.ecosystem === 'node' &&
        equalData([...(w.changed_manifests ?? [])].sort(), [...REVIEWED_NEXT.manifests].sort()),
      'Reviewed source-copy workload scope mismatch');
    }
  }
  return {
    version: REVIEWED_EXCEPTIONS_VERSION,
    manager_selection_policy: expected.manager_selection?.policy_id ?? null,
    source_copy_policy: expected.source_copy_fidelity?.policy_id ?? null,
  };
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
  validateStopExperiment(r, s);
  assert(r.isolation?.network?.docker_user_enforced === true &&
    r.isolation.network.host_input_blocked === true, 'Missing network containment evidence');
  assert(Array.isArray(r.workloads) && r.workloads.length > 0 && r.workloads.length <= 12,
    'No workload evidence');
  validateReviewedExceptions(r, s);
  validateReviewedPythonRuntimeWorkloads(r, s, images);
  validateReviewedDirectoryWorkloads(r, s, images);
  validateGoReceipt(r, s, REVIEWED_EXCEPTIONS_VERSION);
  validateGradioStorageReceipt(r, s);
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
  const summary = {schema: 1, policy: POLICY, snapshot: s, recording_verified: false, verified: false,
    reviewed_exceptions_version: REVIEWED_EXCEPTIONS_VERSION,
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
      assert(equalData(r.profile.package_tool_evidence, checked.package_tool_evidence),
        'Package-tool profile evidence mismatch');
      const log = readBounded(path.join(directory, 'workload.log'), MAX_LOG);
      assert(log.length <= MAX_LOG && r.workload_log.sha256 === digest(log) &&
        r.workload_log.bytes === log.length, 'Workload log digest mismatch');
      summary.sides.push({side, executed_sha: r.executed_sha, profile_sha256: checked.sha256,
        recorder_script_sha256: r.recorder_script_sha256, recorder_helpers_sha256: r.recorder_helpers_sha256,
        reviewed_exception_validation: validateReviewedExceptions(r, s),
        reviewed_python_runtime_validation: validateReviewedPythonRuntimeWorkloads(r, s, images),
        reviewed_storage_validation: validateGradioStorageReceipt(r, s),
        reviewed_directory_git_validation: validateReviewedDirectoryWorkloads(r, s, images),
        ...(r.source_materialization ? {source_materialization: r.source_materialization,
          go_submodule_validation: validateGoReceipt(r, s, REVIEWED_EXCEPTIONS_VERSION)} : {}),
        ...(r.source_copy_fidelity ? {source_copy_fidelity: r.source_copy_fidelity} : {}),
        profile_job: r.profile_job, workloads: r.workloads, evidence: checked.workload_evidence,
        package_tool_evidence: checked.package_tool_evidence});
    }
    const [base, head] = summary.sides;
    assert(JSON.stringify(base.workloads.map(w => w.id)) === JSON.stringify(head.workloads.map(w => w.id)),
      'Base/head workload targets differ; review scope before comparison');
    summary.command_policy_diverged = base.workloads.some((w, i) =>
      JSON.stringify(w.commands) !== JSON.stringify(head.workloads[i].commands));
    summary.comparison_scope_equivalent = !summary.command_policy_diverged;
    summary.recording_verified = true;
    summary.verified = !summary.command_policy_diverged;
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
    `## Garnet Dependabot recording\n\n${summary.recording_verified ? (summary.command_policy_diverged ? 'Both recordings verified; comparison HOLD because command policies differ.' : 'Recording verified for both exact source revisions.') : 'HOLD: recording is incomplete or validation failed.'}\n\nThis is not a safety verdict or PR approval. See the verification artifact for exact provenance.\n`);
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
