/**
 * Minimal read-only SQLCipher 4 reader for WeChat 4.x local databases.
 *
 * Parameters WCDB uses: page 4096, AES-256-CBC, HMAC-SHA512, 80-byte reserve
 * per page (16-byte IV + 64-byte HMAC), raw 32-byte key. Page 1 stores the
 * 16-byte salt where a plaintext database stores its header, so decryption
 * restores the SQLite header and pads the reserve area.
 *
 * A live WeChat keeps recent writes in the encrypted WAL. Frames are applied
 * only while the WAL's own checksum chain stays valid, so a torn tail from a
 * checkpoint racing this read is dropped instead of corrupting pages.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'

export const PAGE_SIZE = 4096
const SALT_SZ = 16
const IV_SZ = 16
const HMAC_SZ = 64
const RESERVE = IV_SZ + HMAC_SZ
const SQLITE_HDR = Buffer.from('SQLite format 3\u0000', 'latin1')
const EMPTY = Buffer.alloc(RESERVE)
const WAL_HEADER = 32
const FRAME_HEADER = 24

export function deriveMacKey(key, salt) {
  const macSalt = Buffer.from(salt.map((b) => b ^ 0x3a))
  return crypto.pbkdf2Sync(key, macSalt, 2, 32, 'sha512')
}

/** Derive one database's key from the account master key (WeChat 4.x scheme). */
export function deriveDatabaseKey(masterKey, salt) {
  return crypto.pbkdf2Sync(masterKey, salt, 256000, 32, 'sha512')
}

/** True when `key` decrypts page 1 of a database whose salt is `salt`. */
export function verifyKey(key, salt, page1) {
  if (page1.length < PAGE_SIZE) return false
  try {
    const mac = crypto.createHmac('sha512', deriveMacKey(key, salt))
    mac.update(page1.subarray(SALT_SZ, PAGE_SIZE - HMAC_SZ))
    const pgno = Buffer.alloc(4)
    pgno.writeUInt32LE(1)
    mac.update(pgno)
    return crypto.timingSafeEqual(mac.digest(), page1.subarray(PAGE_SIZE - HMAC_SZ))
  } catch {
    return false
  }
}

export function readSalt(path) {
  const fd = fs.openSync(path, 'r')
  try {
    const b = Buffer.alloc(SALT_SZ)
    fs.readSync(fd, b, 0, SALT_SZ, 0)
    return b
  } finally {
    fs.closeSync(fd)
  }
}

function decryptPage(key, page, pgno) {
  const iv = page.subarray(PAGE_SIZE - RESERVE, PAGE_SIZE - RESERVE + IV_SZ)
  const body = pgno === 1 ? page.subarray(SALT_SZ, PAGE_SIZE - RESERVE) : page.subarray(0, PAGE_SIZE - RESERVE)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(body), decipher.final()])
  return pgno === 1 ? Buffer.concat([SQLITE_HDR, plain, EMPTY]) : Buffer.concat([plain, EMPTY])
}

function walChecksum(native, bytes, state) {
  let s1 = state[0]
  let s2 = state[1]
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (native) {
      s1 = (s1 + (bytes[i] | (bytes[i + 1] << 8))) >>> 0
      s2 = (s2 + s1 + ((bytes[i + 1] | (bytes[i] << 8)) >>> 0)) >>> 0
    } else {
      s1 = (s1 + ((bytes[i] << 8) | bytes[i + 1])) >>> 0
      s2 = (s2 + s1 + (((bytes[i + 1] << 8) | bytes[i]) >>> 0)) >>> 0
    }
  }
  return [s1, s2]
}

/** Frames whose checksum chain is valid, truncated at the last committed frame. */
function validWalFrames(wal) {
  if (wal.length < WAL_HEADER + FRAME_HEADER) return null
  const magic = wal.readUInt32BE(0)
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return null
  if (wal.readUInt32BE(8) !== PAGE_SIZE) return null
  const native = magic === 0x377f0683
  const salt1 = wal.readUInt32BE(16)
  const salt2 = wal.readUInt32BE(20)
  let state = walChecksum(native, wal.subarray(0, 24), [0, 0])
  if (state[0] !== wal.readUInt32BE(24) || state[1] !== wal.readUInt32BE(28)) return null
  const stride = FRAME_HEADER + PAGE_SIZE
  const frames = []
  for (let off = WAL_HEADER; off + stride <= wal.length; off += stride) {
    if (wal.readUInt32BE(off + 8) !== salt1 || wal.readUInt32BE(off + 12) !== salt2) break
    state = walChecksum(native, wal.subarray(off, off + 8), state)
    state = walChecksum(native, wal.subarray(off + FRAME_HEADER, off + FRAME_HEADER + PAGE_SIZE), state)
    if (state[0] !== wal.readUInt32BE(off + 16) || state[1] !== wal.readUInt32BE(off + 20)) break
    frames.push({ pgno: wal.readUInt32BE(off), commit: wal.readUInt32BE(off + 4), at: off + FRAME_HEADER })
  }
  let lastCommit = -1
  for (let i = 0; i < frames.length; i++) if (frames[i].commit !== 0) lastCommit = i
  return lastCommit < 0 ? [] : frames.slice(0, lastCommit + 1)
}

function applyFrames(plain, key, wal, frames) {
  for (const f of frames) {
    if (f.pgno === 0) continue
    const at = (f.pgno - 1) * PAGE_SIZE
    if (at + PAGE_SIZE > plain.length) {
      const grown = Buffer.alloc(at + PAGE_SIZE)
      plain.copy(grown, 0, 0, plain.length)
      plain = grown
    }
    decryptPage(key, wal.subarray(f.at, f.at + PAGE_SIZE), f.pgno).copy(plain, at)
  }
  return plain
}

/**
 * Decrypt a database snapshot into `outPath`.
 * Returns which sources were used so callers can report a possible WAL gap.
 */
export function decryptDatabase(inPath, outPath, key, { wal = true } = {}) {
  const src = fs.readFileSync(inPath)
  const pages = Math.floor(src.length / PAGE_SIZE)
  if (pages === 0) throw new Error(`not a database page file: ${inPath}`)
  let plain = Buffer.alloc(pages * PAGE_SIZE)
  for (let i = 0; i < pages; i++) {
    const from = i * PAGE_SIZE
    decryptPage(key, src.subarray(from, from + PAGE_SIZE), i + 1).copy(plain, from)
  }
  let applied = 0
  const walPath = `${inPath}-wal`
  if (wal && fs.existsSync(walPath)) {
    const walBuf = fs.readFileSync(walPath)
    const frames = validWalFrames(walBuf)
    if (frames && frames.length) {
      plain = applyFrames(plain, key, walBuf, frames)
      applied = frames.length
    }
  }
  fs.mkdirSync(outPath.slice(0, outPath.lastIndexOf('/')), { recursive: true })
  fs.writeFileSync(outPath, plain)
  return { pages, walFrames: applied }
}
