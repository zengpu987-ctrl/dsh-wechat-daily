# 贡献

## 本地开发

```sh
git clone <this repo> dsh-wechat-daily
cd dsh-wechat-daily
node --test test/          # 单元测试，不需要微信
```

在 DSH 里安装：

```text
plugin_manager action=install_bundle target=/absolute/path/to/dsh-wechat-daily
```

宿主半改动后需要停用再启用该插件（`include:dsh-wechat-daily`）才会重新加载模块。

## 代码地图

| 文件 | 职责 |
|---|---|
| `lib/sqlcipher.mjs` | SQLCipher 4 只读解密、HMAC 校验、WAL 帧合并 |
| `lib/wechat.mjs` | 账号发现、快照、表结构与消息解析 |
| `lib/digest.mjs` | 会话排序、提示词、模型 JSON 解析 |
| `lib/report.mjs` | 编排、渲染、落盘 |
| `index.js` | 路由、定时、工具注册 |
| `client.js` | 设置页 |

## 约定

- 新增解析逻辑请配套 `test/` 用例；不引入运行时依赖（只用 Node 内置模块）。
- 不要扩大数据外发范围；任何模型调用都必须能一键关闭。
- 提交前跑 `node --test test/`。
