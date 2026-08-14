const fs = require('fs')

const file = process.env.GITHUB_STEP_SUMMARY
if (!file || !fs.existsSync(file)) {
  console.log('GITHUB_STEP_SUMMARY file not found')
} else {
  const bytes = fs.readFileSync(file)
  console.log(`GITHUB_STEP_SUMMARY: ${bytes.length} bytes`)
  console.log('----- BEGIN STEP SUMMARY (base64) -----')
  console.log(bytes.toString('base64'))
  console.log('----- END STEP SUMMARY (base64) -----')
  console.log('----- BEGIN STEP SUMMARY (raw) -----')
  console.log(bytes.toString('utf8'))
  console.log('----- END STEP SUMMARY (raw) -----')
}
