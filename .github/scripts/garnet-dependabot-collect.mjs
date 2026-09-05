#!/usr/bin/env node
// Explicitly dispatched trusted default-branch collector. Artifacts are data only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {api, pages, read, authorizeCI, main as publishMain} from './garnet-dependabot-publish.mjs';

const MB = 1024 * 1024;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const digest = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const numeric = value => /^[1-9]\d{0,19}$/.test(String(value ?? ''));

export function unpackDataArchive(zip, directory, name) {
  assert(/^garnet-(?:record-\d+-\d+-(?:base|head)|verification-\d+-\d+)$/.test(name), 'unsafe_artifact_name');
  const allowed = name.startsWith('garnet-verification-')
    ? ['verification.json', 'verifier.json'] : ['receipt.json', 'jibril.profile.json', 'workload.log'];
  const names = execFileSync('unzip', ['-Z1', zip], {encoding: 'utf8', timeout: 30000,
    maxBuffer: MB, stdio: ['ignore', 'pipe', 'pipe']}).trim().split('\n');
  assert(names.length > 0 && names.length <= allowed.length && new Set(names).size === names.length &&
    names.every(n => allowed.includes(n)), 'unexpected_archive_members');
  // Never unzip to a path. Stream explicitly allowed members into freshly
  // created ordinary files: ZIP symlinks, traversal and executable modes cannot act.
  fs.mkdirSync(directory, {mode: 0o700});
  for (const name of names) {
    const limit = name === 'workload.log' ? 64 * MB : name === 'jibril.profile.json' ? 128 * MB : MB;
    const bytes = execFileSync('unzip', ['-p', zip, name], {timeout: 30000,
      maxBuffer: limit, stdio: ['ignore', 'pipe', 'pipe']});
    assert(bytes.length <= limit, 'oversized_archive_member');
    fs.writeFileSync(path.join(directory, name), bytes, {flag: 'wx', mode: 0o600});
  }
}

export function validateCollectMetadata(a, name, run) {
  assert(a.name === name && numeric(a.id) && !a.expired &&
    String(a.workflow_run?.id) === String(run.id) && a.workflow_run?.head_sha === run.head_sha &&
    Number.isSafeInteger(a.size_in_bytes) && a.size_in_bytes > 0 && a.size_in_bytes <= 256 * MB &&
    /^sha256:[a-f0-9]{64}$/.test(a.digest || ''), 'untrusted_artifact_metadata');
}

export function waitForCompletedRun(repo, runId, {
  authorize = authorizeCI,
  sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  attempts = 25, interval = 5000,
} = {}) {
  // The verifier dispatches after upload, just before its worker run closes.
  // Authorization is repeated during this bounded wait; changed attempts/SHAs
  // fail immediately. No artifact is downloaded before completed is observed.
  for (let i = 0; i < attempts; i++) {
    const trust = authorize(repo, runId, {allowInProgress: true});
    if (trust.run.status === 'completed') return trust;
    if (i + 1 < attempts) sleep(interval);
  }
  throw new Error('worker_completion_wait_expired');
}

// Some attempt ZIPs contain aggregate job logs only. Accept just the runner's
// command/environment preamble in the fixed trusted pre-workload sequence, never
// command output or a later lookalike. These commands precede workload execution.
// A missing/reordered preamble cannot be repaired by a header in workload stdout.
export function trustedAggregateStep(jobs, run, name) {
  const matches = jobs.filter(job => job.name === name), job = matches[0];
  assert(matches.length === 1 && Number.isSafeInteger(job.id) && job.id > 0 &&
    job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === run.head_sha &&
    job.status === 'completed', 'untrusted_aggregate_job_metadata');
  const record = /^record \((?:base|head), [a-f0-9]{40}\)$/.test(name);
  assert(record || name === 'verify', 'invalid_aggregate_job');
  const stepName = record ? 'Initialize diagnostic receipt' : 'Validate complete profiles and exact provenance';
  const steps = job.steps?.filter(step => step.name === stepName), step = steps?.[0];
  assert(steps?.length === 1 && step.number === (record ? 3 : 4) &&
    step.status === 'completed' && step.conclusion === 'success', 'untrusted_aggregate_step_metadata');
  const parseTime = value => typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) ? Date.parse(value) : NaN;
  const start = parseTime(step.started_at), end = parseTime(step.completed_at);
  assert(Number.isFinite(start) && Number.isFinite(end) && start <= end &&
    start >= parseTime(job.started_at) && end <= parseTime(job.completed_at), 'invalid_aggregate_step_times');
  // The jobs API is second-resolution; raw runner timestamps have fractions.
  // Include the entire API completion second, but not the next second.
  return {start: Math.floor(start / 1000) * 1000, end: Math.floor(end / 1000) * 1000 + 1000};
}

