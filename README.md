# dsh-wechat-daily · 微信日报

一个装进 **DeepSeek Harness** 设置页的微信日报插件：每天结束前，把本机微信里发生的事整理成一份日报，
分成 **需要处理**、**值得一看**、**可以忽略** 三段；同时在对话里给 agent 一个 `wechat_daily_report` 工具。

只读微信本地数据库，不发消息、不改数据。解密、排序、渲染全部在本机完成；模型那一步是可选的开关。

```
设置 → 微信日报
─────────────────────────────────────────────
微信日报
每天结束前，把微信里发生的事整理成一份日报。

[已绑定微信数据库 · 1] [今天 · 2026-10-20] [下次自动生成 · 21:30] [立即生成日报]

# 微信日报 · 2026-10-19 周一
> 今天共 186 条消息，来自 23 个会话；3 件事可能要你处理。
**导师叫你去办公室，还有人问能不能上课，两件都等你回应**
## 需要处理
1. **王老师** — 问开题报告什么时候给他，说周一要拿去评审
   - 为什么重要：有明确截止时间，且导师在等
   - 你要做：周日晚前把初稿发邮件给王老师
…
```

## 特性

- **只看该看的**：私聊、@我、被点名、涉及钱/截止/请求的消息往上抬；服务号、外卖券群、刷屏群往下压。
- **模型可选**：开着由模型写摘要与分类；关掉只走本地规则，一条消息都不出本机。
- **定时**：默认每天 21:30 生成，可改；错过的当天会在启动后补一次。
- **可追溯**：日报以 Markdown + JSON 存在 `~/.dsh/storages/dsh-wechat-daily/reports/`，随时可删。
- **只读**：解密到本机缓存后只做 SELECT；不写回微信容器，不需要关闭 SIP。

## 安装

前置：macOS（微信 4.x 桌面版）、Node ≥ 23.4（需要内置 `node:sqlite`）、已装 DeepSeek Harness。

```sh
git clone https://github.com/zengpu987-ctrl/dsh-wechat-daily.git
```

然后在 DSH 里安装这个目录：

```text
plugin_manager action=install_bundle target=/absolute/path/to/dsh-wechat-daily
```

装好后 **设置 → 微信日报** 会出现一页。首次打开会显示「尚未绑定微信数据库」——下面这步只做一次。

## 一次性密钥捕获

微信 4.x 的消息库是 WCDB / SQLCipher 4，密钥不在任何磁盘文件里明文保存，只在打开数据库的瞬间经过
`CCKeyDerivationPBKDF`。所以要取一次密钥，之后每天只读数据库。

流程（脚本在 `tools/keycapture/`，原理见 [docs/key-capture.md](docs/key-capture.md)）：

1. 正常退出微信（菜单「退出」，不要强杀）。
2. 复制 `/Applications/WeChat.app` 到临时目录，**只对副本**做 ad-hoc 重签——原版一个字节都不动。
3. 用 lldb 以父进程方式启动副本，在 `sqlite3_key` / `CCKeyDerivationPBKDF` / `PKCS5_PBKDF2_HMAC`
   上记录参数并自动继续。
4. 认出多库复用的那把主密钥，用它派生每库密钥，逐个用第 1 页 HMAC 验证。
5. 关掉副本、删临时目录、重新打开原版微信。

产物是 `~/.dsh/storages/dsh-wechat-daily/keys.json`（权限 600），只放主密钥与派生缓存。
**这个文件不要提交、不要上传、不要放进同步盘。**

> 微信换密钥（重装、重新登录、大版本改动方案）后需要重新捕获。多个微信账号各有主密钥，需分别捕获。

## 配置

设置页里可以改：是否每天自动生成、生成时间、是否让模型写摘要、我的昵称（用于识别点名）、关注关键词。
值存在 `~/.dsh/storages/dsh-wechat-daily/config.json`。

agent 工具：

| action | 作用 |
|---|---|
| `status` | 密钥是否已绑定、今天是否已生成、下次生成时间 |
| `generate` | 立即生成（可带 `date: YYYY-MM-DD`） |
| `latest` | 读出现成的日报正文 |

## 它是怎么读数据的

1. 账号主密钥 + 每个库自己的 salt → 派生该库密钥（PBKDF2-HMAC-SHA512，256000 轮）。
2. 先给数据库和它的 `-wal` 做快照，再逐页解密到缓存；WAL 帧只在 SQLite 校验链完整时才应用，
   合并结果过 `quick_check`，不通过就退回主库镜像——宁可少最后几条，也不返回损坏数据。
3. `node:sqlite` 只读查询 `Msg_<md5(username)>` 表，按 `Name2Id` 还原发言人，按 `contact` 还原会话名，
   按 `WCDB_CT_message_content` 判断 zstd 压缩并解压。

## 文件地图

| 文件 | 职责 |
|---|---|
| `lib/sqlcipher.mjs` | SQLCipher 4 只读解密、HMAC 校验、WAL 帧合并 |
| `lib/wechat.mjs` | 账号发现、快照、表结构与消息解析 |
| `lib/digest.mjs` | 会话排序、提示词、模型 JSON 解析 |
| `lib/report.mjs` | 编排、渲染、落盘 |
| `index.js` | HTTP 路由、定时、agent 工具 |
| `client.js` | 设置页（React，无构建步骤） |
| `tools/keycapture/` | lldb / 内存扫描取密钥脚本 |
| `docs/example-report.md` | 虚构的日报样例（不含任何真实聊天） |

## 测试

```sh
node --test "test/*.test.mjs"
```

`test/sqlcipher.test.mjs` 会按 WCDB 的真实页格式自行加密一份数据库（含 WAL 帧与校验链），
再验证解密、HMAC、WAL 合并与「尾部被写坏时不污染页面」；`test/digest.test.mjs` 覆盖排序、
点名识别、JSON 容错与长度预算。不需要微信、不需要密钥。

## 已知限制

- 只处理文本类消息；图片、语音、视频、表情只记成 `[图片]` 之类的占位。
- 只读本机已同步的聊天；手机上未迁移到电脑的历史不在这里。
- 每个微信账号一份主密钥，多账号需分别捕获；未绑定账号会被跳过（页面显示 `hasKey: false`）。
- 日报质量取决于所选模型；模型不可用时自动退回本地规则版并标注原因。

## 隐私与免责

- 解密、排序、渲染全在本机；只有你打开「让模型写摘要」时，被选中会话的摘要才会发给当前模型。
- 请勿在 issue 里粘贴 `keys.json`、真实 `wxid`、聊天截图或完整日报。
- 本项目用于**本人设备上本人账号**的数据整理。在部分司法辖区，绕过客户端加密可能受限；
  微信更新也可能使流程失效。作者不对使用后果负责，详见 [LICENSE](LICENSE)。

## License

MIT © 2026 Zeng pu
