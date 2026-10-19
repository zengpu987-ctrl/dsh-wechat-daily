/**
 * Turn raw WeChat conversations into a compact digest plus a first-pass
 * importance ranking. The ranking is deliberately conservative: it decides
 * what the language model should look at closely, never what the reader must
 * do. A model pass refines it; heuristics alone still produce a usable report.
 */

const SERVICE_PATTERNS = [
  /^gh_/, /@openim$/, /^notifymessage$/, /^weixin$/, /^fmessage$/,
  /^brandsessionholder$/, /^medianote$/, /^floatbottle$/, /^qqmail$/,
  /^@?weclaw/, /^weixinreminder$/,
]

const URGENT = [
  '尽快', '马上', '急', '截止', 'ddl', '今天', '今晚', '明天', '上午', '下午', '明早',
  '确认', '回复', '回我', '麻烦', '请帮', '帮我', '需要你', '等你', '审批', '签字',
  '付款', '转账', '发票', '合同', '报价', '面试', '会议', '开会', '电话', '地址',
  '交材料', '提交', '查收', '注意', '重要', '提醒',
]

export function isServiceChat(username, messages) {
  if (SERVICE_PATTERNS.some((re) => re.test(username))) return true
  const others = messages.filter((m) => !m.isMe)
  if (!others.length) return false
  return others.filter((m) => SERVICE_PATTERNS.some((re) => re.test(m.senderWxid || ''))).length >= others.length * 0.8
}

export function mentionsMe(message, myNames) {
  if (message.isMe) return false
  const text = message.text || ''
  if (text.includes('@所有人')) return true
  if (myNames.some((n) => n && n.length > 1 && text.includes(`@${n}`))) return true
  return false
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Group chats routinely address someone by name without a formal mention
 * ("小梅，明天那份材料给我"). That still needs an answer, so it earns a smaller
 * boost than an explicit @.
 */
export function addressesMeByName(message, myNames) {
  if (message.isMe || message.type !== 'text') return false
  const text = message.text || ''
  return myNames.some((name) => {
    if (!name || name.length < 2) return false
    const pattern = new RegExp(`(^|[，,。.！!？?：:；;\\s])${escapeRegExp(name)}([，,。.！!？?：:；;\\s]|$)`)
    return pattern.test(text)
  })
}

/** Display-safe one-line description of any message. */
export function summarizeMessage(m, limit = 160) {
  let text = (m.text || '').replace(/\s+/g, ' ').trim()
  if (m.type === 'text') {
    if (text.startsWith('<msg>') || text.startsWith('<?xml')) {
      const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(text)
      text = title ? title[1].trim() : ''
      if (!text) return `[${labelOf(m.type)}]`
    }
    return text.slice(0, limit)
  }
  if (m.type === 'link') {
    const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(m.text || '')
    return `[链接]${title ? ' ' + title[1].trim().slice(0, 80) : ''}`
  }
  if (m.type === 'system' || m.type === 'revoke') return ''
  return `[${labelOf(m.type)}]`
}

function labelOf(type) {
  return { image: '图片', voice: '语音', video: '视频', sticker: '表情', card: '名片',
    location: '位置', link: '链接/文件', call: '通话', system: '系统消息', revoke: '撤回消息' }[type] ?? '消息'
}

/**
 * Score conversations so the most likely-to-matter ones reach the model first.
 * Returns a new array sorted by descending interest, each with `signals`.
 */
export function rankConversations(conversations, { myNames = [], focusKeywords = [] } = {}) {
  const ranked = conversations.map((chat) => {
    const signals = []
    let score = 0
    const service = isServiceChat(chat.username, chat.messages)
    if (service) { score -= 60; signals.push('服务号/机器人') }
    const mentions = chat.messages.filter((m) => mentionsMe(m, myNames)).length
    if (mentions) { score += 60 + mentions * 5; signals.push(`@我 ${mentions} 次`) }
    else {
      const named = chat.messages.filter((m) => addressesMeByName(m, myNames)).length
      if (named) { score += 25 + named * 3; signals.push(`点名找你 ${named} 次`) }
    }
    const mine = chat.myMessageCount
    if (!chat.isGroup && !service) { score += 35; signals.push('私聊') }
    if (mine) { score += 10; signals.push(`我参与 ${mine} 条`) }
    const urgentHits = []
    for (const m of chat.messages) {
      if (m.isMe || m.type !== 'text') continue
      const text = m.text || ''
      for (const kw of URGENT) if (text.includes(kw) && !urgentHits.includes(kw)) urgentHits.push(kw)
      for (const kw of focusKeywords) if (kw && text.includes(kw) && !urgentHits.includes(kw)) urgentHits.push(kw)
    }
    if (urgentHits.length) {
      score += Math.min(40, urgentHits.length * 8)
      signals.push('提到 ' + urgentHits.slice(0, 5).join('/'))
    }
    const questions = chat.messages.filter((m) => !m.isMe && /[?？]/.test(m.text || '')).length
    if (questions) { score += Math.min(15, questions * 3); signals.push(`提问 ${questions} 条`) }
    if (chat.isGroup && chat.messageCount >= 30 && !mentions) { score -= 25; signals.push('群刷屏无人找你') }
    if (chat.isGroup && !mine && !mentions) score -= 8
    return { ...chat, score, signals, service }
  })
  return ranked.sort((a, b) => b.score - a.score || b.messageCount - a.messageCount)
}

/** Compact, token-bounded text the model reads. */
export function buildDigest(ranked, { maxChats = 14, perChat = 12, maxChars = 14000 } = {}) {
  const lines = []
  let used = 0
  for (const chat of ranked.slice(0, maxChats)) {
    const head = `\n## ${chat.isGroup ? '群' : '单聊'}「${chat.display}」 共${chat.messageCount}条 我发言${chat.myMessageCount}条${chat.signals.length ? ' · ' + chat.signals.join('；') : ''}`
    lines.push(head)
    used += head.length
    for (const m of chat.messages.slice(-perChat)) {
      const desc = summarizeMessage(m, 220)
      if (!desc) continue
      const line = `${m.isMe ? '我' : m.sender}：${desc}`
      if (used + line.length > maxChars) { lines.push('…（已截断）'); return lines.join('\n') }
      lines.push(line)
      used += line.length
    }
  }
  return lines.join('\n')
}

export const REPORT_PROMPT = `你是用户的微信日报助理。下面是你今天收到的微信消息摘要。
请严格按下面的 JSON 结构输出，不要输出任何其它文字：

{
  "headline": "一句话概括今天微信里最重要的事（不超过40字）",
  "must": [{"chat":"会话名","who":"谁","what":"他要什么/发生了什么（不超过50字）","why":"为什么重要（不超过40字）","action":"用户需要做什么（不超过40字，没有就写空字符串）"}],
  "watch": [{"chat":"会话名","what":"一句话说明"}],
  "noise": [{"chat":"会话名","count":数字,"why":"为什么可以忽略（不超过30字）"}],
  "insights": ["最多3条观察，例如谁在等你回复、有什么截止时间、哪个群值得退"]
}

判断标准：
- must：需要用户采取行动、有截止时间、涉及钱/合同/工作安排、明确在等用户回复、或重要的私人消息。最多 6 条，宁缺毋滥。
- watch：不需要立刻行动但值得了解的事，最多 5 条。
- noise：推广、外卖券、刷屏群、公众号推送、表情包斗图等，按会话聚合，最多 5 条。
- 每条 must 的 action 要具体可执行；如果只是通知没有动作，action 留空。
- 不要编造摘要里没有的内容。`

export function parseModelJson(text) {
  if (!text) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}
