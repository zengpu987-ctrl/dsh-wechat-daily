import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decryptDatabase, deriveDatabaseKey, readSalt, verifyKey, PAGE_SIZE } from '../lib/sqlcipher.mjs'

const RESERVE = 80
const IV_SZ = 16
const KEY = crypto.createHash('sha256').update('dsh-wechat-daily test key').digest()
const SQLITE_HDR = Buffer.from('SQLite format 3\u0000', 'latin1')

/** Build the on-disk form of one page the way WCDB stores it. */
function encryptPage(key, plain, pgno, salt) {
  const iv = crypto.randomBytes(IV_SZ)
  const body = pgno === 1 ? plain.subarray(16, PAGE_SIZE - RESERVE) : plain.subarray(0, PAGE_SIZE - RESERVE)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  cipher.setAutoPadding(false)
  const enc = Buffer.concat([cipher.update(body), cipher.final()])
  const head = pgno === 1 ? Buffer.concat([salt, enc]) : enc
  const content = Buffer.concat([head, iv])
  const macSalt = Buffer.from(salt.map((b) => b ^ 0x3a))
  const macKey = crypto.pbkdf2Sync(key, macSalt, 2, 32, 'sha512')
  // SQLCipher authenticates the ciphertext + IV (never the page-1 salt) and the page number.
  const mac = crypto.createHmac('sha512', macKey)
  mac.update(Buffer.concat([enc, iv]))
  const counter = Buffer.alloc(4)
  counter.writeUInt32LE(pgno)
  mac.update(counter)
  const out = Buffer.concat([content, mac.digest()])
  assert.equal(out.length, PAGE_SIZE)
  return out
}

function plainPage(pgno, filler) {
  const page = Buffer.alloc(PAGE_SIZE)
  if (pgno === 1) SQLITE_HDR.copy(page, 0)
  else Buffer.from(`page-${pgno}-`).copy(page, 0)
  filler.copy(page, pgno === 1 ? 16 : 8)
  return page
}

function walChecksum(bytes, state, native = true) {
  let [s1, s2] = state
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

function buildWal(key, salt, frames) {
  const salt1 = 0x11223344
  const salt2 = 0x55667788
  const stride = 24 + PAGE_SIZE
  const wal = Buffer.alloc(32 + stride * frames.length)
  wal.writeUInt32BE(0x377f0683, 0)
  wal.writeUInt32BE(3007000, 4)
  wal.writeUInt32BE(PAGE_SIZE, 8)
  wal.writeUInt32BE(1, 12)
  wal.writeUInt32BE(salt1, 16)
  wal.writeUInt32BE(salt2, 20)
  let state = walChecksum(wal.subarray(0, 24), [0, 0])
  wal.writeUInt32BE(state[0], 24)
  wal.writeUInt32BE(state[1], 28)
  frames.forEach((frame, index) => {
    const off = 32 + index * stride
    wal.writeUInt32BE(frame.pgno, off)
    wal.writeUInt32BE(frame.commit ?? 0, off + 4)
    wal.writeUInt32BE(salt1, off + 8)
    wal.writeUInt32BE(salt2, off + 12)
    const page = encryptPage(key, frame.plain, frame.pgno, salt)
    page.copy(wal, off + 24)
    state = walChecksum(wal.subarray(off, off + 8), state)
    state = walChecksum(wal.subarray(off + 24, off + 24 + PAGE_SIZE), state)
    wal.writeUInt32BE(state[0], off + 16)
    wal.writeUInt32BE(state[1], off + 20)
  })
  return wal
}

function workdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshwd-'))
}

test('page 1 HMAC validates only with the right key and salt', () => {
  const salt = crypto.randomBytes(16)
  const plain = plainPage(1, crypto.randomBytes(4000))
  const enc = encryptPage(KEY, plain, 1, salt)
  assert.equal(verifyKey(KEY, salt, enc), true)
  assert.equal(verifyKey(crypto.randomBytes(32), salt, enc), false)
  assert.equal(verifyKey(KEY, crypto.randomBytes(16), enc), false)
})

