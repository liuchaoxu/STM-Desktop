/* eslint-disable */
/**
 * One-off check: every string literal in the freshly built renderer bundle must match
 * the pre-corruption bundle. Any difference is text the repair did not restore.
 * Run with: node scripts/repair-compare.cjs
 */
const fs = require('fs')
const path = require('path')

const preCorruption = path.join(__dirname, '..', 'out', 'pre-corruption.js')
if (!fs.existsSync(preCorruption)) {
  console.error(
    'reference bundle missing: keep a copy at out/pre-corruption.js before rebuilding\n' +
      '(each build replaces the previous bundle, and this check compares against it)'
  )
  process.exit(1)
}
const assets = path.join(__dirname, '..', 'out', 'renderer', 'assets')
const fresh = fs
  .readdirSync(assets)
  .filter((name) => name.endsWith('.js'))
  .map((name) => path.join(assets, name))
  .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]

function literals(file) {
  const text = fs.readFileSync(file, 'utf8')
  const found = new Set()
  const re = /"((?:[^"\\\n]|\\.){1,80})"|'((?:[^'\\\n]|\\.){1,80})'/g
  let m
  while ((m = re.exec(text)) !== null) {
    const value = m[1] ?? m[2]
    // Skip things that are pure code noise: identifiers, paths, hashes.
    if (!/[\u3000-\u9fff\uff00-\uffef\u2190-\u2bff\u{1f300}-\u{1faff}]/u.test(value)) continue
    found.add(value)
  }
  return found
}

const before = literals(preCorruption)
const after = literals(fresh)
const missing = [...before].filter((value) => !after.has(value)).sort()
const added = [...after].filter((value) => !before.has(value)).sort()

console.log('reference: ' + path.basename(preCorruption) + ' (' + before.size + ' literals)')
console.log('fresh:     ' + path.basename(fresh) + ' (' + after.size + ' literals)')
console.log('missing (lost text): ' + JSON.stringify(missing, null, 1))
console.log('added (new text):    ' + JSON.stringify(added, null, 1))
