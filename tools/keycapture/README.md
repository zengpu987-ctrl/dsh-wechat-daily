# 取密钥脚本（一次性）

这套脚本在 微信 4.1.11 / macOS 26 / Apple Silicon 上验证过，20 个库全部通过 HMAC 校验。
原理见 [../../docs/key-capture.md](../../docs/key-capture.md)。

| 文件 | 作用 |
|---|---|
| `capture2.py` | lldb 命令脚本：在 `sqlite3_key` / `CCKeyDerivationPBKDF` / `PKCS5_PBKDF2_HMAC` 上记录参数并自动继续 |
| `capture2.lldb` | lldb 启动脚本，import 上面的模块并运行 `capture_run` |
| `dumpmem.py` | 备用：把进程可读内存整块落盘（字符串扫描路线用，通常不需要） |
| `scan.py` | 备用：在已附加的进程里扫 `x'<hex><salt>'` 形状的候选 |
| `probe-attach.sh` | 诊断：root 下 `task_for_pid` 是否可用（多数环境会失败，属预期） |

## 一次完整流程

```sh
# 0) 退出微信，确认没有进程
pkill -TERM -x WeChat; sleep 3; pgrep -x WeChat && echo "still running"

# 1) 复制并只重签副本
mkdir -p /tmp/wechat-probe && cd /tmp/wechat-probe
ditto /Applications/WeChat.app WeChat.app
codesign -d --entitlements :- /Applications/WeChat.app > orig.entitlements
python3 - <<'PY'
import plistlib
d = plistlib.load(open('/tmp/wechat-probe/orig.entitlements','rb'))
for k in ['com.apple.application-identifier','com.apple.developer.team-identifier']:
    d.pop(k, None)
open('/tmp/wechat-probe/noidentity.entitlements','wb').write(plistlib.dumps(d))
PY
codesign --force --deep --sign - --entitlements noidentity.entitlements WeChat.app
codesign -dv --verbose=2 WeChat.app 2>&1 | grep flags   # 期望 0x2(adhoc)，不带 runtime

# 2) 用 lldb 启动副本并抓参数（约 60 秒）
cp <repo>/tools/keycapture/capture2.py /tmp/wechat-probe/
cp <repo>/tools/keycapture/capture2.lldb /tmp/wechat-probe/
lldb -b -s /tmp/wechat-probe/capture2.lldb \
  /tmp/wechat-probe/WeChat.app/Contents/MacOS/WeChat

# 3) 用抓到的参数验证并生成 keys.json
node <repo>/tools/dev/validate-keys.mjs   # 或按 docs/key-capture.md 自行验证

# 4) 收尾：关副本、重启原版
pkill -f "wechat-probe/WeChat.app/Contents/MacOS/WeChat"
rm -rf /tmp/wechat-probe
open -a /Applications/WeChat.app
```

> 这一步会碰到系统调试策略。部分机器需要临时 `sudo DevToolsSecurity -enable`，用完请还原。
> 不要重签 `/Applications/WeChat.app` 本身，不要关闭 SIP。
