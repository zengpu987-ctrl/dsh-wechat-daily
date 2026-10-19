import fs from 'node:fs'
import path from 'node:path'
import { readSalt, verifyKey, PAGE_SIZE } from '../lib/sqlcipher.mjs'

const MEM = process.argv[2] ?? '/tmp/wechat-probe/mem.bin'
const KEYS_JSON = process.argv[3] ?? '/tmp/wechat-probe/keys.json'
const ROOT = `${process.env.HOME}/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files`

// Collect every (db file -> salt) pair we care about, from the candidate map.
const dbs = []
for (const acct of fs.readdirSync(ROOT)) {
  const base = path.join(ROOT, acct)
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.db')) continue
      try {
        const salt = readSalt(p)
        dbs.push({ path: p, rel: path.relative(ROOT, p), salt, saltHex: salt.toString('hex') })
      } catch {}
    }
  }
  if (fs.existsSync(path.join(base, 'db_storage'))) walk(path.join(base, 'db_storage'))
}
console.log(`dbs=${dbs.length}`)
const saltSet = new Set(dbs.map((d) => d.saltHex))

const HEXRUN = /[0-9a-fA-F]{32,200}/g
const found = new Map()     // saltHex -> contexts
const hex64 = new Set()
const CHUNK = 64 << 20, OVER = 256
const size = fs.statSync(MEM).size
const fd = fs.openSync(MEM, 'r')
let off = 0, chunks = 0
const t0 = Date.now()
while (off < size) {
  const n = Math.min(CHUNK, size - off)
  const buf = Buffer.alloc(n)
  fs.readSync(fd, buf, 0, n, off)
  chunks++
  // raw binary salt search
  for (const d of dbs) {
    let i = buf.indexOf(d.salt)
    while (i !== -1) {
      const ctx = buf.subarray(Math.max(0, i - 64), Math.min(n, i + 64)).toString('hex')
      if (!found.has(d.saltHex)) found.set(d.saltHex, [])
      if (found.get(d.saltHex).length < 3) found.get(d.saltHex).push({ off: off + i, ctx })
      i = buf.indexOf(d.salt, i + 1)
    }
  }
  // hex runs
  HEXRUN.lastIndex = 0
  let m
  const text = buf.toString('latin1')
  HEXRUN.lastIndex = 0
  while ((m = HEXRUN.exec(text)) !== null) {
    const run = m[0].toLowerCase()
    if (run.length === 64) hex64.add(run)
    for (const s of saltSet) {
      if (run.includes(s)) {
        const at = m.index
        const ctx = text.slice(Math.max(0, at - 80), Math.min(text.length, at + 120))
        if (!found.has(s)) found.set(s, [])
        if (found.get(s).length < 3) found.get(s).push({ off: off + at, ctx, viaHex: true })
      }
    }
  }
  off += n - OVER
  if (off + OVER >= size) break
  if (chunks % 20 === 0) console.log(`  ${(off / 1e9).toFixed(1)}GB, ${((Date.now() - t0) / 1000).toFixed(0)}s, hex64=${hex64.size}, saltHits=${found.size}`)
}
fs.closeSync(fd)
console.log(`scan done: saltHits=${found.size}/${dbs.length} hex64=${hex64.size}`)

// Try each 64-hex string as a key against every db.
let verified = 0
const results = []
for (const cand of hex64) {
  const key = Buffer.from(cand, 'hex')
  for (const d of dbs) {
    const f = fs.openSync(d.path, 'r')
    const p1 = Buffer.alloc(PAGE_SIZE); fs.readSync(f, p1, 0, PAGE_SIZE, 0); fs.closeSync(f)
    if (verifyKey(key, d.salt, p1)) {
      verified++
      results.push({ db: d.rel, key: cand })
      console.log(`  KEY MATCH ${d.rel} <- ${cand}`)
    }
  }
}
console.log(`hex64 keys verified=${verified}`)

for (const [saltHex, list] of found) {
  const d = dbs.find((x) => x.saltHex === saltHex)
  console.log(`\nsalt ${saltHex} (${d?.rel}) hits=${list.length}`)
  for (const h of list.slice(0, 2)) console.log(`  @${h.off} ${h.ctx?.slice(0, 260)}`)
}
fs.writeFileSync('/tmp/wechat-probe/analyze.json', JSON.stringify({ dbs: dbs.map((d) => ({ rel: d.rel, saltHex: d.saltHex })), found: [...found].map(([s, l]) => ({ saltHex: s, hits: l })), results }, null, 2))
