/**
 * dsh-wechat-daily — a Settings-resident WeChat daily report for DeepSeek
 * Harness.
 *
 * The host half owns everything: it decrypts local WeChat 4.x databases with a
 * previously captured key, ranks the day's conversations, optionally narrates
 * them with the profile's own model, stores the report, and serves the small
 * JSON API the settings page reads. Nothing writes back into WeChat, and no
 * message text ever leaves the machine except in the model call the user
 * enabled.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateReport, readReport, listReports, dayRange, reportPaths } from './lib/report.mjs'
import { listAccounts, readKeyStore, DEFAULT_DATA_ROOT } from './lib/wechat.mjs'

export const name = 'dsh-wechat-daily'
export const inject = ['tools', 'webServer']

const ROUTE = '/plugins/dsh-wechat-daily'
const DEFAULT_CONFIG = {
  enabled: true,
  reportTime: '21:30',
  llmNarrative: true,
  myNames: '',
  focusKeywords: '',
  dataRoot: '',
  accounts: '',
  provider: '',
  model: '',
}

function stateDirOf(config) {
  if (config.stateDir) return config.stateDir
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'dsh-wechat-daily')
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function list(value) {
  return String(value ?? '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function json(res, code, body) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function todayStamp() {
  return new dayRange(new Date()).date
}

export function apply(ctx, config = {}) {
  const stateDir = stateDirOf({ ...DEFAULT_CONFIG, ...config })
  const configFile = path.join(stateDir, 'config.json')
  fs.mkdirSync(stateDir, { recursive: true })

  const settings = () => ({
    ...DEFAULT_CONFIG,
    ...config,
    ...readJson(configFile, {}),
    stateDir,
    dataRoot: readJson(configFile, {}).dataRoot || config.dataRoot || DEFAULT_DATA_ROOT,
  })

  let running = null
  let timer = null
  let lastRun = null

  function status() {
    const s = settings()
    const store = readKeyStore(stateDir)
    const accounts = listAccounts(s.dataRoot)
    const keyed = accounts.filter(
      (a) => store.accounts?.[a.id]?.master || Object.keys(store.derived ?? {}).some((k) => k.startsWith(`${a.id}/`)),
    )
    const today = todayStamp()
    const report = readReport(stateDir, today)
    return {
      stateDir,
      dataRoot: s.dataRoot,
      enabled: s.enabled,
      reportTime: s.reportTime,
      llmNarrative: s.llmNarrative,
      accounts: accounts.map((a) => ({ id: a.id, hasKey: keyed.some((k) => k.id === a.id) })),
      keyReady: keyed.length > 0,
      today,
      todayReport: report ? { date: report.date, headline: report.data.headline, must: report.data.must?.length ?? 0, generatedAt: report.data.generatedAt } : null,
      reports: listReports(stateDir, 14),
      lastRun,
      running: Boolean(running),
      nextRun: timer ? nextRunAt : null,
    }
  }

  function askModel() {
    const s = settings()
    if (!s.llmNarrative) return null
    return async ({ system, user }) => {
      const llm = ctx.get('llm')
      if (!llm) throw new Error('当前 profile 没有可用的 llm 服务')
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
      const provider = s.provider || selection.provider
      const model = s.model || selection.model
      if (!provider || !model) throw new Error('没有可用的默认模型，请先在设置里选一个模型')
      const stream = llm.stream({
        provider,
        model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        maxTokens: 2400,
        temperature: 0.2,
      })
      let out = ''
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') out += chunk.text
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          throw new Error(chunk.reason.failure?.message ?? 'model call failed')
        }
      }
      return out
    }
  }

  async function run(date = todayStamp()) {
    if (running) return running
    const s = settings()
    running = (async () => {
      const startedAt = Date.now()
      try {
        const result = await generateReport({
          stateDir,
          dataRoot: s.dataRoot,
          date,
          ask: askModel(),
          myNames: ['我', ...list(s.myNames)],
          focusKeywords: list(s.focusKeywords),
          accountIds: list(s.accounts),
        })
        lastRun = { date, at: new Date().toISOString(), ok: true, ms: Date.now() - startedAt, modelError: result.data.modelError ?? null }
        return result
      } catch (error) {
        lastRun = { date, at: new Date().toISOString(), ok: false, ms: Date.now() - startedAt, error: error.message, code: error.code }
        throw error
      } finally {
        running = null
      }
    })()
    return running
  }

  // ---- scheduling -------------------------------------------------------
  let nextRunAt = null
  function scheduleNext() {
    if (timer) clearTimeout(timer)
    timer = null
    const s = settings()
    if (!s.enabled) return
    const [hh, mm] = String(s.reportTime || '21:30').split(':').map(Number)
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return
    const now = new Date()
    const next = new Date(now)
    next.setHours(hh, mm, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    nextRunAt = next.toISOString()
    const delay = Math.min(next.getTime() - now.getTime(), 2 ** 31 - 1)
    timer = setTimeout(async () => {
      timer = null
      try {
        await run(todayStamp())
      } catch (error) {
        ctx.logger?.warn?.(`dsh-wechat-daily: scheduled report failed: ${error.message}`)
      }
      scheduleNext()
    }, Math.max(15_000, delay))
    timer.unref?.()
  }

  function reschedule() {
    scheduleNext()
  }

  ctx.effect(() => {
    scheduleNext()
    return () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }, 'dsh-wechat-daily: daily schedule')

  // Catch up once at activation when today's report is missing and its time has passed.
  ctx.effect(() => {
    const s = settings()
    if (!s.enabled) return
    const handle = setTimeout(async () => {
      try {
        const today = todayStamp()
        if (readReport(stateDir, today)) return
        const [hh, mm] = String(s.reportTime || '21:30').split(':').map(Number)
        const now = new Date()
        const due = new Date(now)
        due.setHours(hh, mm, 0, 0)
        if (now < due) return
        const store = readKeyStore(stateDir)
        const keyed = listAccounts(s.dataRoot).some((a) => store.accounts?.[a.id]?.master)
        if (!keyed) return
        await run(today)
      } catch {
        /* a failed catch-up must not break activation */
      }
    }, 20_000)
    handle.unref?.()
    return () => clearTimeout(handle)
  }, 'dsh-wechat-daily: catch-up')

  // ---- HTTP surface for the settings page --------------------------------
  const routes = [
    ['/status', (req, res) => json(res, 200, status())],
    [
      '/report',
      (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const date = url.searchParams.get('date') || todayStamp()
        const report = readReport(stateDir, date)
        if (!report) return json(res, 404, { error: 'no-report', date })
        json(res, 200, { date, markdown: report.markdown, data: report.data })
      },
    ],
    [
      '/generate',
      async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const body = req.method === 'POST' ? await readBody(req) : {}
        const date = body.date || url.searchParams.get('date') || todayStamp()
        try {
          const result = await run(date)
          json(res, 200, { ok: true, date: result.date, markdown: result.markdown, headline: result.data.headline, modelError: result.data.modelError ?? null })
        } catch (error) {
          json(res, error.code === 'NO_KEYS' ? 409 : 500, { ok: false, error: error.message, code: error.code ?? null })
        }
      },
    ],
    [
      '/config',
      async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })
        const body = await readBody(req)
        const current = readJson(configFile, {})
        const next = { ...current }
        for (const key of Object.keys(DEFAULT_CONFIG)) {
          if (key === 'stateDir') continue
          if (body[key] !== undefined) next[key] = body[key]
        }
        fs.writeFileSync(configFile, JSON.stringify(next, null, 2))
        reschedule()
        json(res, 200, { ok: true, config: settings() })
      },
    ],
  ]

  ctx.effect(() => {
    const disposers = routes.map(([suffix, handler]) =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE + suffix,
        handler: (req, res) => handler(req, res),
      }),
    )
    return () => disposers.forEach((dispose) => dispose?.())
  }, 'dsh-wechat-daily: routes')

  // ---- agent tools -------------------------------------------------------
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'wechat_daily_report',
        description:
          '读取或生成今天（或指定日期）的微信日报：从本机微信数据库汇总当天的私聊与群聊消息，区分「需要你处理」和「可以忽略」，并把日报存在 DSH 里。action=status 看是否已绑定密钥和今日是否已生成；action=generate 立即生成（默认今天）；action=latest 直接读出已有的日报正文。只读微信数据，不会发送或修改任何消息。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'generate', 'latest'], description: 'status / generate / latest' },
            date: { type: 'string', description: '日期 YYYY-MM-DD，默认今天（Asia/Shanghai）' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: value?.markdown ?? value?.summary ?? JSON.stringify(value) }],
        },
        timeoutMs: 180_000,
        isConcurrencySafe: () => false,
        presentCall: (args) => ({ card: 'generic', title: `微信日报 · ${args?.action ?? 'status'}` }),
        async execute(args) {
          const action = args?.action ?? 'status'
          const date = args?.date || todayStamp()
          try {
            if (action === 'status') {
              const s = status()
              const summary = s.keyReady
                ? `已绑定 ${s.accounts.filter((a) => a.hasKey).length} 个微信账号；今日（${s.today}）${s.todayReport ? '已生成' : '还没生成'}；每天 ${s.reportTime} 自动生成。`
                : '还没有绑定微信数据库密钥，先完成一次密钥捕获。'
              return { ...s, summary }
            }
            if (action === 'generate') {
              const result = await run(date)
              const text = result.data.modelError
                ? `${result.markdown}\n\n> 模型这一步没成功，以上由本地规则生成：${result.data.modelError}`
                : result.markdown
              return { ok: true, date: result.date, markdown: result.markdown, summary: text, modelError: result.data.modelError ?? null }
            }
            const report = readReport(stateDir, date)
            if (!report) {
              const text = `${date} 还没有日报，可以用 action=generate 生成。`
              return { ok: false, date, summary: text }
            }
            return { ok: true, date, markdown: report.markdown, summary: report.markdown }
          } catch (error) {
            const text = `生成失败：${error.message}`
            return { ok: false, error: error.message, code: error.code ?? null, summary: text }
          }
        },
      }),
    'dsh-wechat-daily: tool',
  )
}
