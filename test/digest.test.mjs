import test from 'node:test'
import assert from 'node:assert/strict'
import { rankConversations, parseModelJson, summarizeMessage, isServiceChat, buildDigest } from '../lib/digest.mjs'

const msg = (over = {}) => ({ time: 1, sender: '张三', senderWxid: 'wxid_a', isMe: false, type: 'text', text: '', ...over })

test('detects service and bot chats', () => {
  assert.equal(isServiceChat('gh_abc123', [msg()]), true)
  assert.equal(isServiceChat('2598@openim', [msg()]), true)
  assert.equal(isServiceChat('wxid_friend', [msg({ senderWxid: 'wxid_friend' }), msg({ senderWxid: 'wxid_friend' })]), false)
  const broadcast = [msg({ senderWxid: 'gh_x' }), msg({ senderWxid: 'gh_x' }), msg({ senderWxid: 'gh_y' })]
  assert.equal(isServiceChat('123@chatroom', broadcast), true)
})

test('ranks an @mention above noise and pushes service chats last', () => {
  const chats = [
    { username: 'gh_promo', display: '外卖券', isGroup: false, myMessageCount: 0,
      messages: Array.from({ length: 8 }, () => msg({ senderWxid: 'gh_promo' })) },
    { username: '999@chatroom', display: '闲聊群', isGroup: true, myMessageCount: 0,
      messages: Array.from({ length: 40 }, () => msg({ senderWxid: 'wxid_b', text: '哈哈哈' })) },
    { username: '888@chatroom', display: '课题组', isGroup: true, myMessageCount: 0,
      messages: [msg({ senderWxid: 'wxid_c', text: '小梅，明天上午十点前把材料发我' })] },
    { username: 'wxid_teacher', display: '王老师', isGroup: false, myMessageCount: 1,
      messages: [msg({ senderWxid: 'wxid_teacher', text: '开题报告什么时候能给我' })] },
  ]
  const ranked = rankConversations(chats, { myNames: ['小梅'] })
  assert.equal(ranked.at(-1).username, 'gh_promo')
  assert.ok(ranked.findIndex((c) => c.username === '888@chatroom') < ranked.findIndex((c) => c.username === '999@chatroom'))
  const group = ranked.find((c) => c.username === '888@chatroom')
  assert.ok(group.signals.some((s) => s.includes('点名找你')))
  assert.ok(ranked[0].score > ranked.at(-1).score)

  const explicit = rankConversations(
    [{ username: '777@chatroom', display: '课题组', isGroup: true, myMessageCount: 0,
       messages: [msg({ senderWxid: 'wxid_d', text: '@小梅 明天开会' })] }],
    { myNames: ['小梅'] })
  assert.ok(explicit[0].signals.some((s) => s.includes('@我')))
})

test('my own messages never count as mentions', () => {
  const chats = [{ username: 'wxid_x', display: '张三', isGroup: false, myMessageCount: 1,
    messages: [msg({ isMe: true, text: '@小梅 我自己说的' })] }]
  const [chat] = rankConversations(chats, { myNames: ['小梅'] })
  assert.equal(chat.signals.some((s) => s.includes('@我')), false)
})

test('summarises non-text messages instead of dumping XML', () => {
  const link = msg({ type: 'link', text: '<msg><appmsg><title><![CDATA[会议邀请]]></title></appmsg></msg>' })
  assert.equal(summarizeMessage(link), '[链接] 会议邀请')
  assert.equal(summarizeMessage(msg({ type: 'image', text: '<?xml version="1.0"?><msg><img/></msg>' })), '[图片]')
  assert.equal(summarizeMessage(msg({ type: 'text', text: '  你好  世界 ' })), '你好 世界')
  assert.equal(summarizeMessage(msg({ type: 'system', text: 'xxx' })), '')
})

test('parses fenced model JSON and tolerates surrounding prose', () => {
  const fenced = '说明一下：\n```json\n{"headline":"今天还好","must":[]}\n```\n以上。'
  assert.deepEqual(parseModelJson(fenced), { headline: '今天还好', must: [] })
  assert.deepEqual(parseModelJson('{"headline":"x"}'), { headline: 'x' })
  assert.equal(parseModelJson('抱歉，我不能'), null)
  assert.equal(parseModelJson(''), null)
})

test('digest stays inside the character budget and marks truncation', () => {
  const chats = Array.from({ length: 6 }, (_, i) => ({
    username: `wxid_${i}`, display: `会话${i}`, isGroup: false, myMessageCount: 0, signals: [], score: 1,
    messages: Array.from({ length: 10 }, () => msg({ text: '很长的消息内容'.repeat(20) })),
  }))
  const digest = buildDigest(chats, { maxChats: 6, perChat: 10, maxChars: 800 })
  assert.ok(digest.length <= 1200)
  assert.ok(digest.includes('已截断'))
})
