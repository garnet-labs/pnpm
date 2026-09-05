#!/usr/bin/env node
// Local, dry-run-first publisher. MAIN alone may invoke --publish after the pilot.
// Never executes repository/artifact code; no approval, merge, workflow, or git writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual as equal} from 'node:util';
import {isIP} from 'node:net';

const ROOT = '/home/user/workspace';
const WORKFLOW = '.github/workflows/garnet-dependabot-record.yml';
const SCRIPT = '.github/scripts/garnet-dependabot-record.mjs';
const POLICY = 'garnet-dependabot-container-v1';
const POLICY_V2 = 'garnet-dependabot-container-v2';
const HELPER = '.github/scripts/garnet-additional-lockfiles.mjs';
const PUBLISH_WORKFLOW = '.github/workflows/garnet-dependabot-publish.yml';
const ACTION = 'e546567a72e4fede11ec39d6e9f75b539adef22c';
const CONTEXT = 'Garnet Dependabot recording';
const SHA = /^[a-f0-9]{40}$/;
const IMAGE = /^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/;
const MB = 1024 * 1024;
const check = (ok, reason) => { if (!ok) throw new Error(reason); };
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const strings = a => Array.isArray(a) && a.every(x => typeof x === 'string');
const date = x => typeof x === 'string' ? Date.parse(x) : NaN;
const parse = raw => { try { return JSON.parse(raw); } catch { throw new Error('invalid_json'); } };
const artifactName = (run, attempt, side) => `garnet-record-${run}-${attempt}-${side}`;
const marker = (repo, pr) => `<!-- garnet-dependabot-recording:v1 repo=${repo} pr=${pr} -->`;
const escape = x => String(x ?? 'not recorded').replace(/[&<>"`|\r\n]/g,
  c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', '`':'&#96;', '|':'&#124;', '\r':' ', '\n':' '})[c]);
const code = x => `<code>${escape(x)}</code>`;
const nonDnsPorts = e => e.ports.map(p => Number(/^(\d+)(?:\s|$)/.exec(p)?.[1]))
  .filter(p => Number.isInteger(p) && p > 0 && p <= 65535 && p !== 53);
const nonDnsTcp = e => e.protocol === 'TCP' && nonDnsPorts(e).length > 0;
const distinct = (rows, key) => [...new Map(rows.map(row => [key(row), row])).values()];

// Independent, inline allowlist. Never import/evaluate the fetched recorder or
// trust artifact-provided manager authority. Source capability alone opts in.
export function reviewedExceptionsCapability(bytes) {
  const text = bytes.toString('utf8');
  if (!text.includes('REVIEWED_EXCEPTIONS_VERSION')) return 0;
  const declarations = [...text.matchAll(/^\s*export\s+const\s+REVIEWED_EXCEPTIONS_VERSION\s*=\s*([^;\r\n]+);/gm)];
  check(declarations.length === 1 && ['1', '2'].includes(declarations[0][1].trim()),
    'unsupported_reviewed_exceptions_capability');
  return Number(declarations[0][1].trim());
}

const REVIEWED_YARN = {
  repository: 'garnet-labs/vscode-extension-test', repository_id: '899092823', pr: 5,
  base: '393e349d14a10f2db1ce266c42db378ac6391a93', head: 'f43f9f252cab4c3ee9f29a7bcf58f859a35b759b',
  manifests: ['sema4ai/package-lock.json', 'sema4ai/yarn.lock'],
};
const REVIEWED_COPY = {
  repository: 'garnet-labs/next.js', repository_id: '1206332346', pr: 40,
  base: '2d069943639fd0fc67a26bbb337d8a726f50924d', head: 'bcae068be948a03cba54813aea6cffb5c03adf63',
  manifests: ['package.json', 'pnpm-lock.yaml'],
};
const YARN_SCOPE = 'reviewed-yarn-locked-install-with-lifecycle-hooks-no-explicit-workspace-build';
export function reviewedYarnCommands() {
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
const exactManifestSet = (a, b) => strings(a) && equal([...a].sort(), [...b].sort());
export function expectedReviewedExceptions(s, executed) {
  const matches = p => s?.repository === p.repository && s.repository_id === p.repository_id &&
    s.pr_number === p.pr && s.baseline_sha === p.base && s.head?.sha === p.head &&
    [p.base, p.head].includes(executed) && exactManifestSet(s.manifests, p.manifests);
  return {
    manager_selection: matches(REVIEWED_YARN) ? {
      policy_id: 'vscode-extension-test-pr5-sema4ai-yarn-v1',
      manager: 'yarn', version: '1.22.22', version_authority: 'trusted-classic-lock-fallback',
      selected_lockfile: 'sema4ai/yarn.lock',
      unused_competing_lockfiles: ['sema4ai/package-lock.json'],
      changed_lockfiles_not_independently_exercised: ['sema4ai/package-lock.json'],
      authority_blobs: {
        '.github/workflows/release-robocorp-code-vscode.yml': '41a3063623d70bc9d6c61f7b0aa85c42db85481d',
        '.github/workflows/pre-release-robocorp-code.yml': 'da08cb83e92c0a6576bdf824f2d2dbe6b20dd07a',
        'sema4ai/package.json': '448bde4b09f254aee686b3bf63362c619bc60ff6',
      },
      authority_commit_pair: [REVIEWED_YARN.base, REVIEWED_YARN.head],
      source_lock_blobs: executed === REVIEWED_YARN.base ? {
        'sema4ai/yarn.lock': 'a2e2ba93941e47895ba816f633f3bff22f30c08e',
        'sema4ai/package-lock.json': '322988a2e68ed3d3a2b5bdd11cceedaca9ded1f2',
      } : {
        'sema4ai/yarn.lock': '38877bfff2c010707b9998c37cd3102f56630490',
        'sema4ai/package-lock.json': '785df566266e81c25259a41390be9ded26889201',
      },
    } : null,
    source_copy_fidelity: matches(REVIEWED_COPY) ? {
      policy_id: 'nextjs-pr40-exact-fixture-link-preservation-v1',
      method: 'no-dereference-copy', git_metadata_excluded: true,
      excluded_tracked_source_paths: [], rewritten_symlink_targets: [],
      preserved_opaque_symlinks: [{
        path: 'test/development/app-dir/ssr-in-rsc/node_modules/random-react-library',
        target: '/Users/sebbie/repos/next.js/test/development/app-dir/ssr-in-rsc/random-react-library/',
        blob_sha: '07ab05517e672a857a940573789969bfb1de3848', host_target_resolved: false,
      }],
      fidelity: 'regular-file bytes and symlink target bytes preserved; existing git-metadata exclusion and executable-mode normalization unchanged',
    } : null,
  };
}
function exactExceptionField(object, key, expected) {
  check(expected == null ? !Object.hasOwn(object, key) : equal(object[key], expected),
    'missing_or_forged_reviewed_exception_metadata');
}
function absentExceptionFields(object, fields) {
  for (const key of fields) exactExceptionField(object, key, null);
}
export function validateReviewedReceipt(r, s, version = 0) {
  check([0, 1, 2].includes(version), 'unsupported_reviewed_exceptions_capability');
  if (version > 0) check(r.reviewed_exceptions_version === version, 'receipt_exception_capability_mismatch');
  else exactExceptionField(r, 'reviewed_exceptions_version', null);
  absentExceptionFields(r, ['manager_selection', 'reviewed_exception_validation']);
  const expected = version > 0 ? expectedReviewedExceptions(s, r.executed_sha)
    : {manager_selection: null, source_copy_fidelity: null};
  exactExceptionField(r, 'source_copy_fidelity', expected.source_copy_fidelity);
  check(Array.isArray(r.workloads) && r.workloads.length > 0, 'missing_reviewed_workloads');
  if (expected.manager_selection || expected.source_copy_fidelity)
    check(r.workloads.length === 1, 'reviewed_workload_scope_mismatch');
  for (const w of r.workloads) {
    absentExceptionFields(w, ['reviewed_exceptions_version', 'reviewed_exception_validation']);
    exactExceptionField(w, 'manager_selection', expected.manager_selection);
    exactExceptionField(w, 'source_copy_fidelity', expected.source_copy_fidelity);
    if (!expected.manager_selection) check(w.scope !== YARN_SCOPE, 'unbound_reviewed_yarn_scope');
    if (expected.manager_selection) check(w.id === 'node:sema4ai:' && w.directory === 'sema4ai' &&
      w.ecosystem === 'node' && w.locked === true && w.scope === YARN_SCOPE &&
      equal(w.commands, reviewedYarnCommands()) && exactManifestSet(w.changed_manifests, REVIEWED_YARN.manifests),
    'reviewed_yarn_scope_or_commands_mismatch');
    if (expected.source_copy_fidelity) check(w.id === 'node:.:' && w.directory === '.' &&
      w.ecosystem === 'node' && exactManifestSet(w.changed_manifests, REVIEWED_COPY.manifests),
    'reviewed_copy_scope_mismatch');
  }
  validateGoReceipt(r, s, version);
  return {version, manager_selection_policy: expected.manager_selection?.policy_id ?? null,
    source_copy_policy: expected.source_copy_fidelity?.policy_id ?? null};
}
export function validateReviewedVerifier(v, row, r, s, version = 0) {
  const validation = validateReviewedReceipt(r, s, version);
  if (version > 0) {
    check(v.reviewed_exceptions_version === version, 'verifier_exception_capability_mismatch');
    check(equal(row.reviewed_exception_validation, validation), 'verifier_exception_policy_mismatch');
  } else {
    exactExceptionField(v, 'reviewed_exceptions_version', null);
    exactExceptionField(row, 'reviewed_exception_validation', null);
  }
  absentExceptionFields(v, ['manager_selection', 'source_copy_fidelity', 'reviewed_exception_validation']);
  absentExceptionFields(row, ['manager_selection', 'reviewed_exceptions_version']);
  exactExceptionField(row, 'source_copy_fidelity', r.source_copy_fidelity);
  validateGoVerifier(v, row, r, s, version);
}

// Independent source-backed policy data. This publisher imports no policy data,
// recorder module, PR module, or extra helper at runtime. Commit/blob/inventory
// constants below were reviewed against the retained immutable source contracts.
const PYTHON_SCOPE = 'reviewed-uv-locked-selected-dependencies-no-workspace-install';
const PYTHON_RULES = {
  'garnet-labs/anthropic-sdk-python': {
    id: 'anthropic-pr11-uv0102-dev-all-extras-python312-v1',
    repository_id: '1206647001', pr_number: 11,
    base: '9a547ef9903f83e8a34556711533802f538fa069',
    head: '5644d1642f3396d3743265f4b75ea1ddc7cf2590',
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
    scope_limit: 'Dependency-selection subset only: one source-supported Python 3.12 interpreter, not native 3.9/3.14 test variants, project build, mock server or pytest',
    caveat: 'Base uv.lock editable anthropic version is 0.88.0 while pyproject version is 0.93.0; retain uv lock --check and report any stale-baseline failure',
  },
  'garnet-labs/openshell-deepagent': {
    id: 'openshell-pr17-python31214-trixie-glibc239-uv0822-v1',
    repository_id: '1206669469', pr_number: 17,
    base: '1fae50e4daa9f9381a51cf19aa84645c5c2367d5',
    head: '0eb44370ff6d22ebc08f57afab977bda97267c92',
    uv: '0.8.22', groups: [], extras: [], excluded_groups: [],
    image: {tag: 'python:3.12.14-trixie',
      digest: 'python@sha256:dabc147823ae8fd8cf9799a80f9e4ddb67eb2238fb9ca5f2ffc774c13a1d59d0',
      platform: 'linux/amd64'}, glibc_min: '2.39',
    authority: {'pyproject.toml': '5ce526f0f9fac5410f83f87a56387e58128e3747',
      'README.md': '86d3211c0038ba4df469fccf44b319d3979a523f'},
    locks: {
      '1fae50e4daa9f9381a51cf19aa84645c5c2367d5': '1febe372bf6100f71959847125487d1adf4cab99',
      '0eb44370ff6d22ebc08f57afab977bda97267c92': 'd3e544c9329caba7c6c5e70b1ccbf7e0fc82781a',
    },
    native_install: 'README uv sync; source defines no dependency groups or optional extras',
    scope_limit: 'External dependency install only; no OpenShell gateway, Docker/k3s sandbox, agent execution, local project build or tests. Fork Garnet CI Python 3.11 conflicts with source >=3.12 and is not used as runtime authority',
    caveat: 'Wheel ABI compatibility is source/manifest-backed and checked at execution; image and complete workload have not been run in this proposal',
  },
};
function sourceCapability(bytes, marker, versions, reason) {
  const text = bytes.toString('utf8');
  if (!text.includes(marker)) return 0;
  const declarations = [...text.matchAll(new RegExp(
    `^\\s*export\\s+const\\s+${marker}\\s*=\\s*([^;\\r\\n]+);`, 'gm'))];
  check(declarations.length === 1 && versions.includes(declarations[0][1].trim()), reason);
  return Number(declarations[0][1].trim());
}
export function reviewedPythonCapability(recorderBytes, helperBytes) {
  const main = sourceCapability(recorderBytes, 'REVIEWED_PYTHON_POLICIES_VERSION', ['1'],
    'unsupported_python_policy_capability');
  const helper = helperBytes === undefined ? 0 :
    sourceCapability(helperBytes, 'REVIEWED_PYTHON_RUNTIME_VERSION', ['1'],
      'unsupported_python_helper_capability');
  check(main === helper, 'python_main_helper_capability_mismatch');
  return main;
}
function pythonRule(s) {
  const rule = Object.hasOwn(PYTHON_RULES, s?.repository ?? '') ? PYTHON_RULES[s.repository] : null;
  if (!rule) return null;
  check(s.repository_id === rule.repository_id && s.pr_number === rule.pr_number &&
    s.baseline_sha === rule.base && s.base?.sha === rule.base && s.head?.sha === rule.head &&
    s.comparison_scope === 'merge-base-to-head' &&
    ['base', 'head'].every(side => s[side].repository === s.repository &&
      s[side].repository_id === rule.repository_id) &&
    equal(s.manifests, ['uv.lock']) && equal(s.changed_files, ['uv.lock']),
  'python_policy_pair_or_scope_mismatch');
  return rule;
}
export function expectedPythonPolicy(s, executed) {
  const rule = pythonRule(s);
  if (!rule) return null;
  check([rule.base, rule.head].includes(executed), 'python_policy_executed_sha_mismatch');
  return {
    version: 1, policy_id: rule.id, repository: s.repository, repository_id: rule.repository_id,
    pr_number: rule.pr_number, baseline_sha: rule.base, head_sha: rule.head, executed_sha: executed,
    authority_blobs: {...rule.authority, 'uv.lock': rule.locks[executed]},
    uv_version: rule.uv, python: '3.12', interpreter: '/usr/local/bin/python3',
    python_downloads: 'never', image: structuredClone(rule.image), glibc_min: rule.glibc_min,
    default_groups: false, selected_groups: [...rule.groups], selected_extras: [...rule.extras],
    excluded_groups: [...rule.excluded_groups], local_project_install: false, lock_check: true,
    frozen_sync: true, lock_and_pyproject_byte_identity: true, native_install: rule.native_install,
    scope_limit: rule.scope_limit, caveat: rule.caveat,
  };
}
export function reviewedPythonCommands(s) {
  const rule = pythonRule(s);
  check(rule, 'unreviewed_python_commands');
  const guard = rule.glibc_min
    ? "import os,sys,platform; assert sys.version_info[:3] == (3,12,14); assert platform.machine() == 'x86_64'; libc=os.confstr('CS_GNU_LIBC_VERSION'); assert libc.startswith('glibc '); assert tuple(map(int,libc.split()[1].split('.')[:2])) >= (2,39); print(sys.version.split()[0],libc)"
    : "import sys; assert sys.version_info[:2] == (3,12); print(sys.version.split()[0])";
  return [
    'py_lock_before="$(/usr/bin/sha256sum uv.lock pyproject.toml)"; readonly py_lock_before',
    `/usr/local/bin/python3 -I -c "${guard}"`,
    `python -m pip install --user uv==${rule.uv}`,
    `py_uv_version="$(uv --version)"; case "$py_uv_version" in 'uv ${rule.uv}'|'uv ${rule.uv} ('*) ;; *) exit 78 ;; esac`,
    'export UV_PYTHON=/usr/local/bin/python3 UV_PYTHON_DOWNLOADS=never',
    'uv lock --check --python /usr/local/bin/python3',
    `uv sync --frozen --no-default-groups ${rule.groups.length ? '--group dev --all-extras ' : ''}--no-install-workspace --python /usr/local/bin/python3`,
    'test "$py_lock_before" = "$(/usr/bin/sha256sum uv.lock pyproject.toml)"',
  ];
}
export function validatePythonReceipt(r, s, version = 0) {
  check([0, 1].includes(version), 'unsupported_python_policy_capability');
  absentExceptionFields(r, ['python_runtime_policy', 'reviewed_python_runtime_validation']);
  const policy = version === 1 ? expectedPythonPolicy(s, r.executed_sha) : null;
  check(Array.isArray(r.workloads), 'missing_python_policy_workloads');
  if (!policy) {
    for (const w of r.workloads) {
      absentExceptionFields(w, ['python_runtime_policy', 'reviewed_python_runtime_validation']);
      check(w.scope !== PYTHON_SCOPE, 'unbound_python_policy_scope');
    }
    return [];
  }
  check(r.policy === POLICY_V2 && r.workloads.length === 1, 'python_policy_workload_count_or_policy');
  const w = r.workloads[0];
  check(['base', 'head'].includes(r.side) && r.executed_sha ===
    (r.side === 'base' ? s.baseline_sha : s.head.sha), 'python_policy_side_mismatch');
  absentExceptionFields(w, ['reviewed_python_runtime_validation']);
  check(w.id === 'python:.:' && w.ecosystem === 'python' && w.directory === '.' && w.locked === true &&
    w.scope === PYTHON_SCOPE && w.note === `${policy.scope_limit}; ${policy.caveat}` &&
    equal(w.changed_manifests, ['uv.lock']) && equal(w.commands, reviewedPythonCommands(s)) &&
    equal(w.python_runtime_policy, policy), 'python_policy_workload_or_commands_mismatch');
  const image = r.images?.python;
  check(image && equal(Object.keys(r.images), ['python']) &&
    image.tag === policy.image.tag && image.platform === 'linux/amd64' &&
    /^(?:python|docker\.io\/library\/python)@sha256:[a-f0-9]{64}$/.test(image.digest) &&
    equal(image, {tag: policy.image.tag, digest: image.digest, platform: 'linux/amd64'}) &&
    equal(w.image, image) && (!policy.image.digest || image.digest === policy.image.digest),
  'python_policy_image_mismatch');
  return [{workload_id: w.id, ...policy}];
}
export function validatePythonVerifier(v, row, r, s, version = 0) {
  const expected = validatePythonReceipt(r, s, version);
  absentExceptionFields(v, ['python_runtime_policy', 'reviewed_python_runtime_validation']);
  absentExceptionFields(row, ['python_runtime_policy']);
  if (version === 1) check(equal(row.reviewed_python_runtime_validation, expected),
    'python_verifier_policy_mismatch');
  else absentExceptionFields(row, ['reviewed_python_runtime_validation']);
}
export function validatePythonControllerImages(text, s, sides, version = 0) {
  if (!version || !pythonRule(s)) return;
  // Only the trusted initialization and fresh verifier step environment headers
  // are authoritative here; workload stdout cannot opt into a resolver result.
  const scopes = [
    [`record (base, ${s.baseline_sha})`, 'Initialize diagnostic receipt', 'base'],
    [`record (head, ${s.head.sha})`, 'Initialize diagnostic receipt', 'head'],
    ['verify', 'Validate complete profiles and exact provenance', 'head'],
  ];
  for (const [job, step, side] of scopes) {
    const matches = text.split(/\r?\n/).flatMap(line => {
      const pieces = line.split('\t');
      if (pieces.length !== 3 || pieces[0] !== job || pieces[1] !== step) return [];
      const match = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s{3}RECORDER_IMAGES: (\{.*\})$/.exec(pieces[2]);
      return match ? [parse(match[1])] : [];
    });
    check(matches.length === 1 && equal(matches[0], sides[side]?.receipt?.images),
      'python_controller_resolved_image_mismatch');
  }
}
// Source-backed, additive contracts. No artifact code or extra runtime helper.
export function reviewedDirectoryCapability(mainBytes, helperBytes) {
  const main = sourceCapability(mainBytes, 'REVIEWED_DIRECTORY_POLICIES_VERSION', ['1'],
    'unsupported_directory_policy_capability');
  const helper = helperBytes === undefined ? 0 : sourceCapability(helperBytes,
    'REVIEWED_DIRECTORY_EMPTY_GIT_VERSION', ['1'], 'unsupported_directory_helper_capability');
  check(main === helper, 'directory_main_helper_capability_mismatch');
  return main;
}
export function reviewedStorageCapability(mainBytes) {
  return sourceCapability(mainBytes, 'REVIEWED_STORAGE_POLICIES_VERSION', ['1'],
    'unsupported_storage_policy_capability');
}
export function recordingResultCapability(mainBytes) {
  return sourceCapability(mainBytes, 'RECORDING_RESULT_CONTRACT_VERSION', ['1'],
    'unsupported_recording_result_capability');
}
const COMPARISON_HOLD_REASON = 'Both records validated, but command policy differs; do not claim a scope-equivalent dependency comparison';
export function validateVerifierResult(v, matched, version = 0, scriptHash, helperHashes) {
  check(typeof matched === 'boolean' && [0, 1].includes(version), 'invalid_recording_result_contract');
  if (version === 1) {
    check(v.recording_verified === true && v.verified === matched &&
      v.command_policy_diverged === !matched && v.comparison_scope_equivalent === matched &&
      v.decision === (matched ? 'RECORDING_VERIFIED' : 'HOLD'), 'recording_comparison_flags_mismatch');
    if (matched) absentExceptionFields(v, ['hold_reason']);
    else check(v.hold_reason === COMPARISON_HOLD_REASON, 'comparison_hold_reason_mismatch');
    return;
  }
  absentExceptionFields(v, ['recording_verified']);
  check(v.verified === true, 'independent_verifier_not_verified');
  // Audited historical producers overloaded verified=true on divergent HOLD.
  // The added d35 path requires its exact helper too, using trusted source hashes,
  // not verifier claims. This never awards a matched-comparison status.
  const historicalProducer = scriptHash === 'ff57d4dae02c6c780bd2fe7ea4f2895d17c93e20921e3df99b43bf1ad01cef80' ||
    (scriptHash === 'd35e9047f34927865c3df8ec619f4b350a7e152fe7b4dc7e276cfb50d9d09e09' &&
      helperHashes && equal(helperHashes, {[HELPER]: '520c1ce90b1687367ae9550547301f1684daea0cdf1a5c65adf2d09c0b8fc3ee'}));
  const historicalHold = historicalProducer &&
    matched === false && v.decision === 'HOLD' && v.command_policy_diverged === true &&
    v.comparison_scope_equivalent === false && v.hold_reason === COMPARISON_HOLD_REASON;
  check(v.decision === 'RECORDING_VERIFIED' || historicalHold, 'independent_verifier_not_verified');
}
const DIRECTORY_RULE = {
  repository: 'garnet-labs/directory-connector', repository_id: '1219214388', pr_number: 23,
  base: '499a21ff15ab6685f176031f0bb02de969091e7f', head: 'eb785521e836e327788e0731dac773e7a771468f',
  image: {tag: 'node:25-bookworm', digest: 'node@sha256:0efb427ff710f4943bb3f0641bd3e9ef1ac3cec96c526b67a21b43740becab1f', platform: 'linux/amd64'},
  authority: {'package.json': '0ba2ca85b2973c2b34bf7a06c1939840b89a7b00',
    '.nvmrc': 'a682cfb975e0e399490230af930b378b3125f137',
    '.npmrc': '860dc500f0deaed8939cfec299e5f0303a867a9f',
    '.github/workflows/test.yml': '5fd2168d2f15bd3f9098f5f43ad5f3b9f52f1e45',
    'native/package.json': '70103484e61d5cd740c5ebf40d564e0259ca6ca3'},
  sides: {
    '499a21ff15ab6685f176031f0bb02de969091e7f': {
      lock: 'ce3555226da4d2eff6d5a137c73a9a84cc54cfa0',
      inventory: '7fa010a57e092bbc193a77146aa47439bba8d4246f78f4c931a9e4aa9e42ae4d'},
    'eb785521e836e327788e0731dac773e7a771468f': {
      lock: '1ca9203c5507141c4bc68c852a1a592e3f7f7adc',
      inventory: '7b0461fb0f9569ac9e94d70f6703e6b22b75e6d20cc9bda05003cc1a8ee48d67'},
  },
  scope: 'reviewed-npm-ci-with-lifecycle-hooks-and-synthetic-empty-git',
  note: 'Dependency install with existing lifecycle hooks only. Synthetic empty Git metadata is created inside the credential-free container; original host .git is excluded. This is not full-Git or native-CI fidelity: no commits, origin, native-module build, typechecking, tests, app build or packaging is supplied or claimed.',
};
export function expectedDirectoryPolicy(s, executed) {
  const p = DIRECTORY_RULE;
  if (s?.repository !== p.repository) return null;
  check(s.repository_id === p.repository_id && s.pr_number === p.pr_number &&
    s.baseline_sha === p.base && s.base?.sha === p.base && s.head?.sha === p.head &&
    [s.base, s.head].every(x => x.repository === p.repository && x.repository_id === p.repository_id) &&
    equal(s.manifests, ['package-lock.json']) && equal(s.changed_files, ['package-lock.json']),
  'directory_pair_or_scope_mismatch');
  check(Object.hasOwn(p.sides, executed), 'directory_executed_sha_mismatch');
  const side = p.sides[executed];
  return {version: 1, policy_id: 'directory-connector-pr23-empty-git-node25-npm10-v1',
    repository: p.repository, repository_id: p.repository_id, pr_number: p.pr_number,
    baseline_sha: p.base, head_sha: p.head, executed_sha: executed,
    authority_blobs: {...p.authority, 'package-lock.json': side.lock},
    source_tree: {scheme: 'git-ls-tree-normalized-v1', executed_sha: executed, tracked_entries: 338,
      tree_manifest_sha256: side.inventory, gitlinks: [], gitmodules: []},
    image: structuredClone(p.image), node_version: '25.9.0', npm_version: '10.9.8',
    node_authority: '.nvmrc v25 and engines.node ~25; verified official image supplies exact 25.9.0',
    npm_authority: 'engines.npm ~10; 10.9.8 is an existing official compatible release, not a native CI exact pin',
    synthetic_git_metadata: true, creation_location: 'credential-free-nonroot-workload-container:/work/.git',
    host_git_metadata_copied: false, source_commits_imported: false, remotes: [], index_entries: [],
    initial_templates: 'empty', system_and_global_git_config: 'disabled',
    lifecycle_scripts: 'unchanged-and-enabled', husky: 'unchanged-and-enabled; may set local core.hooksPath normally',
    source_lock_and_manifest_bytes_unchanged_on_success: true, full_git_fidelity: false,
    native_ci_fidelity: false, scope_limit: p.note};
}
export function reviewedDirectoryCommands() {
  const guards = [
    'test -d .git && test ! -L .git',
    'dc_git_root=$(/usr/bin/git rev-parse --show-toplevel); test "$dc_git_root" = /work',
    'dc_git_remote=$(/usr/bin/git remote); test -z "$dc_git_remote"',
    'dc_git_index=$(/usr/bin/git ls-files); test -z "$dc_git_index"',
    'test -d .git/objects && test ! -L .git/objects; dc_git_objects=$(/usr/bin/find .git/objects ! -type d -print -quit); test -z "$dc_git_objects"',
    'if /usr/bin/git show-ref --head >/dev/null 2>&1; then exit 78; else test "$?" -eq 1; fi',
    'if /usr/bin/git config --local --name-only --get-regexp "^(remote[.]|credential[.]|include[.]|includeif[.])" >/dev/null; then exit 78; else test "$?" -eq 1; fi',
  ];
  return [
    'dc_source_before=$(/usr/bin/sha256sum package-lock.json package.json .nvmrc .npmrc); readonly dc_source_before',
    'test "$(/usr/local/bin/node --version)" = v25.9.0',
    'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0',
    'npm install --global --prefix /home/workload/npm npm@10.9.8',
    'export PATH="/home/workload/npm/bin:$PATH"',
    'test "$(npm --version)" = 10.9.8',
    'test ! -e .git && test ! -L .git && test ! -e .gitmodules && test ! -L .gitmodules',
    'git -c init.templateDir= init', ...guards, 'npm ci --no-audit --no-fund', ...guards,
    'test ! -e .gitmodules && test ! -L .gitmodules',
    'test "$dc_source_before" = "$(/usr/bin/sha256sum package-lock.json package.json .nvmrc .npmrc)"',
  ];
}
export function validateDirectoryReceipt(r, s, version = 0) {
  check([0, 1].includes(version), 'unsupported_directory_policy_capability');
  absentExceptionFields(r, ['synthetic_git_policy', 'reviewed_directory_git_validation']);
  const p = version ? expectedDirectoryPolicy(s, r.executed_sha) : null;
  check(Array.isArray(r.workloads), 'missing_directory_workloads');
  for (const w of r.workloads) {
    exactExceptionField(w, 'synthetic_git_policy', p);
    absentExceptionFields(w, ['reviewed_directory_git_validation']);
    if (!p) check(w.scope !== DIRECTORY_RULE.scope, 'unbound_directory_scope');
  }
  if (!p) return [];
  check(r.side === 'base' || r.side === 'head', 'directory_side_mismatch');
  check(r.executed_sha === (r.side === 'base' ? s.baseline_sha : s.head.sha), 'directory_side_mismatch');
  check(r.workloads.length === 1, 'directory_workload_count');
  const w = r.workloads[0];
  check(w.id === 'node:.:' && w.ecosystem === 'node' && w.directory === '.' && w.locked === true &&
    w.scope === DIRECTORY_RULE.scope && w.note === DIRECTORY_RULE.note &&
    equal(w.changed_manifests, ['package-lock.json']) && equal(w.commands, reviewedDirectoryCommands()),
  'directory_exact_workload_mismatch');
  check(equal(r.images, {node: p.image}) && equal(w.image, p.image), 'directory_exact_image_mismatch');
  return [{workload_id: w.id, ...p}];
}
export function validateDirectoryVerifier(v, row, r, s, version = 0) {
  absentExceptionFields(v, ['synthetic_git_policy', 'reviewed_directory_git_validation']);
  absentExceptionFields(row, ['synthetic_git_policy']);
  const expected = validateDirectoryReceipt(r, s, version);
  if (version) check(equal(row.reviewed_directory_git_validation, expected), 'directory_verifier_policy_mismatch');
  else absentExceptionFields(row, ['reviewed_directory_git_validation']);
}
const STORAGE_DISKS = {61267: ['ext2/ext3', 'ext4'], 1481003842: ['xfs'], 2435016766: ['btrfs']};
export function expectedStoragePolicy(s, executed) {
  if (s?.repository !== 'garnet-labs/gradio-test' || s.pr_number !== 4 ||
    !Array.isArray(s.manifests) || !s.manifests.includes('test/requirements.txt')) return null;
  const base = '55041996db69b086ee2a5116ad3db40bced6b056', head = '36f97efa0200792ebc2b1fea5f32f2cd28efc5eb';
  check(s.repository_id === '899240340' && s.baseline_sha === base && s.pr_base_tip === base &&
    s.base?.sha === base && s.head?.sha === head &&
    [s.base, s.head].every(x => x.repository === s.repository && x.repository_id === s.repository_id) &&
    s.comparison_scope === 'merge-base-to-head' && s.event === 'workflow_dispatch' && s.run_attempt === '1' &&
    equal(s.manifests, ['test/requirements.txt']) && equal(s.changed_files, s.manifests) &&
    [base, head].includes(executed), 'storage_pair_or_scope_mismatch');
  return {version: 1, policy_id: 'gradio-pr4-private-disk-home-v1',
    repository: s.repository, repository_id: s.repository_id, pr_number: 4,
    baseline_sha: base, head_sha: head, executed_sha: executed,
    requirements_blob: executed === base ? 'ff75a5c4be16f7cb948ae5585d38b691820f4834' : '29a22d53b4766c091e56bb0970e6c72b11f82257',
    home: '/home/workload', tmpdir: '/home/workload/tmp', home_backing: 'fresh-private-runner-temp-disk-directory',
    initial_home_contents: ['tmp'], uid: 10001, gid: 10001, mode: 448,
    tmpfs_tmp_bytes: 2147483648, minimum_disk_available_bytes: 17179869184,
    minimum_disk_available_inodes: 65536, minimum_tmp_available_bytes: 1073741824,
    permitted_disk_types: ['ext2/ext3', 'ext4', 'xfs', 'btrfs'],
    preflight: 'trusted-image-python-isolated-mode-no-source-execution-network-none',
    memory_bytes: 5368709120, cpus: 2, workload_timeout_seconds: 900, job_minutes: 45,
    dependency_command_unchanged: true, admission_is_peak_usage_guarantee: false};
}
function exactKeys(value, keys) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    equal(Object.keys(value).sort(), [...keys].sort()), 'storage_observation_shape_mismatch');
}
function storageNumbers(value, keys) {
  check(keys.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0), 'invalid_storage_measurement');
  check(value.block_bytes > 0 && value.available_blocks <= value.free_blocks &&
    value.free_blocks <= value.blocks && value.free_inodes <= value.inodes, 'inconsistent_storage_capacity');
  check(['blocks', 'free_blocks', 'available_blocks'].every(k =>
    Number.isSafeInteger(value[k] * value.block_bytes)), 'unsafe_storage_byte_capacity');
}
export function validateStorageObservation(o) {
  // Thresholds are trusted constants, not an observation/policy-selected argument.
  exactKeys(o, ['schema', 'created_empty', 'tmp_created_empty', 'host_uid', 'host_gid', 'host_mode',
    'host_home', 'host_work', 'docker_mounts_checked', 'observed_at', 'initial']);
  check(o.schema === 1 && o.created_empty === true && o.tmp_created_empty === true &&
    o.host_uid === 10001 && o.host_gid === 10001 && o.host_mode === 448 &&
    o.docker_mounts_checked === true && Number.isFinite(date(o.observed_at)), 'storage_creation_or_mount_unverified');
  const hostKeys = ['type', 'block_bytes', 'blocks', 'free_blocks', 'available_blocks', 'inodes', 'free_inodes'];
  for (const host of [o.host_home, o.host_work]) {
    exactKeys(host, hostKeys); storageNumbers(host, hostKeys);
    check(Object.hasOwn(STORAGE_DISKS, host.type) && host.available_blocks * host.block_bytes >= 17179869184 &&
      host.free_inodes >= 65536, 'insufficient_or_nondisk_host_storage');
  }
  exactKeys(o.initial, ['schema', 'phase', 'paths', 'df']);
  check(o.initial.schema === 1 && o.initial.phase === 'before-untrusted-workload' &&
    Array.isArray(o.initial.paths) && equal(o.initial.paths.map(r => r?.path), ['/home/workload', '/tmp', '/work']) &&
    typeof o.initial.df === 'string' && o.initial.df.length < 4096, 'invalid_storage_probe');
  const df = o.initial.df.trim().split('\n');
  check(df.length === 4 && df[0].startsWith('Filesystem'), 'invalid_storage_df');
  const rowKeys = ['path', 'device', 'block_bytes', 'blocks', 'free_blocks', 'available_blocks',
    'inodes', 'free_inodes', 'available_inodes'];
  for (let i = 0; i < 3; i++) {
    const row = o.initial.paths[i];
    exactKeys(row, rowKeys); storageNumbers(row, rowKeys.filter(k => k !== 'path'));
    check(row.available_inodes <= row.free_inodes, 'invalid_storage_available_inodes');
    const m = /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\S+)$/.exec(df[i + 1]);
    check(m && m[7] === row.path, 'storage_df_path_or_shape_mismatch');
    const total = Number(m[3]), used = Number(m[4]), available = Number(m[5]), percent = Number(m[6]);
    check([total, used, available, percent].every(Number.isSafeInteger) &&
      total === row.blocks * row.block_bytes && used <= total && available <= total &&
      used + available <= total && percent <= 100, 'storage_df_capacity_mismatch');
    if (i === 1) check(m[2] === 'tmpfs' && total === 2147483648 && available >= 1073741824 &&
      row.available_blocks * row.block_bytes >= 1073741824, 'storage_tmp_backing_or_capacity');
    else {
      const host = i === 0 ? o.host_home : o.host_work;
      check(STORAGE_DISKS[host.type].includes(m[2]) && total === host.blocks * host.block_bytes &&
        available >= 17179869184 && row.available_blocks * row.block_bytes >= 17179869184 &&
        row.available_inodes >= 65536, 'insufficient_or_unproven_container_disk');
    }
  }
  return o;
}
export function validateStorageReceipt(r, s, version = 0) {
  check([0, 1].includes(version), 'unsupported_storage_policy_capability');
  absentExceptionFields(r, ['storage_policy', 'storage_observation', 'reviewed_storage_validation']);
  const p = version ? expectedStoragePolicy(s, r.executed_sha) : null;
  check(Array.isArray(r.workloads), 'missing_storage_workloads');
  for (const w of r.workloads) {
    exactExceptionField(w, 'storage_policy', p);
    absentExceptionFields(w, ['reviewed_storage_validation']);
    if (!p) absentExceptionFields(w, ['storage_observation']);
  }
  if (!p) return [];
  check(['base', 'head'].includes(r.side) && r.executed_sha ===
    (r.side === 'base' ? s.baseline_sha : s.head.sha), 'storage_side_mismatch');
  check(r.workloads.length === 1, 'storage_workload_count');
  const w = r.workloads[0];
  check(w.id === 'python:test:requirements.txt' && w.ecosystem === 'python' && w.directory === 'test' &&
    w.scope === 'requirements-install' && w.locked === false &&
    equal(w.changed_manifests, ['test/requirements.txt']) &&
    equal(w.commands, ["python -m pip install -r 'requirements.txt'"]), 'storage_exact_workload_mismatch');
  validateStorageObservation(w.storage_observation);
  check(date(w.storage_observation.observed_at) <= date(w.started_at), 'storage_observation_after_workload');
  exactKeys(w.image, ['tag', 'digest', 'platform']);
  check(w.image.tag === 'python:3.10-bookworm' && w.image.platform === 'linux/amd64' &&
    /^python@sha256:[a-f0-9]{64}$/.test(w.image.digest) && equal(r.images, {python: w.image}),
  'storage_unchanged_immutable_image_mismatch');
  return [{workload_id: w.id, policy_id: p.policy_id, executed_sha: r.executed_sha,
    storage_admission_verified: true, peak_usage_guaranteed: false}];
}
export function validateStorageVerifier(v, row, r, s, version = 0) {
  absentExceptionFields(v, ['storage_policy', 'storage_observation', 'reviewed_storage_validation']);
  absentExceptionFields(row, ['storage_policy', 'storage_observation']);
  const expected = validateStorageReceipt(r, s, version);
  if (version) check(equal(row.reviewed_storage_validation, expected), 'storage_verifier_policy_mismatch');
  else absentExceptionFields(row, ['reviewed_storage_validation']);
}
export function validateAdditionalControllerImages(text, s, sides) {
  const scopes = [
    [`record (base, ${s.baseline_sha})`, 'Initialize diagnostic receipt', 'base'],
    [`record (head, ${s.head.sha})`, 'Initialize diagnostic receipt', 'head'],
    ['verify', 'Validate complete profiles and exact provenance', 'head'],
  ];
  for (const [job, step, side] of scopes) {
    const matches = text.split(/\r?\n/).flatMap(line => {
      const pieces = line.split('\t');
      if (pieces.length !== 3 || pieces[0] !== job || pieces[1] !== step) return [];
      const m = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s{3}RECORDER_IMAGES: (\{.*\})$/.exec(pieces[2]);
      return m ? [parse(m[1])] : [];
    });
    check(matches.length === 1 && equal(matches[0], sides[side]?.receipt?.images),
      'additional_policy_controller_image_mismatch');
  }
}
const GO_SCOPE = 'reviewed-go-mod-download-with-uninitialized-submodules';
const GO_RULES = [
  {
    policy_id: 'go-ethereum-pr10-go-mod-uninitialized-gitlinks-v1',
    repository: 'garnet-labs/go-ethereum', repository_id: '1211000635', pr: 10,
    base: '0b054f5690cfc792e7f6814c7b4e2b58e09ab340', head: '9ceffd5e287699760bfdd2463bb2c75167d32ad7',
    count: 2365, gitmodules: '241c169c4772ce246ffa45f7fa8a63019ffea0e1',
    gitlinks: [
      {path: 'tests/evm-benchmarks', commit_sha: 'd8b88f4046a87d6b902378cef752591f95427b43'},
      {path: 'tests/testdata', commit_sha: '81862e4848585a438d64f911a19b3825f0f4cd95'},
    ],
    sides: {
      base: {inventory: '44fb03a848e65bdcb9af8b0f8b464f9e40f981e4eabe6ff1e3b381a6c84067b6',
        mod: '37a2537dd04ca0afc5ed98f02993dd2ad1fbc773', sum: 'c46560324211f839478aaa4f98ef288773a1c8f6'},
      head: {inventory: '370f661e29b4ef28bfd4179680e9881a6613ea84dff38534ad0bfe09d20b7bbf',
        mod: '663c14fcc08a3117a692387ae25b064b36192f9f', sum: '24bbf3abeaa8acae2075f0cdc7e6b0f952a3b1d5'},
    },
  },
  {
    policy_id: 'grype-pr8-go-mod-uninitialized-gitlinks-v1',
    repository: 'garnet-labs/grype', repository_id: '1211000051', pr: 8,
    base: 'd3e1ec1f4e5dae225c41f4bd7495371010b3995d', head: '6ea85004173bbd667fc9fabd88529a99d04dc39c',
    count: 1170, gitmodules: '21e606b75a5911167d8ab45c2eacafcb9ff9fda2',
    gitlinks: [{path: 'test/quality/vulnerability-match-labels',
      commit_sha: '2dc3c828717741e26e3e780b24a3263cac450926'}],
    sides: {
      base: {inventory: '5234c649f67811a96937a6251706b7c3a32a8308e017450e861e02d0e19043b0',
        mod: '668d74ba9e7b966c724831dab7365409138c71bc', sum: '4ec2372764755b06b54b133a1cf241005b41ae18'},
      head: {inventory: 'e205a0cbb9e59a5c87f47ff99e536274e21c42ebbec9d460eb690b73bbc2cff2',
        mod: '6e15e7c5f12f33a518bb6c2e73796ea2d86474c2', sum: '2e8e1eabccc4534aa5d736d2892b84bedd4a45d9'},
    },
  },
];
export function expectedGoMaterialization(s, executed) {
  const p = GO_RULES.find(p => s?.repository === p.repository && s.repository_id === p.repository_id &&
    s.pr_number === p.pr && s.baseline_sha === p.base && s.head?.sha === p.head &&
    s.base?.repository === p.repository && s.head.repository === p.repository &&
    s.base.repository_id === p.repository_id && s.head.repository_id === p.repository_id &&
    [p.base, p.head].includes(executed) && s.comparison_scope === 'merge-base-to-head' &&
    exactManifestSet(s.manifests, ['go.mod', 'go.sum']) &&
    exactManifestSet(s.changed_files, ['go.mod', 'go.sum']));
  if (!p) return null;
  const side = p.sides[executed === p.base ? 'base' : 'head'];
  return {
    schema: 1, policy_id: p.policy_id, source_revision: executed, scope: GO_SCOPE,
    git_tree_lookup_sha: executed, tracked_inventory_sha256: side.inventory,
    tracked_superproject_blob_count: p.count, tracked_superproject_blob_bytes_checked: true,
    recursive_source_complete: false, submodule_contents_present: false,
    submodule_fetch_performed: false, git_metadata_excluded: true, host_git_metadata_exposed: false,
    uninitialized_gitlinks: structuredClone(p.gitlinks), go_work_absent: true, replace_directives_absent: true,
    go_mod_blob: side.mod, go_sum_blob: side.sum, gitmodules_blob: p.gitmodules,
    verification_phase: 'before-workload-not-a-post-execution-immutability-claim',
  };
}
const STOP_EXPERIMENT_ID = 'diagnostic-stop-420-v1';
const STOP_DEFAULTS = {sensor_stop_seconds: 180, stop_command_ms: 240000,
  settle_ms: 30000, step_minutes: 6, diagnostic_command_ms: 10000,
  experiment: false, job_minutes: 45};
// Independent static reconstruction of the five permits in frozen controller
// ff57d4dae02c6c780bd2fe7ea4f2895d17c93e20921e3df99b43bf1ad01cef80.
const STOP_PAIRS = [
  ['garnet-labs/n8n', '1206112160', 34, 'f461114870a31dbdf650abcff9a09ad5a86bdafd',
    '65fca3909cfa5a986ff618b5984e091fb068a0ec', ['packages/cli/package.json', 'pnpm-lock.yaml']],
  ['garnet-labs/supabase', '1206332384', 143, 'f28139579a7c017ff90a8414ae1f5929d018d3d2',
    '0d7c5b981b6ee494709fdf590b6b44e8e0ae5a5a', ['examples/todo-list/nextjs-todo-list/package-lock.json']],
  ['garnet-labs/OpenHands', '1337697001', 5, 'c41bda23d6b648bf3a30422ab9d71bd7675caea1',
    'f2689932d9b8a025d0eef961dd9a962c11c5697c', ['package-lock.json']],
  ['garnet-labs/phantom-connect-sdk', '1206647047', 23, '8eb39b151cedacddf55fc7715b3469b67743f78e',
    '112a60b79f4c7cb7e736bd34a4a78afe809590a1', ['yarn.lock']],
  ['garnet-labs/next.js', '1206332346', 40, '2d069943639fd0fc67a26bbb337d8a726f50924d',
    'bcae068be948a03cba54813aea6cffb5c03adf63', ['package.json', 'pnpm-lock.yaml']],
];
export function stopExperimentCapability(bytes) {
  const text = bytes.toString('utf8');
  const declarations = [...text.matchAll(/^\s*(?:export\s+)?const\s+STOP_EXPERIMENT\s*=\s*([^;\n]+)\s*;/gm)];
  if (!declarations.length) {
    check(!text.includes('STOP_EXPERIMENT'), 'unsupported_stop_experiment_capability');
    return 0;
  }
  check(declarations.length === 1 &&
    /^(['"])diagnostic-stop-420-v1\1$/.test(declarations[0][1].trim()),
  'unsupported_stop_experiment_capability');
  return 1;
}
export function expectedFinalizationLimits(s) {
  const requested = s?.finalization_experiment ?? 'none';
  if (requested === 'none') return {...STOP_DEFAULTS};
  check(requested === STOP_EXPERIMENT_ID, 'unknown_finalization_experiment');
  check(s.event === 'workflow_dispatch' && s.run_attempt === '1' &&
    STOP_PAIRS.some(([repo, id, pr, base, head, manifests]) =>
      s.repository === repo && s.repository_id === id && s.pr_number === pr &&
      s.baseline_sha === base && s.pr_base_tip === base && s.base?.sha === base &&
      s.head?.sha === head && s.base.repository === repo && s.head.repository === repo &&
      s.base.repository_id === id && s.head.repository_id === id &&
      exactManifestSet(s.manifests, manifests)), 'unreviewed_stop_experiment_pair');
  return {...STOP_DEFAULTS, sensor_stop_seconds: 420, stop_command_ms: 480000,
    step_minutes: 10, experiment: true, experiment_id: STOP_EXPERIMENT_ID, job_minutes: 60};
}
function stopDurationMs(value) {
  check(typeof value === 'string', 'invalid_systemd_stop_duration');
  const text = value.trim(), tokens = [...text.matchAll(/(\d+(?:\.\d+)?)(us|ms|min|s|h|d)/g)];
  check(tokens.length > 0 && tokens.map(t => t[0]).join('') === text.replace(/\s/g, ''),
    'invalid_systemd_stop_duration');
  const units = {us: .001, ms: 1, min: 60000, s: 1000, h: 3600000, d: 86400000};
  return tokens.reduce((sum, t) => sum + Number(t[1]) * units[t[2]], 0);
}
export function validateStopReceipt(r, s, version = 0) {
  check([0, 1].includes(version), 'unsupported_stop_experiment_capability');
  if (version === 0) {
    check((s?.finalization_experiment ?? 'none') === 'none' &&
      !r.sensor?.finalization_limits?.experiment && !r.sensor?.finalization_limits?.experiment_id,
    'unbound_stop_experiment');
    return;
  }
  const limits = expectedFinalizationLimits(s);
  if (!limits.experiment) {
    if (Object.hasOwn(r.sensor ?? {}, 'finalization_limits'))
      check(equal(r.sensor.finalization_limits, limits), 'unbound_stop_experiment_budget');
    return;
  }
  check(equal(r.sensor?.finalization_limits, limits), 'stop_experiment_budget_mismatch');
  check(stopDurationMs(r.sensor.stop_details?.TimeoutStopUSec) === 420000,
    'stop_experiment_effective_timeout_mismatch');
  check(r.sensor.stop_details.ActiveState === 'inactive' && r.sensor.stop_details.SubState === 'dead' &&
    r.sensor.stop_details.Result === 'success' && r.sensor.stop_details.ExecMainStatus === '0',
  'stop_experiment_unclean_lifecycle');
  check(Number.isFinite(r.sensor.stop_elapsed_ms) && r.sensor.stop_elapsed_ms >= 0 &&
    r.sensor.stop_elapsed_ms < limits.stop_command_ms &&
    Number.isFinite(r.sensor.finalization_elapsed_ms) && r.sensor.finalization_elapsed_ms >= 0 &&
    r.sensor.finalization_elapsed_ms < limits.step_minutes * 60000 &&
    !r.sensor.finalization_error && !r.finalization_error, 'stop_experiment_timing_or_error');
}
export function validateGoReceipt(r, s, version = 0) {
  check([0, 1, 2].includes(version), 'unsupported_reviewed_exceptions_capability');
  absentExceptionFields(r, ['go_submodule_validation']);
  const m = version === 2 ? expectedGoMaterialization(s, r.executed_sha) : null;
  exactExceptionField(r, 'source_materialization', m);
  check(Array.isArray(r.workloads), 'missing_go_policy_workloads');
  for (const w of r.workloads) {
    absentExceptionFields(w, ['go_submodule_validation']);
    exactExceptionField(w, 'source_materialization', m);
    if (!m) check(w.scope !== GO_SCOPE, 'unbound_go_materialization_scope');
  }
  if (!m) return null;
  check(r.reviewed_exceptions_version === 2 && ['base', 'head'].includes(r.side) &&
    r.executed_sha === (r.side === 'base' ? s.baseline_sha : s.head.sha), 'go_materialization_side_or_capability');
  check(r.workloads.length === 1, 'go_materialization_workload_count');
  const w = r.workloads[0];
  check(w.id === 'go:.:' && w.ecosystem === 'go' && w.directory === '.' && w.locked === true &&
    w.scope === GO_SCOPE && equal(w.changed_manifests, ['go.mod', 'go.sum']) &&
    equal(w.commands, ['GOWORK=off go mod download']), 'go_materialization_workload_scope');
  return {schema: 1, policy_id: m.policy_id, source_revision: m.source_revision,
    tracked_inventory_sha256: m.tracked_inventory_sha256, recursive_source_complete: false,
    submodule_contents_present: false, source_materialization_checked: true};
}
export function validateGoVerifier(v, row, r, s, version = 0) {
  const result = validateGoReceipt(r, s, version);
  absentExceptionFields(v, ['source_materialization', 'go_submodule_validation']);
  exactExceptionField(row, 'source_materialization', r.source_materialization);
  exactExceptionField(row, 'go_submodule_validation', result);
  if (result) check(v.reviewed_exceptions_version === 2 && row.side === r.side,
    'go_verifier_side_or_capability_mismatch');
}

function api(endpoint, method = 'GET', body) {
  try {
    return parse(execFileSync('gh', ['api', endpoint,
      '--method', method, ...(body ? ['--input', '-'] : [])], {
      input: body ? JSON.stringify(body) : undefined, encoding: 'utf8',
      maxBuffer: 128 * MB, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch (cause) {
    const error = new Error(`github_${method.toLowerCase()}_failed`);
    if (/\bHTTP 403\b/.test(String(cause.stderr ?? ''))) error.httpStatus = 403;
    console.error(JSON.stringify({github_request_failed: true, method, endpoint,
      ...(error.httpStatus ? {http_status: error.httpStatus} : {})}));
    throw error; // Never echo credentials/stderr.
  }
}
function pages(endpoint, key) {
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const result = api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const rows = key ? result[key] : result;
    check(Array.isArray(rows), 'invalid_github_pagination');
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw new Error('github_pagination_limit');
}
function read(file, limit = 128 * MB) {
  // Reject symlinks in every component, including downloaded artifact directories.
  const absolute = path.resolve(file);
  let cursor = path.parse(absolute).root;
  for (const component of absolute.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, component);
    check(!fs.lstatSync(cursor).isSymbolicLink(), 'unsafe_local_symlink');
  }
  const stat = fs.statSync(absolute);
  check(stat.isFile() && stat.size <= limit, 'unsafe_or_oversized_local_file');
  return fs.readFileSync(absolute);
}
function save(file, data) {
  if (fs.existsSync(file)) check(!fs.lstatSync(file).isSymbolicLink(), 'unsafe_output_symlink');
  fs.writeFileSync(file, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`, {mode: 0o600});
}
export function loadArtifact(dir, name, metadata, run) {
  const matches = metadata.filter(a => a.name === name);
  check(matches.length === 1, 'missing_or_duplicate_artifact');
  const a = matches[0];
  check(!a.expired && String(a.workflow_run?.id) === String(run.id), 'expired_or_foreign_artifact');
  check(a.workflow_run?.head_sha === run.head_sha, 'artifact_control_sha_mismatch');
  check(/^sha256:[a-f0-9]{64}$/.test(a.digest || ''), 'missing_live_artifact_digest');
  const zip = path.join(dir, `${name}.zip`);
  check(`sha256:${hash(read(zip, 256 * MB))}` === a.digest, 'archive_digest_mismatch');
  let members;
  try {
    members = execFileSync('unzip', ['-Z1', zip], {
      encoding: 'utf8', timeout: 30000, maxBuffer: MB, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split('\n');
  } catch { throw new Error('archive_listing_failed'); }
  const allowed = name.startsWith('garnet-verification-')
    ? ['verification.json', 'verifier.json'] : ['receipt.json', 'jibril.profile.json', 'workload.log'];
  check(members.length > 0 && new Set(members).size === members.length &&
    members.every(n => allowed.includes(n)), 'unexpected_archive_members');
  const files = {};
  for (const member of members) {
    let bytes;
    try {
      bytes = execFileSync('unzip', ['-p', zip, member], {
        timeout: 30000, maxBuffer: member === 'workload.log' ? 64 * MB : 128 * MB,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { throw new Error('archive_read_failed'); }
    check(bytes.equals(read(path.join(dir, name, member))), 'extracted_file_differs_from_archive');
    files[member] = bytes;
  }
  return {files, metadata: a, url: `https://github.com/${run.repository.full_name}/actions/runs/${run.id}/artifacts/${a.id}`};
}

// Independent reader of real Jibril peers, not a guessed global process list.
// Exact shim names confirmed by pnpm 33939752871 and OpenClaw 33940031479.
// Captured Docker membership/unique workload marker is still mandatory. A step named
// "99. Runner Processes" may contain real container workload traffic, so it is
// neither an acceptance nor a rejection criterion. Executable names alone fail.
export function inspectProfile(raw, r) {
  const envelope = parse(raw), p = envelope?.data ?? envelope;
  const g = p?.scenarios?.github;
  check(p?.metadata?.kind === 'profile' && p.metadata.format === 'profile' &&
    p.metadata.version === '0.2.0', 'unsupported_profile_schema');
  check(typeof p.uuid === 'string' && /^[a-f0-9-]{36}$/i.test(p.uuid) &&
    Number.isFinite(date(p.timestamp)), 'invalid_profile_identity_or_time');
  check(g?.repository === r.snapshot.repository && String(g.run_id) === r.run_id &&
    String(g.run_attempt) === r.run_attempt && ['record', r.profile_job].includes(g.job),
  'profile_run_identity_mismatch');
  check([r.snapshot.github_sha, r.snapshot.head.sha].includes(g.sha), 'native_profile_sha_mismatch');
  const peers = p.network?.egress?.peers;
  check(Array.isArray(peers) && peers.length > 0 && peers.length < 1000000, 'missing_egress_peers');
  const edges = [];
  for (const [peerIndex, peer] of peers.entries()) {
    check(typeof peer?.remote_address === 'string' && typeof peer.protocol === 'string' &&
      strings(peer.remote_ports) && (peer.remote_names === undefined || strings(peer.remote_names)) &&
      Array.isArray(peer.proc_trees), 'invalid_peer_shape');
    for (const t of peer.proc_trees) {
      check(Number.isSafeInteger(t?.pid) && t.pid > 0 && typeof t.process === 'string' &&
        typeof t.executable === 'string' && strings(t.ancestry), 'invalid_process_lineage');
      edges.push({peerIndex, pid: t.pid, process: t.process, executable: t.executable,
        ancestry: t.ancestry, protocol: peer.protocol, address: peer.remote_address,
        ports: peer.remote_ports, names: peer.remote_names ?? [], result: peer.result,
        detections: peer.detections ?? []});
    }
  }
  const expected = {
    node: /^(node|npm|pnpm|corepack|yarn|bun)$/, python: /^(python(?:\d+(?:\.\d+)*)?|pip(?:\d+(?:\.\d+)*)?|uv|poetry)$/,
    go: /^go$/, rust: /^(cargo|rustup)$/, ruby: /^(ruby(?:\d+(?:\.\d+)*)?|bundle|bundler|gem)$/,
  };
  const workloads = r.workloads.map(w => {
    const pids = new Set(w.pids);
    const owns = e => pids.has(e.pid) || [e.process, e.executable, ...e.ancestry].some(x =>
      x.split(/[^A-Za-z0-9-]+/).includes(w.marker));
    // Recompute the recorder's broader counter for consistency; never use it as
    // the publisher's sole positive gate (it can include non-workload peers).
    const recorderAssociations = edges.filter(e => owns(e) && e.protocol === 'TCP' &&
      e.ports.some(port => !/^53(?:\s|$)/.test(port))).length;
    const own = edges.filter(e => owns(e) &&
      e.ancestry.some(x => ['containerd-shim-runc-v2', 'containerd-shim'].includes(path.posix.basename(x))));
    const install = own.filter(e => expected[w.ecosystem]?.test(path.posix.basename(e.executable)) && nonDnsTcp(e));
    const unique = fn => [...new Map(own.map(e => [fn(e), e])).values()];
    const normalized = own.filter(nonDnsTcp).flatMap(e => {
      const names = e.names.map(n => n.trim().toLowerCase().replace(/\.$/, ''))
        .filter(n => n && !isIP(n));
      return (names.length ? names : [e.address]).flatMap(n => nonDnsPorts(e).map(port => `TCP ${n}:${port}`));
    });
    // Package-tool HTTPS peers first, then other non-DNS traffic; collapse
    // duplicate ancestry variants so the first two examples show actual domains.
    const examples = distinct([...install, ...own.filter(nonDnsTcp), ...own],
      e => JSON.stringify([e.executable, e.protocol,
        e.names.some(n => !isIP(n)) ? e.names.filter(n => !isIP(n)).sort() : e.address, [...e.ports].sort()]));
    return {
      id: w.id, recorderAssociations, associations: own.length,
      processes: unique(e => `${e.pid}:${e.executable}`).length,
      destinations: unique(e => JSON.stringify([e.protocol, e.address, [...e.ports].sort()])).length,
      installTcpAssociations: install.length,
      normalizedNonDnsTcpDestinations: [...new Set(normalized)].sort(),
      detectionLabels: [...new Set(own.flatMap(e => strings(e.detections) ? e.detections : []))].sort(),
      readbackEdges: own.filter(nonDnsTcp).map(e => ({pid: String(e.pid), process: e.process,
        address: e.address, domains: e.names})),
      examples: examples.slice(0, 4).map(e => ({pid: e.pid, executable: e.executable,
        ancestry: e.ancestry, protocol: e.protocol, address: e.address, ports: e.ports, names: e.names})),
    };
  });
  return {nativeSha: g.sha, sha256: hash(raw), bytes: Buffer.byteLength(raw), peers: peers.length,
    workloads, recorderEvidence: workloads.map(w => ({
      workload_id: w.id, network_process_associations: w.recorderAssociations,
    })), assertionResults: (Array.isArray(p.assertions) ? p.assertions : []).reduce((out, a) => {
      const result = ['pass', 'attention', 'fail'].includes(a.result) ? a.result : 'other';
      out[result] = (out[result] || 0) + 1; return out;
    }, {})};
}

export function validateSide(r, artifact, s, side, scriptHash, helperHashes, reviewedVersion = 0, pythonVersion = 0, stopVersion = 0,
  directoryVersion = 0, storageVersion = 0) {
  check(r?.schema === 1 && [POLICY, POLICY_V2].includes(r.policy) && equal(r.snapshot, s), 'receipt_schema_or_snapshot_mismatch');
  if (r.policy === POLICY_V2) check(helperHashes && Object.keys(helperHashes).length === 1 &&
    /^[a-f0-9]{64}$/.test(helperHashes[HELPER] || '') && equal(r.recorder_helpers_sha256, helperHashes),
  'recorder_helper_hash_mismatch');
  check(r.side === side && r.expected_sha === (side === 'base' ? s.baseline_sha : s.head.sha) &&
    r.executed_sha === r.expected_sha, 'executed_sha_mismatch');
  validateReviewedReceipt(r, s, reviewedVersion);
  validatePythonReceipt(r, s, pythonVersion);
  validateStopReceipt(r, s, stopVersion);
  validateDirectoryReceipt(r, s, directoryVersion);
  validateStorageReceipt(r, s, storageVersion);
  check(r.run_id === s.run_id && r.run_attempt === s.run_attempt && r.control_sha === s.control_sha &&
    r.recorder_sha === s.recorder_sha && r.recorder_script_sha256 === scriptHash,
  'receipt_run_or_recorder_hash_mismatch');
  check(r.artifact_name === artifactName(s.run_id, s.run_attempt, side) &&
    r.profile_job === `dependabot-${side}-attempt-${s.run_attempt}`, 'receipt_artifact_or_job_mismatch');
  check(r.action_sha === ACTION && r.sensor_version === 'v2.16.0' &&
    r.native_profile_sha_is_execution_proof === false, 'receipt_policy_mismatch');
  check(r.recording_complete === true && r.workload_success === true &&
    r.workload_exit === 0 && r.status === 'recorded', 'incomplete_recording_or_failed_workload');
  check(r.sensor?.ready === true && r.sensor.stopped_cleanly === true && r.sensor.settle_seconds >= 30 &&
    r.sensor.stop_details?.ActiveState === 'inactive' && r.sensor.stop_details?.SubState === 'dead' &&
    r.sensor.stop_details?.Result === 'success' && r.sensor.stop_details?.ExecMainStatus === '0',
  'unverified_sensor_lifecycle');
  check(r.isolation?.network?.docker_user_enforced === true &&
    r.isolation.network.host_input_blocked === true && r.isolation.host_credentials_mounted === false &&
    r.isolation.no_new_privileges === true, 'unverified_isolation_receipt');
  check(Array.isArray(r.workloads) && r.workloads.length > 0 && r.workloads.length <= 12 &&
    new Set(r.workloads.map(w => w.id)).size === r.workloads.length, 'invalid_workload_list');
  for (const [index, w] of r.workloads.entries()) {
    check(typeof w.id === 'string' && typeof w.directory === 'string' && typeof w.scope === 'string' &&
      strings(w.commands) && w.commands.length > 0 && w.commands.every(c => c.length > 0 && c.length < 8192),
    'invalid_actual_workload');
    check(IMAGE.test(w.image?.digest) && w.image.digest === r.images?.[w.ecosystem]?.digest, 'invalid_image_digest');
    check(w.exit_code === 0 && w.oom_killed === false && w.timed_out === false &&
      w.output_truncated === false, 'failed_or_truncated_workload');
    check(Array.isArray(w.pids) && w.pids.every(p => Number.isSafeInteger(p) && p > 0) &&
      w.marker === `garnet-workload-${s.run_id}-${side}-${index}` &&
      w.container === `gr-${s.run_id}-${side}-${index}`, 'missing_container_membership');
    check(date(w.started_at) >= date(r.sensor.ready_at) && date(w.finished_at) >= date(w.started_at) &&
      date(r.sensor.stopped_at) >= date(w.finished_at) && date(r.finalized_at) >= date(r.sensor.stopped_at),
    'invalid_sensor_workload_order');
  }
  const log = artifact.files['workload.log'];
  check(Buffer.isBuffer(log) && log.length <= 64 * MB && hash(log) === r.workload_log?.sha256 &&
    log.length === r.workload_log.bytes, 'workload_log_digest_mismatch');
  const raw = artifact.files['jibril.profile.json'];
  check(Buffer.isBuffer(raw) && r.profile?.state === 'valid' &&
    hash(raw) === r.profile.sha256 && raw.length === r.profile.bytes, 'raw_profile_digest_mismatch');
  const observed = inspectProfile(raw, r);
  check(equal(observed.recorderEvidence, r.profile.workload_evidence), 'recorded_process_counter_mismatch');
  check(observed.workloads.every(w => w.installTcpAssociations > 0), 'container_install_egress_unobserved');
  return observed;
}

export function validateSnapshot(s, {repo, pr, run, state}) {
  check(s?.schema === 1 && s.repository === repo && s.pr_number === pr.number &&
    s.author?.login === 'dependabot[bot]' && s.author.id === '49699333', 'snapshot_pr_identity_mismatch');
  check(s.workflow_path === WORKFLOW && s.comparison_scope === 'merge-base-to-head' &&
    s.pr_base_tip === s.base?.sha && SHA.test(s.baseline_sha) &&
    s.baseline_sha !== s.head?.sha, 'unexpected_workflow_or_baseline_scope');
  for (const side of ['base', 'head']) check(SHA.test(s[side]?.sha) && s[side].repository === repo &&
    s[side].repository_id === String(pr[side].repo.id), 'snapshot_repository_mismatch');
  check(s.repository_id === String(run.repository.id) && s.owner_id === String(run.repository.owner.id) &&
    s.run_id === String(run.id) && s.run_attempt === String(run.run_attempt) &&
    s.event === run.event && s.github_sha === run.head_sha, 'snapshot_run_mismatch');
  check(SHA.test(s.control_sha) && SHA.test(s.recorder_sha) && SHA.test(s.workflow_blob) &&
    s.control_ref?.startsWith(`${repo}/${WORKFLOW}@`), 'invalid_control_identity');
  check(s.head.sha === pr.head.sha, 'stale_pr_head');
  check(state?.repo === repo && SHA.test(state.control_sha) &&
    (s.recorder_sha === state.control_sha || state.accepted_control_shas?.includes(s.recorder_sha)),
    'recorder_not_bound_to_manager_install');
  // The manager's latest PR/run is scheduling state, not historical-run authority.
  // Exact current PR and immutable live run/artifact provenance are checked above.
  if (run.event === 'workflow_dispatch') check(s.control_sha === run.head_sha &&
    (s.recorder_sha === state.control_sha || state.accepted_control_shas?.includes(s.recorder_sha)),
  'dispatch_control_sha_mismatch');
}

function livePR(repo, number, historical = false) {
  const p = api(`repos/${repo}/pulls/${number}`);
  check(p.number === number && p.state === (historical ? 'closed' : 'open') && !p.merged &&
    p.user?.login === 'dependabot[bot]' && p.user.id === 49699333 && p.user.type === 'Bot',
  historical ? 'not_closed_unmerged_dependabot_pr' : 'not_open_dependabot_pr');
  check(p.head?.repo?.full_name === repo && p.base?.repo?.full_name === repo &&
    p.head.repo.id === p.base.repo.id && SHA.test(p.head.sha) && SHA.test(p.base.sha),
  'cross_repository_or_invalid_pr');
  return p;
}
function liveRun(repo, id) {
  const r = api(`repos/${repo}/actions/runs/${id}`);
  check(String(r.id) === id && r.repository?.full_name === repo && r.head_repository?.full_name === repo &&
    r.repository.id === r.head_repository.id && r.repository.owner?.login === 'garnet-labs',
  'foreign_workflow_run');
  // REST calls this field "path"; never accept a matching workflow display name.
  check(r.path === WORKFLOW && r.event === 'workflow_dispatch', 'wrong_live_workflow_path_or_event');
  check(Number.isSafeInteger(r.run_attempt) && r.run_attempt > 0 && SHA.test(r.head_sha), 'invalid_live_run');
  return r;
}

export function validateDefaultRun(run, repository, workflow) {
  check(repository.full_name === run.repository?.full_name && repository.id === run.repository?.id &&
    repository.owner?.login === 'garnet-labs' && repository.fork === true &&
    typeof repository.default_branch === 'string' && run.head_branch === repository.default_branch &&
    run.head_repository?.id === repository.id && run.head_repository?.full_name === repository.full_name,
  'run_not_from_trusted_default_branch');
  check(run.path === WORKFLOW && run.event === 'workflow_dispatch' &&
    workflow.id === run.workflow_id && workflow.path === WORKFLOW, 'wrong_worker_workflow_identity');
}

function ancestor(repo, older, newer) {
  check(SHA.test(older) && SHA.test(newer), 'invalid_ancestry_sha');
  if (older === newer) return;
  const c = api(`repos/${repo}/compare/${older}...${newer}`);
  check(c.merge_base_commit?.sha === older && ['ahead', 'identical'].includes(c.status),
    'controller_not_trusted_default_ancestor');
}

function defaultTrust(repo, run) {
  const repository = api(`repos/${repo}`);
  const workflow = api(`repos/${repo}/actions/workflows/${run.workflow_id}`);
  validateDefaultRun(run, repository, workflow);
  const branch = api(`repos/${repo}/branches/${encodeURIComponent(repository.default_branch)}`);
  check(SHA.test(branch.commit?.sha), 'missing_default_tip');
  ancestor(repo, run.head_sha, branch.commit.sha);
  return {repository, defaultTip: branch.commit.sha};
}

export function validateCIContext(env, event, repository, run, publishingRun, {allowInProgress = false} = {}) {
  const repo = repository.full_name, ref = `refs/heads/${repository.default_branch}`;
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REPOSITORY === repo && env.GITHUB_REPOSITORY_ID === String(repository.id) &&
    env.GITHUB_REF === ref && env.GITHUB_WORKFLOW_REF === `${repo}/${PUBLISH_WORKFLOW}@${ref}` &&
    SHA.test(env.GITHUB_SHA) && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA,
  'untrusted_ci_publisher_context');
  // Dispatch inputs are lookup/binding targets, never authority. Every referenced
  // run, attempt, source revision and artifact is independently checked live.
  check(event.repository?.id === repository.id && event.repository?.full_name === repo &&
    /^[1-9]\d{0,19}$/.test(event.inputs?.run_id || '') &&
    String(event.inputs.run_id) === String(run.id) &&
    /^[1-9]\d{0,5}$/.test(event.inputs?.run_attempt || '') &&
    String(event.inputs.run_attempt) === String(run.run_attempt) &&
    SHA.test(event.inputs?.worker_sha || '') && event.inputs.worker_sha === run.head_sha &&
    (run.status === 'completed' || (allowInProgress && ['queued', 'in_progress'].includes(run.status))),
  'ci_dispatch_run_binding_mismatch');
  check(String(publishingRun.id) === env.GITHUB_RUN_ID && publishingRun.path === PUBLISH_WORKFLOW &&
    publishingRun.event === 'workflow_dispatch' && publishingRun.head_sha === env.GITHUB_SHA &&
    publishingRun.head_branch === repository.default_branch && publishingRun.repository?.id === repository.id &&
    publishingRun.head_repository?.id === repository.id, 'ci_publisher_run_mismatch');
}

export function authorizeCI(repo, runId, options) {
  check(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    /^[1-9]\d{0,19}$/.test(process.env.GITHUB_RUN_ID || ''), 'ci_mode_requires_workflow_dispatch');
  const event = parse(read(process.env.GITHUB_EVENT_PATH, MB));
  const run = liveRun(repo, runId), trust = defaultTrust(repo, run);
  const publishingRun = api(`repos/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`);
  validateCIContext(process.env, event, trust.repository, run, publishingRun, options);
  const workflow = api(`repos/${repo}/actions/workflows/${publishingRun.workflow_id}`);
  check(workflow.id === publishingRun.workflow_id && workflow.path === PUBLISH_WORKFLOW,
    'ci_publisher_workflow_identity_mismatch');
  ancestor(repo, publishingRun.head_sha, trust.defaultTip);
  return {run, ...trust};
}

export function validateWorkflowPins(raw) {
  const uses = [...raw.toString('utf8').matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map(m => m[1]);
  const allowed = ['actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
    'actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b',
    `garnet-org/action@${ACTION}`,
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093'];
  check(uses.length >= 5 && uses.every(x => allowed.includes(x)) &&
    uses.filter(x => x === `garnet-org/action@${ACTION}`).length === 1,
  'unapproved_worker_action_pin');
}

export function parseHostedReports(log, runId, sides) {
  const reports = {};
  for (const side of ['base', 'head']) {
    const sha = sides[side]?.receipt?.executed_sha;
    if (!SHA.test(sha)) continue;
    const job = `record (${side}, ${sha})`;
    const urls = new Set();
    for (const line of log.split('\n')) {
      const [jobName, step, message] = line.replaceAll('\uFEFF', '').split('\t');
      if (jobName !== job || step !== 'Post Start trusted sensor using OIDC only') continue;
      const match = message?.match(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z Garnet Run Profile report: (https:\/\/app\.garnet\.ai\/\S+)\s*$/);
      if (!match) continue;
      try {
        const u = new URL(match[1]);
        if (u.origin !== 'https://app.garnet.ai' || u.pathname !== `/public/runs/${runId}` ||
          u.username || u.password || u.hash || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(u.searchParams.get('profile') || '') ||
          [...u.searchParams.keys()].some(k => !['profile', 'utm_source', 'utm_medium'].includes(k)) ||
          u.searchParams.getAll('profile').length !== 1) continue;
        // Keep only the locator, not arbitrary tracking query text.
        urls.add(`${u.origin}${u.pathname}?profile=${u.searchParams.get('profile')}`);
      } catch { /* malformed URL is not evidence */ }
    }
    if (urls.size === 1) reports[side] = [...urls][0];
  }
  return reports;
}

// Supplementary local receipt from MAIN's public-page check. This does not
// enter recording verification or security/approval logic.
export function validateCloudReadback(c, entry, hostedURL) {
  const r = entry?.receipt, observed = entry?.observed;
  check(r && observed && c?.verified === true && c.error == null &&
    ['retrieved', 'repository', 'run_id', 'native_control_sha', 'attributed_workload_edge']
      .every(k => c.checks?.[k] === true) && Object.values(c.checks).every(v => v === true),
  'cloud_readback_checks_unverified');
  check(c.side === r.side && c.name === r.snapshot.repository.split('/')[1] &&
    c.repository === r.snapshot.repository && String(c.run_id) === r.run_id &&
    c.control_sha === r.control_sha && c.control_sha === observed.nativeSha &&
    c.executed_sha === r.executed_sha, 'cloud_readback_receipt_mismatch');
  check(date(c.checked_at) >= date(r.finalized_at) && date(c.checked_at) <= Date.now() + 300000,
    'cloud_readback_time_invalid');
  const u = new URL(c.url);
  check(u.origin === 'https://app.garnet.ai' && !u.username && !u.password && !u.hash &&
    u.pathname === `/public/runs/${r.run_id}` &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(c.profile_id || '') &&
    u.searchParams.getAll('profile').length === 1 && u.searchParams.get('profile') === c.profile_id &&
    `${u.origin}${u.pathname}?profile=${c.profile_id}` === hostedURL, 'cloud_readback_locator_mismatch');
  const rawEdges = observed.workloads.flatMap(w => w.readbackEdges);
  check(Array.isArray(c.matched_edges) && c.matched_edges.length > 0 && c.matched_edges.every(e =>
    strings(e.domains) && rawEdges.some(raw => String(e.pid) === raw.pid && e.process === raw.process &&
      e.address === raw.address && e.domains.every(d => raw.domains.includes(d)))),
  'cloud_readback_workload_evidence_mismatch');
  return {state: 'matched', checked_at: c.checked_at, url: hostedURL, matched_edges: c.matched_edges.length};
}

export function renderPreview({repo, pr, run, snapshot: s, sides, failures, publishable, artifacts,
  hostedReports = {}, cloudReadbacks = {}, historical = false, reviewedVersion = 0, pythonVersion = 0,
  stopVersion = 0, comparisonMatched = true, directoryVersion = 0, storageVersion = 0}) {
  const recordingVerified = failures.length === 0 && publishable;
  // Preserve the legacy matched-comparison meaning for existing JSON consumers.
  // A valid capture with command divergence is a separate, lower-tier fact.
  const verified = recordingVerified && comparisonMatched;
  const runURL = `https://github.com/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
  const decision = recordingVerified ? 'Recording verified; security verdict HOLD (requires human interpretation)'
    : 'Recording incomplete; security verdict HOLD (requires human interpretation)';
  const lines = [marker(repo, pr.number),
    `<!-- garnet-recording-run:${run.id} attempt:${run.run_attempt} head:${pr.head.sha} -->`,
    historical ? '## Garnet Dependabot historical closed-PR recording' : '## Garnet Dependabot cold-read receipt',
    '', `**${decision}**`, '',
    ...(!comparisonMatched ? ['**Comparison HOLD:** base/head command policies differ. Both executions may be recorded, but no matched-install or scope-equivalent dependency comparison is claimed.', ''] : []),
    `[Recording run ${run.id}, attempt ${run.run_attempt}](${runURL}) · ${historical ? 'Historical closed-PR' : 'Current PR'} head: ${code(pr.head.sha)}`,
    ...(historical ? ['', '**Historical, closed and unmerged PR. Comment-only recording; not a current active-PR gate. No commit status or reopening.**'] : []),
    '', '| Side / actual workload | Executed SHA | Install / fetch command (in directory) | Image digest | Actual exit | Observed workload processes / destinations / associations |',
    '|---|---|---|---|---|---|'];
  for (const side of ['base', 'head']) {
    const entry = sides[side], r = entry?.receipt;
    if (!r?.workloads?.length) {
      lines.push(`| ${side} | ${code(r?.executed_sha)} | not verified | not verified | not recorded | not verified |`);
      continue;
    }
    for (const w of r.workloads) {
      const counts = entry.observed?.workloads.find(x => x.id === w.id);
      lines.push(`| ${side}: ${code(w.id)}<br>${escape(w.scope)} | ${code(r.executed_sha)} | ` +
        `${(Array.isArray(w.commands) ? w.commands : []).map(code).join('<br>')}<br>directory: ${code(w.directory)} | ` +
        `${code(w.image?.digest)} | ${code(w.exit_code)} | ${counts
          ? `${counts.processes} / ${counts.destinations} / ${counts.associations}` : 'not verified'} |`);
    }
  }
  if (reviewedVersion > 0) {
    const reviewed = expectedReviewedExceptions(s, sides.head?.receipt?.executed_sha);
    if ((reviewed.manager_selection || reviewed.source_copy_fidelity) && !recordingVerified)
      lines.push('', '**Reviewed exception not verified:** do not infer manager-selection or source-copy fidelity from this incomplete recording.');
    else if (reviewed.manager_selection) lines.push('',
      '**Reviewed install scope:** Yarn graph selected by the two immutable release workflows. The npm package-lock was retained and unchanged, but its graph was **not independently exercised**. Yarn 1.22.22 is a trusted classic-lock fallback, not an upstream version pin. Both lockfiles’ final bytes were checked; this is not a detector of transient modifications. No explicit workspace build or repository-wide tests were run.');
    else if (reviewed.source_copy_fidelity) lines.push('',
      '**Reviewed source-copy fidelity:** one exact absolute fixture symlink was preserved as opaque target bytes; no host-target resolution, tracked-source exclusions or symlink-target rewrites. Existing Git-metadata omission and executable-mode normalization were retained.');
  }
  if (reviewedVersion === 2) {
    const go = expectedGoMaterialization(s, s?.head?.sha);
    if (go && !recordingVerified) lines.push('',
      '**Reviewed Go materialization not verified:** the reviewed policy permits root GOWORK=off go mod download only, never a complete recursive checkout. No completed source materialization or successful download is asserted for this incomplete recording.');
    else if (go) {
      lines.push('', '**Reviewed Go download-only scope:** tracked superproject blobs were checked before the workload. The listed submodules were uninitialized; their contents were absent and were not fetched. **This is not a complete recursive checkout**, build, test or safety approval. Pre-workload checks are not post-execution source immutability. The compatibility field `locked=true` is not a Go `--locked` flag or a guarantee that go.sum cannot change.');
    }
    for (const g of go?.uninitialized_gitlinks ?? [])
      lines.push(`- ${recordingVerified ? 'Uninitialized gitlink' : 'Policy-required uninitialized gitlink (not verified)'}: ${code(g.path)} at ${code(g.commit_sha)}.`);
  }
  if (pythonVersion === 1 && Object.hasOwn(PYTHON_RULES, s?.repository ?? '')) {
    let policy;
    try { policy = expectedPythonPolicy(s, s?.head?.sha); }
    catch { /* Invalid snapshot stays an incomplete claim, never a renderer crash. */ }
    if (!recordingVerified || !policy) lines.push('',
      '**Reviewed Python policy not verified:** interpreter/image guards, selected dependency scope and intact lock bytes are not asserted for this incomplete recording; any stale-baseline failure remains a failure.');
    else lines.push('', '**Reviewed Python dependency scope:** ' + escape(policy.scope_limit) + '.',
      `Policy requirements: Python ${code(policy.python)}, uv ${code(policy.uv_version)}, interpreter ${code(policy.interpreter)}; no interpreter downloads or local workspace installation. Successful recording requires the listed runtime guard, uv version check, uv lock --check, frozen sync and final lock/pyproject byte comparison. These policy fields are requirements, not standalone runtime measurements.`,
      ...(policy.excluded_groups.length ? ['The pydantic-v1/pydantic-v2 group flags were not selected; this does **not** assert exclusion of all packages named Pydantic from the all-extras graph.'] : []));
    if (policy) lines.push(
      ...(!recordingVerified ? [`Policy scope (not a completion claim): ${escape(policy.scope_limit)}.`] : []),
      `Source-review caveat (retained): ${escape(policy.caveat)}.`);
  }
  if (directoryVersion === 1 && s?.repository === DIRECTORY_RULE.repository) {
    lines.push('', `**Synthetic empty-Git install scope${recordingVerified ? '' : ' — not verified'}:** ` +
      'the reviewed policy creates fresh Git metadata only inside the credential-free, nonroot workload container; ' +
      'the root filesystem remains read-only. No host .git, commits, origin, index entries or source Git objects are imported. ' +
      'Git templates and system/global configuration are disabled; npm lifecycle scripts and Husky are unchanged and enabled. ' +
      'This is **not full-Git or native-CI fidelity**: no native/Rust build, typecheck, Jest, application build or packaging is claimed.',
      'The guarded command sequence includes a container-local npm 10.9.8 bootstrap before the unchanged npm ci. ' +
      '**All observed process/destination counters cover the entire workload, including bootstrap; they are not npm-ci-only attribution.** ' +
      'The npm version is an official compatible release, not a native-CI exact pin. ' +
      'Final manifest/lock hash equality is a final-byte check, not proof against transient writes. ' +
      (!recordingVerified ? 'No successful guarded install or source-byte preservation is asserted for this incomplete recording. ' : '') +
      'The earlier failed Directory capture remains HOLD; no old exit is repaired.');
  }
  if (storageVersion === 1 && s?.repository === 'garnet-labs/gradio-test' && s.pr_number === 4 &&
    s.manifests?.includes('test/requirements.txt')) {
    lines.push('', `**Gradio private disk-home admission${recordingVerified ? '' : ' — not verified'}:** ` +
      'the exact reviewed requirements workload uses a fresh private disk-backed /home/workload and TMPDIR=/home/workload/tmp; ' +
      '/tmp remains a 2 GiB tmpfs. The root filesystem stays read-only, UID/GID 10001, no credentials mounted, and all existing ' +
      'isolation/network/resource caps remain. The original pip requirements command is unchanged and explicitly **not locked**.',
      'Initial admission requires at least 16 GiB available and 65,536 available inodes for home/work, plus at least 1 GiB available in /tmp. ' +
      'The same-image, network-none, isolated diagnostic preflight is **not dependency execution**. ' +
      'These are initial measurements, **not a storage reservation, quota, peak-usage guarantee or physical-media proof**; ' +
      'no 32 GiB reservation is claimed. Later ENOSPC remains HOLD. ' +
      (!recordingVerified ? 'Storage admission and successful dependency execution are not asserted for this incomplete recording. ' : '') +
      'The earlier failed Gradio capture remains HOLD.');
  }
  if (stopVersion === 1 && (s?.finalization_experiment ?? 'none') !== 'none')
    lines.push('', `**Diagnostic finalization experiment${recordingVerified ? '' : ' — not verified'}:** ` +
      'this policy permits only exact reviewed pairs with a 420-second systemd stop budget, 480-second stop subprocess, ' +
      '10-minute finalizer and 60-minute job. This is a bounded diagnostic experiment, **not a proven fix**. ' +
      'Clean stop, finite timings and all workload/profile gates remain required; old failed captures are not repaired. ' +
      'The one-new-dispatch limit is operator-enforced, not a global worker quota.');
  lines.push('', `Baseline: merge-base ${code(s?.baseline_sha)}; PR base tip at resolution: ${code(s?.pr_base_tip)}.`,
    'This is a freshly recorded merge-base-to-head pair, **not a previous profile from this PR**. Only the listed workload ran; repository-wide tests are not asserted.',
    '', '**Observed non-DNS TCP workload destination sets** (domain preferred; numeric port; PIDs and domain-backed IP changes ignored)');
  if (sides.base?.observed && sides.head?.observed) {
    const sets = ['base', 'head'].map(side => new Set(sides[side].observed.workloads.flatMap(w => w.normalizedNonDnsTcpDestinations)));
    const labels = a => a.length ? a.sort().map(code).join(', ') : 'none observed';
    lines.push(`- Base only: ${labels([...sets[0]].filter(x => !sets[1].has(x)))}`,
      `- Head only: ${labels([...sets[1]].filter(x => !sets[0].has(x)))}`,
      `- Shared: ${labels([...sets[0]].filter(x => sets[1].has(x)))}`,
      'These sets compare observed destination labels, not payloads or downloaded package versions. Unnamed destinations retain their IP; matching sets are not a security clearance.');
  } else lines.push('Not computed: both independently checked workload profiles are required.');
  lines.push(
    '', '**Evidence**');
  for (const side of ['base', 'head']) {
    const e = sides[side];
    const artifact = artifacts[side];
    if (artifact) lines.push(`- [${side}: raw jibril.profile.json, exact-SHA receipt.json and workload.log](${artifact.url})` +
      (e?.receipt?.profile?.sha256 ? ` — raw SHA-256 ${code(e.receipt.profile.sha256)}` : ''));
    const cloud = cloudReadbacks[side];
    if (cloud?.state === 'matched') lines.push(`  - [${side}: public profile read-back matched retained workload evidence](${cloud.url}) — checked ${code(cloud.checked_at)}.`);
    else if (hostedReports[side]) lines.push(`  - [${side}: action-returned hosted profile (read-back unverified)](${hostedReports[side]})`);
    for (const w of e?.observed?.workloads ?? []) {
      lines.push(`  - ${code(w.id)}: ${w.installTcpAssociations} observed package-tool non-DNS TCP associations.`);
      for (const x of w.examples.slice(0, 2)) lines.push(`    - PID ${x.pid}, ${code(x.executable)} → ` +
        `${code(`${x.protocol} ${x.names.join(', ') || x.address} [${x.address}] ${x.ports.join(', ')}`)}; ` +
        `ancestry ${code(x.ancestry.join(' → '))}.`);
      lines.push(`  - Attributed sensor labels (not a verdict): ${w.detectionLabels.map(code).join(', ') || 'none recorded'}.`);
    }
    if (e?.observed) lines.push(`  - Raw sensor assertion results (not a verdict): ${code(JSON.stringify(e.observed.assertionResults))}.`);
  }
  if (artifacts.verification) lines.push(`- [Independent verification.json / verifier.json](${artifacts.verification.url})`);
  lines.push('', `Trusted controller SHA: ${code(s?.control_sha)}; recorder SHA: ${code(s?.recorder_sha)}.`,
    `Native Garnet hosted profiles use workflow/control identity, **not the executed source SHA**; the separate hashed exact-SHA receipt above is execution authority. Raw native labels: base ${code(sides.base?.observed?.nativeSha)}, head ${code(sides.head?.observed?.nativeSha)}.`,
    `Public profile read-back: ${['base', 'head'].map(side => `${side} ${cloudReadbacks[side]?.state === 'matched' ? 'matched retained workload evidence' : 'unverified'}`).join('; ')}. Read-back confirms displayed evidence only, not complete cloud ingestion, source-SHA authority, or security clearance.`,
    '', 'Counts come only from peer-scoped process lineage matched to captured container PIDs or the unique workload marker **and** canary-observed container ancestry. Destinations are distinct protocol/address/port-set tuples; associations are process–peer rows. Runner/background-only traffic cannot satisfy the install gate. These are observed network-active processes, not a complete process inventory.',
    '', '**No security clearance, PR approval, or merge authorization.** ' +
      (historical ? 'This historical receipt does not create a commit status or reopen the PR. ' :
        'A successful commit status means the matched install/fetch workload was captured and verified, not that this dependency change is safe. ') +
      'No malicious delta is cleared; sensor detections and behavior require human interpretation.');
  if (failures.length) lines.push('', '**Incomplete / HOLD reasons:**', ...failures.map(f => `- ${code(f)}`));
  const body = `${lines.join('\n')}\n`;
  check(body.length < 60000, 'comment_exceeds_github_limit');
  return {schema: 1, repo, pr: pr.number, run: String(run.id), attempt: run.run_attempt,
    head: pr.head.sha, historical, publishable, verified, recording_verified: recordingVerified,
    comparison_matched: comparisonMatched,
    decision, failures, cloud_readback: cloudReadbacks, comment: {body},
    status: historical ? null : {context: CONTEXT, state: verified ? 'success' : 'error', target_url: runURL,
      description: recordingVerified && !comparisonMatched ? 'Executions captured; comparison HOLD; not approval or safety.'
        : verified ? 'Matched install captured; security HOLD; not approval or safety.'
        : 'Recording incomplete; security HOLD; not approval or safety.'}};
}

function publish(preview, originalRun, ciAuthorized = false) {
  check(preview.publishable, 'refusing_unbound_or_unhashed_evidence_publication');
  const {repo, pr, head, run, attempt} = preview;
  const again = () => {
    check(livePR(repo, pr, preview.historical).head.sha === head, 'pr_head_changed_before_write');
    const current = liveRun(repo, run);
    check(current.run_attempt === attempt && current.status === 'completed' &&
      current.conclusion === originalRun.conclusion && current.head_sha === originalRun.head_sha,
    'run_changed_before_write');
  };
  let viewer;
  try { viewer = api('user'); }
  catch (e) {
    check(ciAuthorized && process.env.GITHUB_ACTIONS === 'true' && e.httpStatus === 403,
      'publisher_identity_lookup_failed');
    viewer = api('users/github-actions%5Bbot%5D');
    check(viewer.id === 41898282 && viewer.login === 'github-actions[bot]' && viewer.type === 'Bot',
      'invalid_actions_bot_identity');
  }
  check(Number.isSafeInteger(viewer.id) && viewer.id > 0, 'missing_publisher_identity');
  const own = pages(`repos/${repo}/issues/${pr}/comments`).filter(c =>
    c.user?.id === viewer.id && typeof c.body === 'string' && c.body.startsWith(marker(repo, pr)));
  check(own.length <= 1, 'multiple_own_marked_comments_require_manual_resolution');
  const old = own[0], previous = old?.body.match(/<!-- garnet-recording-run:(\d+) attempt:(\d+) head:[a-f0-9]{40} -->/);
  if (previous) check(BigInt(previous[1]) < BigInt(run) || (previous[1] === run && Number(previous[2]) <= attempt),
    'refusing_to_replace_newer_recording');
  again();
  let comment = old;
  if (!old || old.body !== preview.comment.body) comment = old
    ? api(`repos/${repo}/issues/comments/${old.id}`, 'PATCH', preview.comment)
    : api(`repos/${repo}/issues/${pr}/comments`, 'POST', preview.comment);
  if (preview.historical) return {repo, pr, run, attempt, head, historical: true,
    comment_url: comment.html_url, comment_id: comment.id, status_id: null,
    status_state: 'not-posted-historical', security_verdict: 'HOLD'};
  // GitHub has no atomic PR-head-and-comment transaction; recheck before status.
  again();
  const latest = pages(`repos/${repo}/commits/${head}/statuses`).find(x => x.context === CONTEXT);
  // The trusted dispatcher may already have queued a newer exact-head replay.
  // Do not replace that pending gate with an older worker's completed capture.
  const newerRequest = latest?.state === 'pending' && latest.target_url?.match(
    new RegExp(`^https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/actions/runs/(\\d+)(?:/attempts/\\d+)?$`));
  if (newerRequest && BigInt(newerRequest[1]) > BigInt(run)) return {
    repo, pr, run, attempt, head, comment_url: comment.html_url, comment_id: comment.id,
    status_id: latest.id, status_state: 'pending', newer_request_pending: true, security_verdict: 'HOLD'};
  let status = latest;
  if (!latest || latest.creator?.id !== viewer.id ||
    !['state', 'description', 'target_url'].every(k => latest[k] === preview.status[k]))
    status = api(`repos/${repo}/statuses/${head}`, 'POST', preview.status);
  return {repo, pr, run, attempt, head, comment_url: comment.html_url, comment_id: comment.id,
    status_id: status.id, status_state: preview.status.state, security_verdict: 'HOLD'};
}

function options(argv) {
  const out = {publish: false, historical: false, ci: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--publish', '--historical', '--ci'].includes(arg)) {
      const key = arg.slice(2); check(!out[key], 'duplicate_mode_flag'); out[key] = true;
    }
    else {
      check(['--repo', '--pr', '--run', '--evidence'].includes(arg), 'unknown_argument');
      const key = arg.slice(2);
      check(out[key] === undefined && argv[i + 1] && !argv[i + 1].startsWith('--'), 'missing_or_duplicate_argument');
      out[key] = argv[++i];
    }
  }
  check(/^garnet-labs\/[A-Za-z0-9_.-]+$/.test(out.repo || '') && /^[1-9]\d{0,8}$/.test(out.pr || '') &&
    /^[1-9]\d{0,19}$/.test(out.run || '') && out.evidence, 'expected_repo_pr_run_evidence_arguments');
  out.pr = Number(out.pr);
  check(!(out.ci && out.historical), 'historical_is_manual_only');
  out.evidence = path.resolve(out.evidence);
  check(fs.realpathSync(out.evidence) === out.evidence && fs.statSync(out.evidence).isDirectory(), 'unsafe_evidence_directory');
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const o = options(argv), repoPath = `repos/${o.repo}`, failures = [], sides = {}, artifacts = {};
  const recordFailure = (stage, error) => failures.push(`${stage}: ${
    /^[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'missing_or_invalid_evidence'}`);
  const ciTrust = o.ci ? authorizeCI(o.repo, o.run) : null;
  const run = ciTrust?.run ?? liveRun(o.repo, o.run), pr = livePR(o.repo, o.pr, o.historical);
  const trust = ciTrust ?? defaultTrust(o.repo, run);
  const state = o.ci ? {repo: o.repo, control_sha: trust.defaultTip}
    : parse(read(path.join(ROOT, 'fleet-state', `${o.repo.split('/')[1]}.json`), MB));
  const metadata = pages(`${repoPath}/actions/runs/${o.run}/artifacts`, 'artifacts');
  const jobs = pages(`${repoPath}/actions/runs/${o.run}/attempts/${run.run_attempt}/jobs`, 'jobs');
  if (run.status !== 'completed' || run.conclusion !== 'success') failures.push('run_not_completed_successfully');
  for (const name of ['resolve', 'verify']) {
    const matches = jobs.filter(j => j.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success')
      failures.push(`${name}_job_not_completed_successfully`);
  }
  for (const side of ['base', 'head']) {
    // GitHub's unnamed matrix jobs render as "record (base, <sha>)".
    const matches = jobs.filter(j => new RegExp(`^record \\(${side}(?:,|\\))`).test(j.name));
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success')
      failures.push(`${side}_record_job_not_completed_successfully`);
    try {
      const artifact = loadArtifact(o.evidence, artifactName(o.run, run.run_attempt, side), metadata, run);
      artifacts[side] = artifact;
      check(artifact.files['receipt.json']?.length <= MB, 'receipt_missing_or_oversized');
      sides[side] = {receipt: parse(artifact.files['receipt.json'])};
    } catch (e) { recordFailure(side, e); }
  }
  let verification = [], snapshot = sides.head?.receipt?.snapshot ?? sides.base?.receipt?.snapshot;
  try {
    artifacts.verification = loadArtifact(o.evidence, `garnet-verification-${o.run}-${run.run_attempt}`, metadata, run);
    verification = Object.values(artifacts.verification.files).map(parse);
    snapshot ??= verification[0]?.snapshot;
    check(verification.length > 0, 'missing_verification_json');
  } catch (e) { recordFailure('verification_artifact', e); }
  let bound = false, scriptHash, scriptPolicy, helperHashes, reviewedVersion = 0, pythonVersion = 0,
    stopVersion = 0, directoryVersion = 0, storageVersion = 0, resultVersion = 0, comparisonMatched = true;
  try {
    check(state.repo === o.repo && SHA.test(state.control_sha), 'invalid_manager_install_anchor');
    check(snapshot && SHA.test(snapshot.recorder_sha) && SHA.test(snapshot.control_sha), 'invalid_snapshot_controller');
    ancestor(o.repo, snapshot.control_sha, snapshot.recorder_sha);
    ancestor(o.repo, snapshot.recorder_sha, trust.defaultTip);
    if (!o.ci && snapshot.recorder_sha !== state.control_sha) {
      // Recorded installation history is useful, but ancestry is mandatory even
      // for known entries; an unrelated branch cannot become trusted via a list.
      ancestor(o.repo, snapshot.recorder_sha, state.control_sha);
    }
    const validatedState = {...state, accepted_control_shas: [snapshot.recorder_sha]};
    validateSnapshot(snapshot, {repo: o.repo, pr, run, state: validatedState});
    check(snapshot.control_ref === `${o.repo}/${WORKFLOW}@refs/heads/${trust.repository.default_branch}` &&
      snapshot.github_ref === `refs/heads/${trust.repository.default_branch}`, 'snapshot_default_ref_mismatch');
    if (o.historical) check(snapshot.pr_state === 'closed' && snapshot.pr_merged === false,
      'historical_snapshot_not_closed_unmerged');
    const content = (file, sha) => api(`${repoPath}/contents/${file}?ref=${sha}`);
    const running = content(WORKFLOW, snapshot.control_sha);
    const trusted = content(WORKFLOW, snapshot.recorder_sha);
    const script = content(SCRIPT, snapshot.recorder_sha);
    check(running.sha === snapshot.workflow_blob && trusted.sha === snapshot.workflow_blob,
      'immutable_workflow_blob_mismatch');
    check(script.type === 'file' && script.encoding === 'base64' && typeof script.content === 'string', 'missing_recorder_bytes');
    check(running.type === 'file' && running.encoding === 'base64', 'missing_workflow_bytes');
    validateWorkflowPins(Buffer.from(running.content, 'base64'));
    const scriptBytes = Buffer.from(script.content, 'base64');
    scriptHash = hash(scriptBytes);
    scriptPolicy = /(?:export\s+)?const POLICY = ['"](garnet-dependabot-container-v[12])['"]/
      .exec(scriptBytes.toString('utf8'))?.[1];
    check([POLICY, POLICY_V2].includes(scriptPolicy), 'unsupported_trusted_recorder_policy');
    reviewedVersion = reviewedExceptionsCapability(scriptBytes);
    check(reviewedVersion === 0 || scriptPolicy === POLICY_V2, 'exception_capability_requires_policy_v2');
    let helperBytes;
    if (scriptPolicy === POLICY_V2) {
      const helper = content(HELPER, snapshot.recorder_sha);
      check(helper.type === 'file' && helper.encoding === 'base64' && typeof helper.content === 'string',
        'missing_recorder_helper_bytes');
      helperBytes = Buffer.from(helper.content, 'base64');
      helperHashes = {[HELPER]: hash(helperBytes)};
    }
    pythonVersion = reviewedPythonCapability(scriptBytes, helperBytes);
    check(pythonVersion === 0 || (scriptPolicy === POLICY_V2 && reviewedVersion > 0),
      'python_capability_requires_reviewed_policy_v2');
    directoryVersion = reviewedDirectoryCapability(scriptBytes, helperBytes);
    storageVersion = reviewedStorageCapability(scriptBytes);
    resultVersion = recordingResultCapability(scriptBytes);
    check((directoryVersion === 0 && storageVersion === 0) ||
      (scriptPolicy === POLICY_V2 && reviewedVersion === 2), 'additional_policy_requires_reviewed_v2');
    check(resultVersion === 0 || (scriptPolicy === POLICY_V2 && reviewedVersion === 2),
      'recording_result_requires_reviewed_v2');
    if (storageVersion && expectedStoragePolicy(snapshot, snapshot.head.sha))
      check(run.event === 'workflow_dispatch' && String(run.run_attempt) === '1',
        'storage_requires_live_manual_attempt_one');
    stopVersion = stopExperimentCapability(scriptBytes);
    if (stopVersion === 1) {
      check(scriptPolicy === POLICY_V2 && reviewedVersion === 2, 'stop_capability_requires_reviewed_v2');
      if (expectedFinalizationLimits(snapshot).experiment)
        check(run.event === 'workflow_dispatch' && Number(run.run_attempt) === 1,
          'stop_experiment_requires_live_manual_attempt_one');
    } else check((snapshot.finalization_experiment ?? 'none') === 'none', 'unbound_stop_experiment');
    const comparison = api(`${repoPath}/compare/${snapshot.pr_base_tip}...${snapshot.head.sha}`);
    check(comparison.merge_base_commit?.sha === snapshot.baseline_sha, 'merge_base_mismatch');
    const r = sides.head?.receipt;
    check(r?.executed_sha === pr.head.sha && r.side === 'head' && r.run_id === o.run &&
      r.run_attempt === String(run.run_attempt) && r.recorder_script_sha256 === scriptHash &&
      r.policy === scriptPolicy && (scriptPolicy !== POLICY_V2 || equal(r.recorder_helpers_sha256, helperHashes)) &&
      equal(r.snapshot, snapshot), 'head_execution_not_bound_to_current_pr');
    bound = run.status === 'completed';
  } catch (e) { recordFailure('provenance', e); }
  if (scriptHash) for (const side of ['base', 'head']) {
    try {
      check(sides[side] && artifacts[side], 'missing_side_evidence');
      check(sides[side].receipt.policy === scriptPolicy, 'receipt_trusted_policy_mismatch');
      sides[side].observed = validateSide(sides[side].receipt, artifacts[side], snapshot, side,
        scriptHash, helperHashes, reviewedVersion, pythonVersion, stopVersion, directoryVersion, storageVersion);
    } catch (e) { recordFailure(side, e); }
  }
  try {
    check(verification.length > 0, 'missing_independent_verifier');
    const base = sides.base.receipt.workloads, head = sides.head.receipt.workloads;
    check(equal(base.map(w => w.id), head.map(w => w.id)), 'workload_targets_differ');
    check(base.every((w, i) => w.image.digest === head[i].image.digest &&
      w.directory === head[i].directory && w.scope === head[i].scope), 'base_head_scope_or_image_mismatch');
    // Comparison is computed from the independently checked receipts, never
    // selected by a producer's verified/decision/comparison labels.
    comparisonMatched = base.every((w, i) => equal(w.commands, head[i].commands));
    for (const v of verification) {
      check(v.schema === 1 && v.policy === scriptPolicy && equal(v.snapshot, snapshot),
        'independent_verifier_not_verified');
      validateVerifierResult(v, comparisonMatched, resultVersion, scriptHash, helperHashes);
      if (scriptPolicy === POLICY_V2) check(v.recorder_script_sha256 === scriptHash &&
        equal(v.recorder_helpers_sha256, helperHashes), 'verifier_code_hash_mismatch');
      check(Array.isArray(v.sides) && v.sides.length === 2, 'verifier_side_count_mismatch');
      for (const side of ['base', 'head']) {
        const matches = v.sides.filter(x => x.side === side), e = sides[side];
        check(matches.length === 1 && e?.observed, 'verifier_missing_observed_side');
        const row = matches[0];
        validateReviewedVerifier(v, row, e.receipt, snapshot, reviewedVersion);
        validatePythonVerifier(v, row, e.receipt, snapshot, pythonVersion);
        validateDirectoryVerifier(v, row, e.receipt, snapshot, directoryVersion);
        validateStorageVerifier(v, row, e.receipt, snapshot, storageVersion);
        if (scriptPolicy === POLICY_V2) check(row.recorder_script_sha256 === scriptHash &&
          equal(row.recorder_helpers_sha256, helperHashes), 'verifier_side_code_hash_mismatch');
        check(row.executed_sha === e.receipt.executed_sha && row.profile_sha256 === e.observed.sha256 &&
          row.profile_job === e.receipt.profile_job && equal(row.workloads, e.receipt.workloads) &&
          equal(row.evidence, e.observed.recorderEvidence), 'verifier_contents_mismatch');
      }
    }
    if (pythonVersion === 1 && Object.hasOwn(PYTHON_RULES, snapshot?.repository ?? ''))
      validatePythonControllerImages(read(path.join(o.evidence, 'run.log')).toString('utf8'),
        snapshot, sides, pythonVersion);
    if ((directoryVersion && expectedDirectoryPolicy(snapshot, snapshot.head.sha)) ||
      (storageVersion && expectedStoragePolicy(snapshot, snapshot.head.sha)))
      validateAdditionalControllerImages(read(path.join(o.evidence, 'run.log')).toString('utf8'), snapshot, sides);
  } catch (e) { recordFailure('independent_verification', e); }
  let hostedReports = {};
  try { hostedReports = parseHostedReports(read(path.join(o.evidence, 'run.log')).toString('utf8'), o.run, sides); }
  catch { /* Hosted links are optional, never a recording or ingestion gate. */ }
  const cloudReadbacks = {};
  for (const side of ['base', 'head']) {
    cloudReadbacks[side] = {state: 'unverified'};
    try {
      cloudReadbacks[side] = validateCloudReadback(parse(read(path.join(o.evidence, `cloud-${side}.json`), MB)),
        sides[side], hostedReports[side]);
    } catch { /* Missing/stale/invalid public read-back is not a recording failure. */ }
  }
  const preview = renderPreview({repo: o.repo, pr, run, snapshot, sides, failures, publishable: bound,
    artifacts, hostedReports, cloudReadbacks, historical: o.historical, reviewedVersion, pythonVersion,
    stopVersion, comparisonMatched, directoryVersion, storageVersion});
  preview.provenance = {mode: o.ci ? 'trusted-workflow-dispatch' : 'local-manager',
    default_branch: trust.repository.default_branch, default_tip: trust.defaultTip,
    recorder_script_sha256: scriptHash, recorder_helpers_sha256: helperHashes,
    reviewed_exceptions_version: reviewedVersion || null, reviewed_python_policies_version: pythonVersion || null,
    stop_experiment_capability: stopVersion || null, reviewed_directory_policies_version: directoryVersion || null,
    reviewed_storage_policies_version: storageVersion || null, recording_result_contract_version: resultVersion || null};
  save(path.join(o.evidence, 'publisher-preview.md'), preview.comment.body);
  save(path.join(o.evidence, 'publisher-preview.json'), preview);
  if (o.publish) {
    const result = publish(preview, run, o.ci);
    save(path.join(o.evidence, 'publisher-result.json'), result);
    console.log(JSON.stringify(result));
  } else console.log(JSON.stringify({mode: 'dry-run', verified: preview.verified,
    publishable: preview.publishable, security_verdict: 'HOLD', failures,
    preview: path.join(o.evidence, 'publisher-preview.md')}));
  return preview;
}

export {api, pages, read};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) {
    console.error(`Publisher stopped: ${/^[a-z0-9_]+$/.test(e?.message ?? '') ? e.message : 'local_or_api_validation_failed'}. No approval or merge was attempted.`);
    process.exitCode = 1;
  }
}
