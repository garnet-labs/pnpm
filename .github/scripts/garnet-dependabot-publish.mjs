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
    node: /^(node|npm|pnpm|corepack|yarn)$/, python: /^(python(?:\d+(?:\.\d+)*)?|pip(?:\d+(?:\.\d+)*)?|uv|poetry)$/,
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

export function validateSide(r, artifact, s, side, scriptHash, helperHashes) {
  check(r?.schema === 1 && [POLICY, POLICY_V2].includes(r.policy) && equal(r.snapshot, s), 'receipt_schema_or_snapshot_mismatch');
  if (r.policy === POLICY_V2) check(helperHashes && Object.keys(helperHashes).length === 1 &&
    /^[a-f0-9]{64}$/.test(helperHashes[HELPER] || '') && equal(r.recorder_helpers_sha256, helperHashes),
  'recorder_helper_hash_mismatch');
  check(r.side === side && r.expected_sha === (side === 'base' ? s.baseline_sha : s.head.sha) &&
    r.executed_sha === r.expected_sha, 'executed_sha_mismatch');
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
  hostedReports = {}, cloudReadbacks = {}, historical = false}) {
  const verified = failures.length === 0 && publishable;
  const runURL = `https://github.com/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
  const decision = verified ? 'Recording verified; security verdict HOLD (requires human interpretation)'
    : 'Recording incomplete; security verdict HOLD (requires human interpretation)';
  const lines = [marker(repo, pr.number),
    `<!-- garnet-recording-run:${run.id} attempt:${run.run_attempt} head:${pr.head.sha} -->`,
    historical ? '## Garnet Dependabot historical closed-PR recording' : '## Garnet Dependabot cold-read receipt',
    '', `**${decision}**`, '',
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
    head: pr.head.sha, historical, publishable, verified, decision, failures, cloud_readback: cloudReadbacks, comment: {body},
    status: historical ? null : {context: CONTEXT, state: verified ? 'success' : 'error', target_url: runURL,
      description: verified ? 'Matched install captured; security HOLD; not approval or safety.'
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
  let bound = false, scriptHash, scriptPolicy, helperHashes;
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
    if (scriptPolicy === POLICY_V2) {
      const helper = content(HELPER, snapshot.recorder_sha);
      check(helper.type === 'file' && helper.encoding === 'base64' && typeof helper.content === 'string',
        'missing_recorder_helper_bytes');
      helperHashes = {[HELPER]: hash(Buffer.from(helper.content, 'base64'))};
    }
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
      sides[side].observed = validateSide(sides[side].receipt, artifacts[side], snapshot, side, scriptHash, helperHashes);
    } catch (e) { recordFailure(side, e); }
  }
  try {
    check(verification.length > 0, 'missing_independent_verifier');
    for (const v of verification) {
      check(v.schema === 1 && v.policy === scriptPolicy && v.verified === true &&
        v.decision === 'RECORDING_VERIFIED' && equal(v.snapshot, snapshot), 'independent_verifier_not_verified');
      if (scriptPolicy === POLICY_V2) check(v.recorder_script_sha256 === scriptHash &&
        equal(v.recorder_helpers_sha256, helperHashes), 'verifier_code_hash_mismatch');
      check(Array.isArray(v.sides) && v.sides.length === 2, 'verifier_side_count_mismatch');
      for (const side of ['base', 'head']) {
        const matches = v.sides.filter(x => x.side === side), e = sides[side];
        check(matches.length === 1 && e?.observed, 'verifier_missing_observed_side');
        const row = matches[0];
        if (scriptPolicy === POLICY_V2) check(row.recorder_script_sha256 === scriptHash &&
          equal(row.recorder_helpers_sha256, helperHashes), 'verifier_side_code_hash_mismatch');
        check(row.executed_sha === e.receipt.executed_sha && row.profile_sha256 === e.observed.sha256 &&
          row.profile_job === e.receipt.profile_job && equal(row.workloads, e.receipt.workloads) &&
          equal(row.evidence, e.observed.recorderEvidence), 'verifier_contents_mismatch');
      }
    }
    const base = sides.base.receipt.workloads, head = sides.head.receipt.workloads;
    check(equal(base.map(w => w.id), head.map(w => w.id)), 'workload_targets_differ');
    check(base.every((w, i) => w.image.digest === head[i].image.digest &&
      w.directory === head[i].directory && w.scope === head[i].scope), 'base_head_scope_or_image_mismatch');
    // A changed packageManager/policy is interesting, not silently a matched install.
    check(base.every((w, i) => equal(w.commands, head[i].commands)), 'base_head_commands_differ_requires_review');
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
    artifacts, hostedReports, cloudReadbacks, historical: o.historical});
  preview.provenance = {mode: o.ci ? 'trusted-workflow-dispatch' : 'local-manager',
    default_branch: trust.repository.default_branch, default_tip: trust.defaultTip,
    recorder_script_sha256: scriptHash, recorder_helpers_sha256: helperHashes};
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