test('round-trips a multi-page database', () => {
  const dir = workdir()
  const salt = crypto.randomBytes(16)
  const plains = [1, 2, 3].map((n) => plainPage(n, crypto.randomBytes(4000)))
  const dbPath = path.join(dir, 'fixture.db')
  fs.writeFileSync(dbPath, Buffer.concat(plains.map((p, i) => encryptPage(KEY, p, i + 1, salt))))
  assert.deepEqual(readSalt(dbPath), salt)

  const out = path.join(dir, 'out.db')
  const result = decryptDatabase(dbPath, out, KEY)
  assert.equal(result.pages, 3)
  assert.equal(result.walFrames, 0)
  const got = fs.readFileSync(out)
  plains.forEach((p, i) => assert.deepEqual(got.subarray(i * PAGE_SIZE, (i + 1) * PAGE_SIZE), p))
})

test('applies WAL frames up to the last commit', () => {
  const dir = workdir()
  const salt = crypto.randomBytes(16)
  const base = [1, 2].map((n) => plainPage(n, crypto.randomBytes(4000)))
  const dbPath = path.join(dir, 'fixture.db')
  fs.writeFileSync(dbPath, Buffer.concat(base.map((p, i) => encryptPage(KEY, p, i + 1, salt))))

  const replaced = [1, 2].map((n) => plainPage(n, crypto.randomBytes(4000)))
  const wal = buildWal(KEY, salt, [
    { pgno: 1, plain: replaced[0], commit: 0 },
    { pgno: 2, plain: replaced[1], commit: 2 },
  ])
  fs.writeFileSync(`${dbPath}-wal`, wal)

  const out = path.join(dir, 'out.db')
  const result = decryptDatabase(dbPath, out, KEY)
  assert.equal(result.walFrames, 2)
  const got = fs.readFileSync(out)
  assert.deepEqual(got.subarray(0, PAGE_SIZE), replaced[0])
  assert.deepEqual(got.subarray(PAGE_SIZE, PAGE_SIZE * 2), replaced[1])
})

test('drops a torn WAL tail instead of corrupting pages', () => {
  const dir = workdir()
  const salt = crypto.randomBytes(16)
  const base = [1, 2].map((n) => plainPage(n, crypto.randomBytes(4000)))
  const dbPath = path.join(dir, 'fixture.db')
  fs.writeFileSync(dbPath, Buffer.concat(base.map((p, i) => encryptPage(KEY, p, i + 1, salt))))
  const wal = buildWal(KEY, salt, [
    { pgno: 1, plain: plainPage(1, crypto.randomBytes(4000)), commit: 0 },
    { pgno: 2, plain: plainPage(2, crypto.randomBytes(4000)), commit: 2 },
  ])
  // Corrupt the second frame's stored checksum: the chain can no longer reach a commit.
  wal.writeUInt32BE(0xdeadbeef, 32 + 24 + PAGE_SIZE + 16)
  fs.writeFileSync(`${dbPath}-wal`, wal)

  const out = path.join(dir, 'out.db')
  const result = decryptDatabase(dbPath, out, KEY)
  assert.equal(result.walFrames, 0)
  const got = fs.readFileSync(out)
  base.forEach((p, i) => assert.deepEqual(got.subarray(i * PAGE_SIZE, (i + 1) * PAGE_SIZE), p))
})

test('derives a stable per-database key from the master key', () => {
  const master = crypto.randomBytes(32)
  const salt = crypto.randomBytes(16)
  const a = deriveDatabaseKey(master, salt)
  const b = deriveDatabaseKey(master, salt)
  assert.equal(a.length, 32)
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, deriveDatabaseKey(master, crypto.randomBytes(16)))
})
