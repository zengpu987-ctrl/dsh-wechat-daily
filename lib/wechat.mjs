/**
 * Read-only access to WeChat 4.x local data.
 *
 * Everything here works from snapshots: a database (and its plaintext WAL
 * header) is copied first, decrypted into a private cache, then queried with
 * node:sqlite. Nothing writes back into WeChat's container.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { decryptDatabase, deriveDatabaseKey, readSalt, verifyKey, PAGE_SIZE } from './sqlcipher.mjs'

export const DEFAULT_DATA_ROOT = path.join(
  os.homedir(),
  'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files',
)

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const MSG_TYPE = {
  1: 'text', 3: 'image', 34: 'voice', 42: 'card', 43: 'video', 47: 'sticker',
  48: 'location', 49: 'link', 50: 'call', 10000: 'system', 10002: 'revoke',
}

export function listAccounts(root = DEFAULT_DATA_ROOT) {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('wxid_'))
    .map((e) => ({ id: e.name, dir: path.join(root, e.name), wxid: e.name.replace(/_[0-9a-f]{4}$/, '') }))
}

/** Every encrypted database of one account, keyed by its account-relative path. */
export function listDatabases(account) {
  const out = []
  const base = path.join(account.dir, 'db_storage')
  if (!fs.existsSync(base)) return out
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.db')) out.push({ path: p, rel: path.relative(account.dir, p) })
    }
  }
  walk(base)
  return out
}

export function readKeyStore(stateDir) {
  const file = path.join(stateDir, 'keys.json')
  if (!fs.existsSync(file)) return { accounts: {}, derived: {} }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (raw.accounts) return raw
  // Migrate the per-database form produced by the first capture.
  const derived = {}
  for (const [acct, entries] of Object.entries(raw)) {
    for (const [rel, info] of Object.entries(entries)) derived[`${acct}/${rel}`] = { salt: info.salt, key: info.key }
  }
  return { accounts: {}, derived }
}

export function writeKeyStore(stateDir, store) {
  fs.mkdirSync(stateDir, { recursive: true })
  const file = path.join(stateDir, 'keys.json')
  fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

/** Resolve (and cache) one database key, deriving it from the master when new. */
export function keyFor(store, account, dbPath, rel) {
  const salt = readSalt(dbPath)
  const saltHex = salt.toString('hex')
  const id = `${account.id}/${rel}`
  const cached = store.derived?.[id]
  if (cached?.salt === saltHex && cached.key) return Buffer.from(cached.key, 'hex')
  const master = store.accounts?.[account.id]?.master
  if (!master) return null
  const key = deriveDatabaseKey(Buffer.from(master, 'hex'), salt)
  const fd = fs.openSync(dbPath, 'r')
  const page1 = Buffer.alloc(PAGE_SIZE)
  fs.readSync(fd, page1, 0, PAGE_SIZE, 0)
  fs.closeSync(fd)
  if (!verifyKey(key, salt, page1)) return null
  store.derived ??= {}
  store.derived[id] = { salt: saltHex, key: key.toString('hex') }
  return key
}

function snapshot(account, rel, cacheDir) {
  const src = path.join(account.dir, rel)
  const dst = path.join(cacheDir, account.id, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  const walSrc = `${src}-wal`
  const walDst = `${dst}-wal`
  if (fs.existsSync(walSrc)) fs.copyFileSync(walSrc, walDst)
  else if (fs.existsSync(walDst)) fs.rmSync(walDst)
  return dst
}

function quickCheck(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = db.prepare('pragma quick_check(8)').all()
    return rows.length === 1 && rows[0].quick_check === 'ok'
  } catch {
    return false
  } finally {
    db.close()
  }
}

/** Decrypt one database, preferring its WAL but never returning a broken image. */
export function openPlain(account, rel, key, cacheDir) {
  const snap = snapshot(account, rel, path.join(cacheDir, 'snap'))
  const plain = path.join(cacheDir, 'plain', account.id, `${rel}.sqlite`)
  fs.mkdirSync(path.dirname(plain), { recursive: true })
  const merged = decryptDatabase(snap, plain, key, { wal: true })
  if (merged.walFrames === 0 || quickCheck(plain)) return { file: plain, ...merged }
  // A racing checkpoint produced frames that do not fit this database image.
  const base = decryptDatabase(snap, plain, key, { wal: false })
  return { file: plain, ...base, walSkipped: true }
}

export function decodeContent(raw, contentType) {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  const buf = Buffer.from(raw)
  if (buf.length === 0) return ''
  if (contentType === 4 || buf.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try {
      return zlib.zstdDecompressSync(buf).toString('utf8')
    } catch {
      return ''
    }
  }
  return buf.toString('utf8')
}

export function baseType(localType) {
  return Number(BigInt(localType) & 0xffffffffn)
}

export function typeName(localType) {
  return MSG_TYPE[baseType(localType)] ?? 'other'
}

function md5Of(username) {
  return crypto.createHash('md5').update(username).digest('hex')
}

function loadContacts(account, store, cacheDir) {
  const rel = 'db_storage/contact/contact.db'
  const dbPath = path.join(account.dir, rel)
  const names = new Map()
  if (!fs.existsSync(dbPath)) return { names, self: account.wxid }
  const key = keyFor(store, account, dbPath, rel)
  if (!key) return { names, self: account.wxid }
  const { file } = openPlain(account, rel, key, cacheDir)
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    for (const row of db.prepare('select username, remark, nick_name, local_type from contact').iterate()) {
      const display = (row.remark && String(row.remark).trim()) || row.nick_name || row.username
      names.set(row.username, { display, nick: row.nick_name, remark: row.remark, localType: row.local_type })
    }
    for (const row of db.prepare('select username from stranger').iterate()) {
      if (!names.has(row.username)) names.set(row.username, { display: row.username })
    }
  } catch {
    /* a partial contact table is still better than none */
  } finally {
    db.close()
  }
  return { names, self: account.wxid }
}

