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
    console.log(`----- BEGIN ${f} (base64) -----`)
    console.log(bytes.toString('base64'))
    console.log(`----- END ${f} (base64) -----`)
    console.log(`----- BEGIN ${f} (raw) -----`)
    console.log(bytes.toString('utf8'))
    console.log(`----- END ${f} (raw) -----`)
  }
}
