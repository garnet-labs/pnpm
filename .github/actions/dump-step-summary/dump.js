const fs = require("node:fs")
const path = require("node:path")
const p = process.env.GITHUB_STEP_SUMMARY
console.log("::group::GITHUB_STEP_SUMMARY")
if (p && fs.existsSync(path.dirname(p))) {
    const files = fs
        .readdirSync(path.dirname(p))
        .filter(f => f.startsWith("step_summary"))
        .sort()
    let any = false
    for (const f of files) {
        const body = fs.readFileSync(path.join(path.dirname(p), f), "utf8")
        if (body.trim().length > 0) {
            any = true
            console.log(`--- ${f} ---`)
            console.log(body)
        }
    }
    if (!any) console.log("<all step_summary files empty>")
} else {
    console.log("<absent>")
}
console.log("::endgroup::")
