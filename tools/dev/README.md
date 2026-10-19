# 一次性诊断脚本

这些不是插件运行需要的，只是在取密钥/排查时用过，留作参考：

| 文件 | 用途 |
|---|---|
| `validate-keys.mjs` | 把候选 `salt -> key` 映射逐个用 page 1 HMAC 验证，输出可用的 `keys.json` |
| `analyze-mem.mjs` | 在整块内存转储里找 salt/keystring 线索（字符串路线用；4.1.x 上通常一无所获） |

```sh
node tools/dev/validate-keys.mjs <xwechat_files 根> <candidates.json> <out.json>
```

它们只做本地计算，不联网。
