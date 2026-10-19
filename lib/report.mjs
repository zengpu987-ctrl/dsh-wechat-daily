/**
 * Compose the daily WeChat report: collect, rank, optionally narrate with the
 * host model, then store markdown + JSON under the plugin's state directory.
 */
import fs from 'node:fs'
import path from 'node:path'
import { listAccounts, readKeyStore, collectMessages, writeKeyStore, DEFAULT_DATA_ROOT } from './wechat.mjs'
import { rankConversations, buildDigest, summarizeMessage, REPORT_PROMPT, parseModelJson } from './digest.mjs'

export function dayRange(date = new Date(), timeZone = 'Asia/Shanghai') {
  const fmt = (d) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  const stamp = fmt(date)
  const startOfDay = (s) => {
    // Shanghai is fixed at +08:00: build the instant explicitly.
    const [y, m, d] = s.split('-').map(Number)
    return Math.floor(Date.UTC(y, m - 1, d, 0, 0, 0) / 1000) - 8 * 3600
  }
  const start = startOfDay(stamp)
  return { date: stamp, since: start, until: start + 86400 - 1, endOfDay: start + 86400 }
}

export function reportPaths(stateDir, date) {
  const dir = path.join(stateDir, 'reports')
  return { dir, markdown: path.join(dir, `${date}.md`), json: path.join(dir, `${date}.json`) }
}

export function readReport(stateDir, date) {
  const { markdown, json } = reportPaths(stateDir, date)
  if (!fs.existsSync(json)) return null
  return { date, markdown: fs.existsSync(markdown) ? fs.readFileSync(markdown, 'utf8') : '', data: JSON.parse(fs.readFileSync(json, 'utf8')) }
}

export function listReports(stateDir, limit = 30) {
  const dir = path.join(stateDir, 'reports')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => {
      const date = f.replace(/\.json$/, '')
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        return { date, headline: data.headline ?? '', headlineCount: data.must?.length ?? 0, generatedAt: data.generatedAt }
      } catch {
        return { date, headline: '', headlineCount: 0 }
      }
    })
}

function weekday(dateStamp) {
  return '日一二三四五六'[new Date(`${dateStamp}T12:00:00+08:00`).getDay()]
}