export function aggregateControllerHeaders(job, text, bounds) {
  const record = /^record \((?:base|head), [a-f0-9]{40}\)$/.test(job);
  assert(record || job === 'verify', 'invalid_aggregate_job');
  assert(Number.isFinite(bounds?.start) && Number.isFinite(bounds?.end) && bounds.start < bounds.end,
    'missing_aggregate_step_time_binding');
  const checkout = 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683';
  const expected = record ? [checkout, 'node control/.github/scripts/garnet-dependabot-record.mjs init']
    : [checkout, 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
      'node control/.github/scripts/garnet-dependabot-record.mjs verify'];
  const step = record ? 'Initialize diagnostic receipt' : 'Validate complete profiles and exact provenance';
  const rows = text.replaceAll('\uFEFF', '').split(/\r?\n/);
  const payload = line => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z (.*)$/.exec(line)?.[1];
  assert(rows.filter(line => payload(line) === `##[group]Run ${expected.at(-1)}`).length === 1,
    'ambiguous_aggregate_command_preamble');
  let index = 0, selected = false;
  const lines = [];
  for (const line of rows) {
    const message = payload(line);
    if (message === undefined) continue;
    const start = /^##\[group\]Run (.*)$/.exec(message);
    if (start) {
      assert(!selected && start[1] === expected[index++], 'unexpected_aggregate_command_sequence');
      selected = index === expected.length;
    }
    if (!selected) continue;
    const time = Date.parse(line.slice(0, line.indexOf(' ')));
    assert(time >= bounds.start && time < bounds.end, 'aggregate_preamble_outside_trusted_step');
    if (message === '##[endgroup]') {
      return lines; // Stop before any output from the selected command.
    } else if (!start) {
      assert(!message.startsWith('##[group]'), 'nested_aggregate_command_preamble');
      if (message.startsWith('  RECORDER_IMAGES: ')) lines.push(`${job}\t${step}\t${line}`);
    }
  }
  throw new Error('missing_aggregate_command_preamble');
}

