# 一次性密钥捕获：原理与步骤

## 结论先行

微信 4.x 每个数据库的加密密钥，是**账号主密钥** + **该库自己的 salt** 经
`CCKeyDerivationPBKDF` 派生出来的：

```
enc_key(db) = PBKDF2-HMAC-SHA512(password = master_key_32B,
                                 salt     = db_salt_16B,
                                 rounds   = 256000,
                                 dkLen    = 32)
mac_key(db) = PBKDF2-HMAC-SHA512(password = enc_key,
                                 salt     = db_salt XOR 0x3a,
                                 rounds   = 2,
                                 dkLen    = 32)
```

主密钥不落盘，只在微信打开数据库的那一刻作为 `CCKeyDerivationPBKDF` 的 password 出现；
被复用在同一账号的所有库上（表现为「同一段 password + 很多不同 salt + 256000 轮」）。
所以只要抓到它一次，全部库的密钥都能算出来，并用第 1 页的 HMAC 逐个验证。

## 为什么不能直接读内存

- 主密钥在内存里是**原始 32 字节**，不是十六进制文本；所以按 `x'<hex><salt>'` 这类字符串特征
  扫描（旧版工具的做法）在 4.1.x 上会一无所获。
- 微信进程是 hardened runtime 签名，root 直接 `task_for_pid` 会被 AMFI / taskgated 拒绝
  （报 `this is a non-interactive debug session`）。
- 因此正确姿势是：**让 lldb 成为父进程**启动一份重签过的副本——父进程调试子进程不需要
  `task_for_pid` 权限。

## 步骤

1. **正常退出微信**（菜单「退出」）。之后原版微信保持不动。
2. **复制副本**：`ditto /Applications/WeChat.app /tmp/wechat-probe/WeChat.app`。
3. **只给副本重签**，保留原始 entitlements 但去掉身份字段
   （`com.apple.application-identifier`、`com.apple.developer.team-identifier`）：
   ```sh
   codesign --force --deep --sign - --entitlements noidentity.entitlements WeChat.app
   ```
   - 必须保留 `com.apple.security.app-sandbox` 与 `application-groups`：去掉后应用会以
     非沙箱方式运行、把数据根算到 `~/Documents/xwechat_files`，从而读不到真实数据；
     保留身份字段则会被 amfid 直接 SIGKILL。
   - 重签时必须去掉 hardened runtime（`codesign -s -` 默认就不带 `runtime` 标志），
     否则断点无法挂上。
4. **在三个点上挂断点并自动继续**（`tools/keycapture/capture2.py`）：
   - `sqlite3_key(db, pKey, nKey)` —— 有的版本直接在这里传明文密钥；
   - `CCKeyDerivationPBKDF(...)` —— 主密钥在这里作为 password 出现；
   - `PKCS5_PBKDF2_HMAC(...)` —— 若走 OpenSSL 实现则在这里。
   回调只读取寄存器/指针内容、写入 JSON、返回 `False` 自动继续，不阻塞微信启动。
5. **认主密钥**：统计同一个 password 在 256000 轮下出现了多少次，取最高的那把。
6. **验证**：对每个库用 `PBKDF2(master, salt, 256000)` 派生，算 page 1 的 HMAC-SHA512 与文件里
   存的值比对。全部通过才算成功（本项目在 4.1.11 上 20/20 通过）。
7. **收尾**：杀掉副本、删临时目录、重新打开原版微信。

## 页格式（解密器用到的）

SQLCipher 4 / WCDB：页 4096 字节，AES-256-CBC，HMAC-SHA512，每页保留区 80 字节
（16 字节 IV + 64 字节 HMAC）。

- 第 1 页：`[salt 16][ciphertext 4000][IV 16][HMAC 64]`，解密后要把
  `SQLite format 3\0` 补回前 16 字节；
- 其余页：`[ciphertext 4016][IV 16][HMAC 64]`；
- HMAC 覆盖 `ciphertext + IV` 加上小端序的页号（页 1 的 salt **不参与**认证）。

WAL 帧是 `24 字节帧头 + 一页密文`；帧的校验是 SQLite 自己的滚动 checksum，
只有整条链完整、且末尾有 commit 帧时才合并，否则丢弃尾部——这就是
`lib/sqlcipher.mjs` 里 `validWalFrames` 的作用。

## 已知边界

- 微信大版本若改动派生方式，需要重新确认断点与轮数。
- 每个账号一份主密钥；切账号要再做一次。
- 调试签名副本可能被客户端感知，请自行评估账号风险；只在本人设备、本人账号上使用。