function clock(unix) {
  return new Date(unix * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai', hour12: false })
}

export function renderHeuristic(ranked, meta) {
  const actionable = ranked.filter((c) => c.score >= 35 && !c.service).slice(0, 8)
  const noteworthy = ranked.filter((c) => c.score >= 10 && c.score < 35).slice(0, 8)
  const rest = ranked.filter((c) => !actionable.includes(c) && !noteworthy.includes(c))
  const total = ranked.reduce((n, c) => n + c.messageCount, 0)
  const lines = []
  lines.push(`# 微信日报 · ${meta.date} 周${weekday(meta.date)}`)
  lines.push('')
  lines.push(`> 今天共 ${total} 条消息，来自 ${ranked.length} 个会话（私聊 ${ranked.filter((c) => !c.isGroup).length}、群 ${ranked.filter((c) => c.isGroup).length}）。`)
  lines.push('')
  if (actionable.length) {
    lines.push('## 需要你留意')
    for (const chat of actionable) {
      lines.push('')
      lines.push(`### ${chat.isGroup ? '群' : ''}「${chat.display}」 ${chat.messageCount} 条`)
      if (chat.signals.length) lines.push(`*${chat.signals.join('；')}*`)
      for (const m of chat.messages.filter((x) => !x.isMe).slice(-3)) {
        const text = summarizeMessage(m)
        if (text) lines.push(`- ${clock(m.time)} ${m.sender}：${text}`)
      }
    }
    lines.push('')
  }
  if (noteworthy.length) {
    lines.push('## 顺带一看')
    for (const chat of noteworthy) lines.push(`- 「${chat.display}」${chat.messageCount} 条${chat.signals.length ? ' · ' + chat.signals.join('；') : ''}`)
    lines.push('')
  }
  lines.push('## 可以忽略')
  if (rest.length) {
    for (const chat of rest.slice(0, 12)) lines.push(`- 「${chat.display}」${chat.messageCount} 条${chat.service ? ' · 服务号/推广' : ''}`)
  } else {
    lines.push('- 今天没有需要忽略的会话')
  }
  return lines.join('\n')
}

export function renderNarrated(narrative, ranked, meta) {
  const total = ranked.reduce((n, c) => n + c.messageCount, 0)
  const lines = []
  lines.push(`# 微信日报 · ${meta.date} 周${weekday(meta.date)}`)
  lines.push('')
  lines.push(`> 今天共 ${total} 条消息，来自 ${ranked.length} 个会话${narrative.must?.length ? `；${narrative.must.length} 件事可能要你处理` : ''}。`)
  lines.push('')
  if (narrative.headline) {
    lines.push(`**${narrative.headline}**`)
    lines.push('')
  }
  if (narrative.must?.length) {
    lines.push('## 需要处理')
    narrative.must.forEach((item, i) => {
      lines.push('')
      const who = item.who && item.who !== item.chat ? ` · ${item.who}` : ''
      lines.push(`${i + 1}. **${item.chat ?? ''}${who}** — ${item.what ?? ''}`)
      if (item.why) lines.push(`   - 为什么重要：${item.why}`)
      if (item.action) lines.push(`   - 你要做：${item.action}`)
    })
    lines.push('')
  }
  if (narrative.watch?.length) {
    lines.push('## 值得一看')
    for (const item of narrative.watch) lines.push(`- **${item.chat ?? ''}** — ${item.what ?? ''}`)
    lines.push('')
  }
  if (narrative.noise?.length) {
    lines.push('## 可以忽略')
    for (const item of narrative.noise) lines.push(`- 「${item.chat ?? ''}」${item.count ? item.count + ' 条' : ''}${item.why ? ' · ' + item.why : ''}`)
    lines.push('')
  }
  if (narrative.insights?.length) {
    lines.push('## 观察')
    for (const line of narrative.insights) lines.push(`- ${line}`)
    lines.push('')
  }
  lines.push('<details><summary>今日会话明细</summary>')
  lines.push('')
  for (const chat of ranked.slice(0, 25)) {
    lines.push(`- ${chat.isGroup ? '群' : '单聊'}「${chat.display}」${chat.messageCount} 条${chat.myMessageCount ? ` · 我发言 ${chat.myMessageCount}` : ''}${chat.service ? ' · 服务号' : ''}`)
  }
  lines.push('')
  lines.push('</details>')
  return lines.join('\n')
}

/**
 * Generate one day's report.
 * @param options.stateDir plugin state directory
 * @param options.ask optional ({system, user}) => Promise<string> model call
 */
export async function generateReport(options) {
  const {
    stateDir,
    dataRoot = DEFAULT_DATA_ROOT,
    date = new Date().toISOString().slice(0, 10),
    ask = null,
    focusKeywords = [],
    myNames = [],
    accountIds = null,
  } = options
  const range = dayRange(new Date(`${date}T12:00:00+08:00`))
  const store = readKeyStore(stateDir)
  const accounts = listAccounts(dataRoot).filter((a) => (accountIds?.length ? accountIds.includes(a.id) : true))
  if (!accounts.length) throw new Error(`没有在 ${dataRoot} 找到微信账号目录`)
  const keyed = accounts.filter((a) => store.accounts?.[a.id]?.master || Object.keys(store.derived ?? {}).some((k) => k.startsWith(a.id + '/')))
  if (!keyed.length) {
    const err = new Error('还没有微信数据库密钥：请先运行一次密钥捕获')
    err.code = 'NO_KEYS'
    throw err
  }

  const cacheDir = path.join(stateDir, 'cache')
  const all = []
  const stats = { databases: 0, tables: 0, rows: 0, walSkipped: [], accounts: [] }
  for (const account of keyed) {
    const res = collectMessages(account, store, cacheDir, { since: range.since, until: range.until })
    stats.databases += res.stats.databases
    stats.tables += res.stats.tables
    stats.rows += res.stats.rows
    stats.walSkipped.push(...res.stats.walSkipped)
    stats.accounts.push(account.id)
    const selfNames = ['我']
    for (const conv of res.conversations) all.push(conv)
    void selfNames
  }
  writeKeyStore(stateDir, store)

  const ranked = rankConversations(all, { myNames, focusKeywords })
  const meta = { date, range, stats, generatedAt: new Date().toISOString() }
  const total = ranked.reduce((n, c) => n + c.messageCount, 0)

  if (!total) {
    const empty = `# 微信日报 · ${date} 周${weekday(date)}\n\n今天微信里没有新消息。\n`
    const paths = reportPaths(stateDir, date)
    fs.mkdirSync(paths.dir, { recursive: true })
    fs.writeFileSync(paths.markdown, empty)
    const data = { ...meta, headline: '今天没有新消息', must: [], watch: [], noise: [], insights: [], stats: { ...stats, total } }
    fs.writeFileSync(paths.json, JSON.stringify(data, null, 2))
    return { date, markdown: empty, data }
  }

  let narrative = null
  let modelError = null
  if (ask) {
    try {
      const digest = buildDigest(ranked, { maxChats: 14, perChat: 12 })
      const text = await ask({ system: REPORT_PROMPT, user: `日期：${date}\n${digest}` })
      narrative = parseModelJson(text)
      if (!narrative) modelError = '模型返回的内容不是可解析的 JSON'
    } catch (error) {
      modelError = error instanceof Error ? error.message : String(error)
    }
  }

  const markdown = narrative ? renderNarrated(narrative, ranked, meta) : renderHeuristic(ranked, meta)
  const data = {
    ...meta,
    headline: narrative?.headline ?? '',
    must: narrative?.must ?? [],
    watch: narrative?.watch ?? [],
    noise: narrative?.noise ?? [],
    insights: narrative?.insights ?? [],
    modelError,
    stats: { ...stats, total, conversations: ranked.length },
    conversations: ranked.slice(0, 40).map((c) => ({
      display: c.display,
      username: c.username,
      isGroup: c.isGroup,
      messageCount: c.messageCount,
      myMessageCount: c.myMessageCount,
      score: c.score,
      signals: c.signals,
      service: c.service,
      samples: c.messages.filter((m) => !m.isMe).slice(-3).map((m) => ({ time: m.time, sender: m.sender, text: summarizeMessage(m) })),
    })),
  }
  const paths = reportPaths(stateDir, date)
  fs.mkdirSync(paths.dir, { recursive: true })
  fs.writeFileSync(paths.markdown, markdown)
  fs.writeFileSync(paths.json, JSON.stringify(data, null, 2))
  return { date, markdown, data }
}