export function collectorMain() {
  assert(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch',
    'collector_requires_trusted_workflow_dispatch');
  const repo = process.env.GITHUB_REPOSITORY;
  assert(/^garnet-labs\/[A-Za-z0-9_.-]+$/.test(repo || ''), 'invalid_repository');
  const event = JSON.parse(read(process.env.GITHUB_EVENT_PATH, MB));
  assert(numeric(event.inputs?.run_id), 'invalid_triggering_run');
  const runId = String(event.inputs.run_id);
  // Live path, ID, branch, same-repository identity, attempt and ancestry checks
  // precede every artifact download, not merely publication.
  const {run} = waitForCompletedRun(repo, runId);
  const metadata = pages(`repos/${repo}/actions/runs/${runId}/artifacts`, 'artifacts');
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'garnet-read-only-data-'));
  fs.chmodSync(root, 0o700);
  const names = ['base', 'head'].map(side => `garnet-record-${runId}-${run.run_attempt}-${side}`);
  names.push(`garnet-verification-${runId}-${run.run_attempt}`);
  for (const name of names) {
    const matches = metadata.filter(a => a.name === name);
    assert(matches.length <= 1, 'duplicate_attempt_artifact');
    if (!matches.length) continue; // Publisher decides if retained evidence is bound/incomplete.
    const a = matches[0];
    validateCollectMetadata(a, name, run);
    const bytes = execFileSync('gh', ['api',
      `repos/${repo}/actions/artifacts/${a.id}/zip`, '--method', 'GET'],
    {timeout: 120000, maxBuffer: 256 * MB, stdio: ['ignore', 'pipe', 'pipe']});
    assert(digest(bytes) === a.digest, 'downloaded_archive_digest_mismatch');
    const zip = path.join(root, `${name}.zip`);
    fs.writeFileSync(zip, bytes, {flag: 'wx', mode: 0o600});
    unpackDataArchive(zip, path.join(root, name), name);
  }
  const headFile = path.join(root, names[1], 'receipt.json');
  const receipt = JSON.parse(read(headFile, MB));
  const pr = receipt.snapshot?.pr_number;
  assert(Number.isSafeInteger(pr) && pr > 0 && pr <= 999999999, 'invalid_receipt_pr_number');
  // This number is only a lookup target. The publisher independently checks the
  // complete hashed snapshot, exact live head, author, immutable source and verifier.
  try {
    const bytes = execFileSync('gh', ['api',
      `repos/${repo}/actions/runs/${runId}/attempts/${run.run_attempt}/logs`, '--method', 'GET'],
    {timeout: 120000, maxBuffer: 128 * MB, stdio: ['ignore', 'pipe', 'pipe']});
    const logZip = path.join(root, 'actions-logs.zip');
    fs.writeFileSync(logZip, bytes, {flag: 'wx', mode: 0o600});
    const members = execFileSync('unzip', ['-Z1', logZip], {encoding: 'utf8', timeout: 30000,
      maxBuffer: MB, stdio: ['ignore', 'pipe', 'pipe']}).trim().split('\n');
    assert(members.length <= 10000 && members.every(n => !n.startsWith('/') &&
      !n.includes('\\') && !n.split('/').includes('..') && !/[\x00-\x1f]/.test(n)), 'unsafe_log_members');
    const lines = [];
    const stepMember = member =>
      /^(record \((?:base|head), [a-f0-9]{40}\))\/\d+_(Post Start trusted sensor using OIDC only|Initialize diagnostic receipt)\.txt$/.exec(member) ||
      /^(verify)\/\d+_(Validate complete profiles and exact provenance)\.txt$/.exec(member);
    // Never mix representations or repair missing per-step authority using an
    // aggregate file. Aggregate post-workload locators are deliberately omitted.
    const perStep = members.some(member => stepMember(member));
    const aggregateJobs = perStep ? [] :
      pages(`repos/${repo}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs`, 'jobs');
    for (const member of members) {
      const m = perStep ? stepMember(member) :
        /^\d+_(record \((?:base|head), [a-f0-9]{40}\)|verify)\.txt$/.exec(member);
      if (!m) continue;
      const text = execFileSync('unzip', ['-p', logZip, member], {encoding: 'utf8', timeout: 30000,
        maxBuffer: 8 * MB, stdio: ['ignore', 'pipe', 'pipe']});
      if (perStep) {
        for (const line of text.replaceAll('\uFEFF', '').split('\n')) if (line) lines.push(`${m[1]}\t${m[2]}\t${line}`);
      } else lines.push(...aggregateControllerHeaders(m[1], text, trustedAggregateStep(aggregateJobs, run, m[1])));
    }
    const log = lines.join('\n') + '\n';
    assert(Buffer.byteLength(log) <= 16 * MB, 'oversized_hosted_locator_logs');
    fs.writeFileSync(path.join(root, 'run.log'), log, {flag: 'wx', mode: 0o600});
  } catch { /* Hosted locators stay optional; required controller-image headers fail closed in the publisher. */ }
  const output = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'garnet-dependabot-publication');
  fs.mkdirSync(output, {recursive: true, mode: 0o700});
  try {
    const preview = publishMain(['--ci', '--repo', repo, '--pr', String(pr), '--run', runId,
      '--evidence', root, '--publish']);
    fs.writeFileSync(path.join(output, 'collector-result.json'), JSON.stringify({
      repository: repo, pr, run_id: runId, run_attempt: run.run_attempt,
      recording_verified: preview.recording_verified === undefined ? preview.verified : preview.recording_verified,
      comparison_matched: preview.comparison_matched, security_verdict: 'HOLD',
    }, null, 2) + '\n', {mode: 0o600});
  } finally {
    for (const name of ['publisher-preview.md', 'publisher-preview.json', 'publisher-result.json']) {
      if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(output, name));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { collectorMain(); }
  catch (e) {
    console.error(`Collector stopped: ${/^[a-z0-9_]+$/.test(e?.message ?? '') ? e.message : 'data_or_api_validation_failed'}. No approval or merge was attempted.`);
    process.exitCode = 1;
  }
}
