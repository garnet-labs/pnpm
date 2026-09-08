const fs = require("node:fs")
const p = process.env.GITHUB_STEP_SUMMARY
console.log("::group::GITHUB_STEP_SUMMARY")
console.log(p && fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "<absent>")
console.log("::endgroup::")
