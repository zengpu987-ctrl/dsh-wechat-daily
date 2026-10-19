/**
 * dsh-wechat-daily — client half.
 *
 * One Settings page ("微信日报") that shows the state of the local binding, a
 * few controls, and today's report. Data comes from the plugin's own JSON
 * routes; the page never touches WeChat directly.
 */
window.__ModuleLoader__.load({
  id: 'dsh-wechat-daily',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var NS = 'dsh-wechat-daily'
    var BASE = '/plugins/dsh-wechat-daily'
    var h = React.createElement

    var ZH = {
      title: '微信日报',
      subtitle: '每天结束前，把微信里发生的事整理成一份日报：需要你处理的、值得一看的、可以忽略的。',
      keyReady: '已绑定微信数据库',
      keyMissing: '尚未绑定微信数据库',
      accounts: '账号',
      today: '今天',
      generatedAt: '生成于',
      notYet: '今日还未生成',
      generate: '立即生成日报',
      generating: '正在生成…',
      running: '有任务在跑',
      nextRun: '下次自动生成',
      disabled: '自动生成已关闭',
      settings: '设置',
      enabled: '每天自动生成',
      time: '生成时间',
      llm: '让模型写摘要',
      llmHint: '开启后消息摘要会发送给当前选择的模型用于分类和总结；关闭则只用本地规则。',
      myNames: '我的昵称（用于识别 @我）',
      focus: '特别关注关键词',
      save: '保存设置',
      saved: '已保存',
      refresh: '刷新',
      empty: '今天还没有日报。',
      noKeys: '还没有绑定微信数据库密钥。需要先完成一次密钥捕获（一次性），插件之后每天只读数据库。',
      loadError: '读取失败：',
      modelWarning: '模型这一步没成功，日报由本地规则生成：',
    }
    var EN = {
      title: 'WeChat daily report',
      subtitle: 'A daily digest of what happened on WeChat: what needs you, what is worth a look, what to ignore.',
      keyReady: 'Database key bound',
      keyMissing: 'No database key yet',
      accounts: 'Accounts',
      today: 'Today',
      generatedAt: 'Generated',
      notYet: 'Not generated yet',
      generate: 'Generate now',
      generating: 'Generating…',
      running: 'A run is in progress',
      nextRun: 'Next automatic run',
      disabled: 'Automatic generation off',
      settings: 'Settings',
      enabled: 'Generate every day',
      time: 'Report time',
      llm: 'Let the model write the summary',
      llmHint: 'When enabled, message digests go to the selected model for ranking and summarising; otherwise local rules only.',
      myNames: 'My nicknames (to detect @mentions)',
      focus: 'Keywords to watch',
      save: 'Save',
      saved: 'Saved',
      refresh: 'Refresh',
      empty: 'No report for today yet.',
      noKeys: 'No WeChat database key yet. Run the one-time key capture; after that the plugin only reads the databases.',
      loadError: 'Failed to load: ',
      modelWarning: 'The model step did not finish; this report came from local rules: ',
    }

    var css = [
      '.dswd-root{display:flex;flex-direction:column;gap:18px;font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary);padding:4px 0 24px}',
      '.dswd-head{display:flex;flex-direction:column;gap:6px}',
      '.dswd-title{font-size:17px;font-weight:600;line-height:24px}',
      '.dswd-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);max-width:720px}',
      '.dswd-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dswd-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;font-size:12px;line-height:18px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dswd-chip[data-ok="1"]{color:var(--dsw-alias-state-business-primary)}',
      '.dswd-chip[data-warn="1"]{color:var(--dsw-alias-state-warning-primary)}',
      '.dswd-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;line-height:18px;cursor:pointer}',
      '.dswd-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dswd-btn[data-primary="1"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.dswd-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.dswd-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px 18px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px}',
      '.dswd-card h3{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dswd-report{font-size:13px;line-height:22px}',
      '.dswd-report h1{font-size:16px;font-weight:600;margin:0 0 8px}',
      '.dswd-report h2{font-size:14px;font-weight:600;margin:18px 0 6px}',
      '.dswd-report h3{font-size:13px;font-weight:600;margin:12px 0 4px}',
      '.dswd-report blockquote{margin:0 0 10px;padding:6px 10px;border-left:3px solid var(--dswd-alias-border-l2, var(--dsw-alias-border-l1));color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:6px}',
      '.dswd-report ul{margin:4px 0 8px;padding-left:20px}',
      '.dswd-report li{margin:2px 0}',
      '.dswd-report p{margin:6px 0}',
      '.dswd-empty{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.dswd-field{display:flex;align-items:center;gap:12px;padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dswd-field:first-of-type{border-top:none}',
      '.dswd-field-label{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dswd-field-name{font-size:13px}',
      '.dswd-field-hint{font-size:11px;line-height:16px;color:var(--dswd-alias-label-tertiary, var(--dsw-alias-label-tertiary))}',
      '.dswd-input{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 9px;font:inherit;font-size:13px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none}',
      '.dswd-input:focus{border-color:var(--dsw-alias-brand-primary)}',
    ]
    var styleEl = null
    function ensureStyles() {
      if (styleEl) return
      styleEl = document.createElement('style')
      styleEl.setAttribute('data-dsh-wechat-daily', '')
      styleEl.textContent = css.join('\n')
      document.head.appendChild(styleEl)
    }

    // --- tiny markdown renderer (headings, quotes, lists, bold) -----------
    function inline(text, key) {
      var parts = String(text).split(/(\*\*[^*]+\*\*)/g)
      return parts.map((part, i) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) return h('strong', { key: key + '-' + i }, part.slice(2, -2))
        return part
      })
    }

    function renderMarkdown(md) {
      var out = []
      var list = null
      var ordered = false
      var skip = false
      var lines = String(md).split('\n')
      var flush = () => {
        if (list && list.length) {
          out.push(h(ordered ? 'ol' : 'ul', { key: 'l' + out.length }, list))
          list = null
        }
      }
      lines.forEach((raw, i) => {
        var line = raw.replace(/\s+$/, '')
        if (/^<details/.test(line)) { skip = true; return }
        if (/^<\/details>/.test(line)) { skip = false; return }
        if (skip) return
        if (!line.trim()) { flush(); return }
        var m
        if ((m = /^#\s+(.*)$/.exec(line))) { flush(); out.push(h('h1', { key: i }, inline(m[1], 'h1' + i))); return }
        if ((m = /^##\s+(.*)$/.exec(line))) { flush(); out.push(h('h2', { key: i }, inline(m[1], 'h2' + i))); return }
        if ((m = /^###\s+(.*)$/.exec(line))) { flush(); out.push(h('h3', { key: i }, inline(m[1], 'h3' + i))); return }
        if ((m = /^>\s?(.*)$/.exec(line))) { flush(); out.push(h('blockquote', { key: i }, inline(m[1], 'q' + i))); return }
        if ((m = /^[-*]\s+(.*)$/.exec(line))) {
          if (!list || ordered) { flush(); list = []; ordered = false }
          list.push(h('li', { key: i }, inline(m[1], 'li' + i)))
          return
        }
        if ((m = /^\d+\.\s+(.*)$/.exec(line))) {
          if (!list || !ordered) { flush(); list = []; ordered = true }
          list.push(h('li', { key: i }, inline(m[1], 'li' + i)))
          return
        }
        if (/^ {2,}[-*]\s+/.test(line) || /^\s+-\s+/.test(line)) {
          if (!list) { list = []; ordered = false }
          list.push(h('li', { key: i }, inline(line.trim().replace(/^[-*]\s+/, ''), 'li' + i)))
          return
        }
        flush()
        out.push(h('p', { key: i }, inline(line, 'p' + i)))
      })
      flush()
      return out
    }

    function fmtTime(iso) {
      if (!iso) return ''
      try {
        return new Date(iso).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return iso
      }
    }

    function Page() {
      var t = (key) => ZH[key] ?? key
      var state = React.useState({ loading: true, status: null, report: null, error: null, busy: false, saved: false })
      var s = state[0]
      var set = state[1]
      var draft = React.useState(null)
      var d = draft[0]
      var setDraft = draft[1]

      var load = React.useCallback(() => {
        set((prev) => ({ ...prev, loading: true, error: null }))
        Promise.all([
          fetch(BASE + '/status').then((r) => r.json()),
          fetch(BASE + '/report').then(async (r) => (r.ok ? r.json() : null)).catch(() => null),
        ])
          .then(([status, report]) => {
            set({ loading: false, status, report, error: null, busy: false, saved: false })
            setDraft({
              enabled: status.enabled,
              reportTime: status.reportTime,
              llmNarrative: status.llmNarrative,
              myNames: '',
              focusKeywords: '',
            })
          })
          .catch((error) => set({ loading: false, status: null, report: null, error: error.message, busy: false, saved: false }))
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      function generate() {
        set((prev) => ({ ...prev, busy: true }))
        fetch(BASE + '/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
          .then((r) => r.json())
          .then(() => load())
          .catch((error) => set((prev) => ({ ...prev, busy: false, error: error.message })))
      }

      function save() {
        fetch(BASE + '/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enabled: d.enabled,
            reportTime: d.reportTime,
            llmNarrative: d.llmNarrative,
            myNames: d.myNames,
            focusKeywords: d.focusKeywords,
          }),
        })
          .then((r) => r.json())
          .then(() => { set((prev) => ({ ...prev, saved: true })); load() })
          .catch((error) => set((prev) => ({ ...prev, error: error.message })))
      }

      if (s.loading && !s.status) return h('div', { className: 'dswd-root' }, h('div', { className: 'dswd-empty' }, '…'))
      if (s.error) return h('div', { className: 'dswd-root' }, h('div', { className: 'dswd-empty' }, t('loadError') + s.error, h('button', { className: 'dswd-btn', onClick: load }, t('refresh'))))

      var st = s.status || {}
      var report = s.report
      var keyCount = (st.accounts || []).filter((a) => a.hasKey).length

      return h(
        'div',
        { className: 'dswd-root' },
        h(
          'div',
          { className: 'dswd-head' },
          h('div', { className: 'dswd-title' }, t('title')),
          h('div', { className: 'dswd-sub' }, t('subtitle')),
        ),
        h(
          'div',
          { className: 'dswd-row' },
          h('span', { className: 'dswd-chip', 'data-ok': st.keyReady ? '1' : '0', 'data-warn': st.keyReady ? '0' : '1' }, (st.keyReady ? t('keyReady') : t('keyMissing')) + (st.keyReady ? ` · ${keyCount}` : '')),
          h('span', { className: 'dswd-chip' }, t('today') + ' · ' + (st.today || '')),
          h('span', { className: 'dswd-chip' }, st.enabled === false ? t('disabled') : `${t('nextRun')} · ${fmtTime(st.nextRun)}`),
          h('button', { className: 'dswd-btn', 'data-primary': '1', disabled: s.busy, onClick: generate }, s.busy ? t('generating') : t('generate')),
          h('button', { className: 'dswd-btn', onClick: load }, t('refresh')),
        ),
        !st.keyReady
          ? h('div', { className: 'dswd-card' }, h('div', { className: 'dswd-empty' }, t('noKeys')))
          : null,
        h(
          'div',
          { className: 'dswd-card' },
          h('h3', {}, report ? `${report.date} · ${report.data.must && report.data.must.length ? report.data.must.length + ' 件事要处理' : (report.data.headline || t('notYet'))}` : t('notYet')),
          report && report.data.modelWarning ? null : null,
          report && report.data.modelError
            ? h('div', { className: 'dswd-empty' }, t('modelWarning') + report.data.modelError)
            : null,
          report
            ? h('div', { className: 'dswd-report' }, renderMarkdown(report.markdown))
            : h('div', { className: 'dswd-empty' }, t('empty')),
        ),
        d
          ? h(
              'div',
              { className: 'dswd-card' },
              h('h3', {}, t('settings')),
              h(
                'div',
                { className: 'dswd-field' },
                h('div', { className: 'dswd-field-label' }, h('span', { className: 'dswd-field-name' }, t('enabled'))),
                h('input', { type: 'checkbox', checked: Boolean(d.enabled), onChange: (e) => setDraft({ ...d, enabled: e.target.checked }) }),
              ),
              h(
                'div',
                { className: 'dswd-field' },
                h('div', { className: 'dswd-field-label' }, h('span', { className: 'dswd-field-name' }, t('time'))),
                h('input', { className: 'dswd-input', type: 'time', value: d.reportTime || '21:30', onChange: (e) => setDraft({ ...d, reportTime: e.target.value }) }),
              ),
              h(
                'div',
                { className: 'dswd-field' },
                h('div', { className: 'dswd-field-label' }, h('span', { className: 'dswd-field-name' }, t('llm')), h('span', { className: 'dswd-field-hint' }, t('llmHint'))),
                h('input', { type: 'checkbox', checked: Boolean(d.llmNarrative), onChange: (e) => setDraft({ ...d, llmNarrative: e.target.checked }) }),
              ),
              h(
                'div',
                { className: 'dswd-field' },
                h('div', { className: 'dswd-field-label' }, h('span', { className: 'dswd-field-name' }, t('myNames'))),
                h('input', { className: 'dswd-input', type: 'text', placeholder: '昵称1, 昵称2', value: d.myNames, onChange: (e) => setDraft({ ...d, myNames: e.target.value }) }),
              ),
              h(
                'div',
                { className: 'dswd-field' },
                h('div', { className: 'dswd-field-label' }, h('span', { className: 'dswd-field-name' }, t('focus'))),
                h('input', { className: 'dswd-input', type: 'text', placeholder: '报价, 合同, 面试', value: d.focusKeywords, onChange: (e) => setDraft({ ...d, focusKeywords: e.target.value }) }),
              ),
              h(
                'div',
                { className: 'dswd-row' },
                h('button', { className: 'dswd-btn', 'data-primary': '1', onClick: save }, s.saved ? t('saved') : t('save')),
                h('span', { className: 'dswd-field-hint' }, 'state: ' + (st.stateDir || '')),
              ),
            )
          : null,
      )
    }

    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          return ctx.locale.register(NS, { zh: ZH, en: EN })
        }
        return () => {}
      }, 'dsh-wechat-daily: locale')
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'wechat-daily',
            order: 88,
            label: () => '微信日报',
            locale: NS,
          },
          Page,
        ),
      )
    }

    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