function selfWxid(account, namesDB) {
  return account.wxid
}

/**
 * Collect messages between `since` and `until` (unix seconds) for one account.
 * Returns conversations grouped by chat, newest message per chat included.
 */
export function collectMessages(account, store, cacheDir, { since, until = Math.floor(Date.now() / 1000) }) {
  const { names } = loadContacts(account, store, cacheDir)
  const byHash = new Map()
  for (const [username] of names) byHash.set(md5Of(username), username)
  const me = account.wxid

  const dbs = listDatabases(account).filter((d) => /db_storage\/message\/message_\d+\.db$/.test(d.rel))
  const chats = new Map()
  const stats = { databases: 0, tables: 0, rows: 0, walSkipped: [] }

  for (const dbInfo of dbs) {
    const key = keyFor(store, account, dbInfo.path, dbInfo.rel)
    if (!key) continue
    const { file, walSkipped } = openPlain(account, dbInfo.rel, key, cacheDir)
    if (walSkipped) stats.walSkipped.push(dbInfo.rel)
    stats.databases++
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const senderIds = new Map()
      for (const row of db.prepare('select rowid as id, user_name from Name2Id').iterate()) {
        senderIds.set(Number(row.id), row.user_name)
      }
      const tables = db
        .prepare("select name from sqlite_master where type='table'")
        .all()
        .map((r) => r.name)
        .filter((n) => /^Msg_[0-9a-f]{32}$/.test(n))
      for (const table of tables) {
        stats.tables++
        const hash = table.slice(4)
        const username = byHash.get(hash) ?? (chats.get(hash)?.username ?? null)
        let rows
        try {
          rows = db
            .prepare(
              `select local_id, local_type, real_sender_id, create_time, message_content,
                      WCDB_CT_message_content as ct, source
                 from "${table}" where create_time >= ? and create_time <= ? order by create_time asc`,
            )
            .all(since, until)
        } catch {
          continue
        }
        if (!rows.length) continue
        stats.rows += rows.length
        const key2 = username ?? `unknown:${hash}`
        let chat = chats.get(key2)
        if (!chat) {
          const info = names.get(key2)
          chat = {
            username: key2,
            display: info?.display ?? (key2.endsWith('@chatroom') ? '未命名群聊' : key2),
            isGroup: key2.endsWith('@chatroom'),
            messages: [],
          }
          chats.set(key2, chat)
        }
        for (const row of rows) {
          const senderWxid = senderIds.get(Number(row.real_sender_id)) ?? ''
          const isMe = senderWxid === me
          const senderName = isMe ? '我' : names.get(senderWxid)?.display ?? senderWxid ?? chat.display
          chat.messages.push({
            time: Number(row.create_time),
            sender: senderName,
            senderWxid,
            isMe,
            type: typeName(row.local_type),
            localType: String(row.local_type),
            text: decodeContent(row.message_content, row.ct).trim(),
            source: typeof row.source === 'string' ? row.source : '',
          })
        }
      }
    } finally {
      db.close()
    }
  }

  const conversations = [...chats.values()]
    .map((c) => {
      c.messages.sort((a, b) => a.time - b.time)
      const mine = c.messages.filter((m) => m.isMe).length
      return { ...c, messageCount: c.messages.length, myMessageCount: mine }
    })
    .sort((a, b) => b.messages.length - a.messages.length)
  return { conversations, stats, names }
}
