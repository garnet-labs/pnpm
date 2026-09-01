const fs = require('fs')
const path = require('path')

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
