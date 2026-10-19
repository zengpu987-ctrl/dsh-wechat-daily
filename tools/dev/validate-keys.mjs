import fs from 'node:fs'
import path from 'node:path'
import { readSalt, verifyKey, PAGE_SIZE } from '../lib/sqlcipher.mjs'

const ROOT = process.argv[2] ?? `${process.env.HOME}/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files`
const CAND = process.argv[3] ?? '/tmp/wechat-probe/candidates.json'
const OUT = process.argv[4] ?? '/tmp/wechat-probe/keys.json'
const cands = JSON.parse(fs.readFileSync(CAND, 'utf8'))   // salt(hex) -> key(hex)
const bySalt = new Map(Object.entries(cands))

const out = {}
let hit = 0, miss = 0
for (const acct of fs.readdirSync(ROOT)) {
  const dir = path.join(ROOT, acct, 'db_storage')
  if (!fs.existsSync(dir)) continue
  out[acct] = {}
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.db')) continue
      const rel = path.relative(path.join(ROOT, acct), p)
      let salt
      try { salt = readSalt(p) } catch { continue }
      const hex = salt.toString('hex')
      const keyHex = bySalt.get(hex)
      if (!keyHex) { miss++; continue }
      const fd = fs.openSync(p, 'r')
      const page1 = Buffer.alloc(PAGE_SIZE); fs.readSync(fd, page1, 0, PAGE_SIZE, 0); fs.closeSync(fd)
      const ok = verifyKey(Buffer.from(keyHex, 'hex'), salt, page1)
      out[acct][rel] = { key: keyHex, salt: hex, verified: ok, bytes: fs.statSync(p).size }
      ok ? hit++ : miss++
    }
  }
  walk(dir)
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`verified=${hit} miss=${miss} -> ${OUT}`)
for (const [acct, m] of Object.entries(out)) {
  const n = Object.keys(m).length, v = Object.values(m).filter((x) => x.verified).length
  console.log(`  ${acct}: ${v}/${n} verified`)
  for (const [rel, info] of Object.entries(m).slice(0, 4)) console.log(`    ${info.verified ? 'OK ' : 'BAD'} ${rel} (${(info.bytes/1e6).toFixed(1)}MB)`)
}
