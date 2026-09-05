const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

// The sensor's own shutdown evidence. This post step runs after the Garnet
// post step, so the unit has already been stopped and its journal, exit
// status and log directory describe the completed flush.
const probes = [
  ['journal', 'sudo -n journalctl -u jibril.service --no-pager -o short-precise | tail -200'],
  ['unit', 'sudo -n systemctl show jibril.service -p Result -p ExecMainStatus -p ExecMainCode -p ActiveState -p SubState'],
  ['log dir', 'ls -la /var/log/jibril* 2>&1 || true'],
]
for (const [label, cmd] of probes) {
  console.log(`----- BEGIN jibril ${label} -----`)
  try {
    console.log(execSync(cmd, { shell: '/bin/bash', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trimEnd())
  } catch (err) {
    console.log(`probe failed: ${err.message}`)
    if (err.stdout) console.log(err.stdout.toString().trimEnd())
    if (err.stderr) console.log(err.stderr.toString().trimEnd())
  }
  console.log(`----- END jibril ${label} -----`)
}

// Each step gets its own GITHUB_STEP_SUMMARY file, so read every summary
// file in the runner's file-commands directory to capture summaries
// written by other steps' post actions.
const own = process.env.GITHUB_STEP_SUMMARY
if (!own) {
  console.log('GITHUB_STEP_SUMMARY not set')
} else {
  const dir = path.dirname(own)
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('step_summary_') && !f.includes('-scrubbed'))
  console.log(`summary files in ${dir}: ${files.length}`)
  for (const f of files) {
    const p = path.join(dir, f)
    const bytes = fs.readFileSync(p)
    console.log(`--- ${f}: ${bytes.length} bytes`)
    if (bytes.length === 0) continue
    // Prefix every line so nothing in the dump can start with "::" — the
    // Actions runner would otherwise interpret such lines as workflow
    // commands. The prefixed lines also stay subject to secret masking.
    console.log(`----- BEGIN ${f} -----`)
    for (const line of bytes.toString('utf8').split('\n')) {
      console.log(`| ${line}`)
    }
    console.log(`----- END ${f} -----`)
  }
}
