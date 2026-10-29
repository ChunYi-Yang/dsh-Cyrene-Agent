window.__ModuleLoader__.load({
  id: '@cyrene/ruwo-suoxie',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const { Menu, MenuItemButton } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    let switchToCyrene;
    async function send(action, id, signal) {
      const response = await fetch('/api/ruwo-suoxie/control', { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-cyrene-control': '1' }, body: JSON.stringify({ action, id }) });
      const value = await response.json();
      if (!response.ok || value.error) throw new Error('无法连接如我所书，请打开应用后重试。');
      return value;
    }
    let preparationChanged = () => {};
    async function prepare(signal) {
      let state = await send('prepare', undefined, signal);
      while (state.phase !== 'ready') {
        preparationChanged(state);
        if (state.phase === 'error') throw new Error(state.error || '程序准备失败，请重试。');
        if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
        await new Promise(resolve => setTimeout(resolve, 750));
        state = await send('preparation', undefined, signal);
      }
      preparationChanged(state);
    }
    async function native(method, params, signal) {
      const response = await fetch('/api/ruwo-suoxie/session', { method: 'POST', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', 'x-cyrene-control': '1' }, body: JSON.stringify({ method, params }) });
      if (!response.ok) throw new Error('会话连接暂时不可用');
      if (method !== 'follow') return (await response.json()).result;
      const reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = '';
      try {
        while (true) {
          const value = await reader.read();
          buffer += decoder.decode(value.value, { stream: !value.done });
          if (buffer.length > 32 * 1024 * 1024) throw new Error('历史记录超出读取上限');
          const newline = buffer.indexOf('\n');
          if (newline >= 0) {
            const snapshot = JSON.parse(buffer.slice(0, newline));
            if (snapshot.type !== 'snapshot') throw new Error('缺少会话快照');
            return snapshot;
          }
          if (value.done) throw new Error('会话连接中断');
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    function NativeConversation({ sessionId, legacyMessages = [] }) {
      const [history, setHistory] = React.useState();
      const [draft, setDraft] = React.useState('');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [unknown, setUnknown] = React.useState(false);
      const pending = React.useRef();
      const sending = React.useRef(false);
      const alive = React.useRef(true);
      React.useEffect(() => {
        alive.current = true;
        const controller = new AbortController(); let timer;
        async function refresh() {
          try {
            const value = await native('follow', { address: { kind: 'session', sessionId }, maxMessages: 100 }, controller.signal);
            const state = await native('continuationStatus', { sessionId }, controller.signal);
            if (!controller.signal.aborted) {
              setUnknown(state.unknown || Boolean(pending.current));
              setHistory(previous => {
                const records = new Map([...(previous?.records ?? []), ...value.records].map(record => [record.event.seq, record]));
                return { ...value, hasMore: previous?.hasMore ?? value.hasMore, records: [...records.values()].sort((a,b) => a.event.seq-b.event.seq) };
              });
            }
          } catch { if (!controller.signal.aborted) setError('连接暂时中断，已有消息已保留，正在重试。'); }
          if (!controller.signal.aborted) timer = setTimeout(refresh, 2000);
        }
        void refresh();
        return () => { alive.current = false; controller.abort(); clearTimeout(timer); };
      }, [sessionId]);
      async function submit(retry = false) {
        if (sending.current || (!retry && !draft.trim())) return;
        sending.current = true; setBusy(true); setError('');
        if (!retry && !pending.current) pending.current = { requestId: `dsh-cyrene:${crypto.randomUUID()}`, text: draft };
        const submittedText = pending.current?.text;
        try {
          const resend = Boolean(pending.current);
          const result = await native(retry && !resend ? 'retryContinuation' : 'continue', { sessionId, ...(resend ? pending.current : {}) });
          if (!result.accepted) throw new Error('发送未确认');
          pending.current = undefined;
          if (alive.current) { setDraft(current => submittedText !== undefined && current === submittedText ? '' : current); setUnknown(false); }
        } catch { if (alive.current) { setUnknown(true); setError('发送结果尚未确认，请确认并重试；同一条消息不会重复提交。'); } }
        finally { sending.current = false; if (alive.current) setBusy(false); }
      }
      async function older() {
        if (!history || busy) return;
        setBusy(true);
        try {
          const value = await native('page', { address: { kind: 'session', sessionId }, beforeSeq: history.records[0]?.event.seq, throughSeq: history.cursor, maxMessages: 100 });
          if (alive.current) setHistory(previous => {
            const records = new Map([...value.records, ...previous.records].map(record => [record.event.seq, record]));
            return { ...previous, hasMore: value.hasMore, records: [...records.values()].sort((a,b) => a.event.seq-b.event.seq) };
          });
        } catch { if (alive.current) setError('更早记录读取失败，请重试。'); }
        finally { if (alive.current) setBusy(false); }
      }
      const start = history?.records.filter(row => row.event.type === 'turn/start').at(-1)?.event;
      const end = history?.records.filter(row => row.event.type === 'turn/end').at(-1)?.event;
      const running = start && (!end || start.seq > end.seq);
      const failed = !running && end?.data.reason?.kind === 'error';
      const runtimeError = failed ? end.data.reason.error?.code === 'AUTH' ? '当前模型路由认证失效，请在 DSH 恢复登录或授权。' : '本轮回复未完成，请在原生 DSH 会话查看原因；记录已保留。' : '';
      return h('section', { 'aria-label': '共享会话', style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h('div', { style: { flex: 1, overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
          history?.hasMore && h('button', { disabled: busy, onClick: older }, '加载更早记录'),
          legacyMessages.map(message => h('article', { key: message.id, style: { alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%', margin: '12px 0', padding: '14px 18px', borderRadius: 16, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: message.role === 'user' ? '#ff5595' : 'var(--background-secondary, #8881)', color: message.role === 'user' ? '#fff' : 'inherit' } }, message.content)),
          (history?.records ?? []).filter(({event}) => ['user/message', 'assistant/message'].includes(event.type)
            && (event.type !== 'user/message' || !event.data.source?.kind || event.data.source.kind === 'user')).map(({event}) => {
              const content = event.data.message?.content ?? event.data.content;
              const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.type === 'text' ? part.text : '[非文本内容，见完整记录]').join('\n') : '[非文本内容，见完整记录]';
              return h('article', { key: event.seq, style: { alignSelf: event.type === 'user/message' ? 'flex-end' : 'flex-start', maxWidth: '88%', margin: '12px 0', padding: '14px 18px', borderRadius: 16,
                whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: event.type === 'user/message' ? '#ff5595' : 'var(--background-secondary, #8881)', color: event.type === 'user/message' ? '#fff' : 'inherit' } }, text);
            }),
          h('details', { style: { margin: '16px 0' } }, h('summary', null, '附件与活动 · 完整历史'),
            (history?.records ?? []).map(({event}) => h('details', { key: event.seq }, h('summary', null, `${event.type} · ${event.seq}`),
              h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(event, null, 2)))))),
        h('form', { 'aria-label': '继续 Cyrene 对话', onSubmit: event => { event.preventDefault(); void submit(); }, style: { padding: 16, borderTop: '1px solid #8883' } },
          error && h('p', { role: 'alert' }, error),
          runtimeError && h('p', { role: 'alert' }, runtimeError),
          running && h('p', { role: 'status' }, 'DSH 正在处理，回复会自动显示；审批请在原生会话处理。'),
          unknown ? h('button', { type: 'button', disabled: busy, onClick: () => submit(true) }, '确认并重试') : h(React.Fragment, null,
            h('textarea', { 'aria-label': '消息', value: draft, rows: 3, maxLength: 32768, disabled: busy,
              placeholder: '继续当前对话…', onChange: event => setDraft(event.target.value),
              onKeyDown: event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } },
              style: { width: '100%', borderRadius: 12, padding: 12, resize: 'vertical', background: 'var(--background-secondary, #8881)', color: 'inherit' } }),
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 } },
              h('span', { style: { fontSize: 12, opacity: .65 } }, '同一会话 · 沿用 DSH 当前模型与权限'),
              h('button', { type: 'submit', disabled: busy || !draft.trim() }, busy ? '发送中…' : '发送')))));
    }
    function HistoryPanel() {
      const [resolved, setResolved] = React.useState();
      const [linking, setLinking] = React.useState(false);
      const [items, setItems] = React.useState([]);
      const [selected, setSelected] = React.useState('');
      const selectedRef = React.useRef(selected); selectedRef.current = selected;
      const [conversation, setConversation] = React.useState();
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(false);
      React.useEffect(() => {
        const controller = new AbortController();
        let timer;
        const refresh = async () => {
          try {
            const listed = await send('conversations', undefined, controller.signal);
            if (!controller.signal.aborted) setItems(listed.items ?? []);
            if (selected) {
              const value = await send('history', selected, controller.signal);
              if (!controller.signal.aborted) setConversation(value);
            }
            if (!controller.signal.aborted) setError('');
          } catch (e) { if (!controller.signal.aborted) setError(e.message); }
          finally { if (!controller.signal.aborted) setLoading(false); }
          if (!controller.signal.aborted) timer = setTimeout(refresh, 2000);
        };
        setConversation(undefined); setResolved(undefined); setLoading(Boolean(selected));
        void refresh();
        return () => { controller.abort(); clearTimeout(timer); };
      }, [selected]);
      const groups = new Map();
      for (const item of items) {
        const folder = item.workspaceRoot?.replace(/[\\/]+$/, '').replace(/\\/g, '/') || '';
        const key = [...groups.keys()].find(value => value.toLocaleLowerCase() === folder.toLocaleLowerCase()) ?? folder;
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
      const row = { border: 0, borderRadius: 8, padding: '9px 12px', textAlign: 'left', color: 'inherit', cursor: 'pointer', width: '100%', background: 'transparent' };
      return h('section', { 'aria-label': '觐见浮黎', style: { display: 'flex', height: '100%', minHeight: 0, width: '100%' } },
        h('nav', { 'aria-label': 'Cyrene 会话', style: { width: 260, minWidth: 190, overflow: 'auto', borderRight: '1px solid #8883', padding: 16 } },
          h('h2', { style: { fontSize: 18, marginBottom: 16 } }, '觐见浮黎'),
          [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([folder, sessions]) => h('details', { key: folder, open: true },
            h('summary', { title: folder, style: { cursor: 'pointer', padding: '10px 0', overflowWrap: 'anywhere' } }, '📁 ', folder.split('/').at(-1) || '未归属工作区'),
            sessions.map(item => h('button', { type: 'button', key: item.id, title: item.title,
              'aria-current': selected === item.id ? 'page' : undefined,
              style: { ...row, background: selected === item.id ? '#ff559522' : 'transparent', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              onClick: () => setSelected(item.id) }, item.title || '未命名会话')))),
          !items.length && !error && h('p', null, '暂无会话')),
        h('main', { 'aria-label': 'Cyrene 对话内容', style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, padding: 24, overflow: 'auto' } },
          h('h2', { style: { fontSize: 18 } }, conversation?.title || '如我所书'),
          error && h('p', { role: 'alert' }, error),
          loading && h('p', { role: 'status' }, '正在读取会话…'),
          !selected && h('p', { style: { margin: 'auto', opacity: .65 } }, '从左侧选择一段回忆'),
          !(resolved || conversation?.nativeSessionId) && (conversation?.messages ?? []).map((message, index) => h('article', { key: message.id || index,
            style: { alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%', margin: '16px 0', padding: '14px 18px', borderRadius: 16,
              background: message.role === 'user' ? '#ff5595' : 'var(--background-secondary, #8881)', color: message.role === 'user' ? '#fff' : 'inherit' } },
            h('strong', { style: { fontSize: 12, opacity: .7 } }, message.role === 'user' ? '你' : message.role === 'assistant' ? 'Cyrene' : '会话活动'),
            h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 8 } }, typeof message.content === 'string' ? message.content : '[非文本内容，见完整记录]'),
            h('details', { style: { fontSize: 12, marginTop: 8 } }, h('summary', null, '完整消息、工具与附件引用'),
              h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(message, null, 2))))),
          conversation?.legacyArchive && h('details', null, h('summary', null, '接入前的 Cyrene 原始记录'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(conversation.messages, null, 2))),
          (resolved || conversation?.nativeSessionId) ? h(NativeConversation, { key: resolved || conversation.nativeSessionId, sessionId: resolved || conversation.nativeSessionId, legacyMessages: conversation.legacyMessages ?? [] }) :
            selected && conversation && h('button', { disabled: linking, style: { marginTop: 'auto', padding: 12 }, onClick: async () => {
              const id = selected; setLinking(true); setError('');
              try { const value = await send('resolve', id); if (selectedRef.current === id) setResolved(value.sessionId); }
              catch { setError('旧会话接入失败，原记录保留。请检查 DSH 连接后重试。'); }
              finally { setLinking(false); }
            } }, linking ? '正在接入…' : '接入 DSH 并继续此对话')));
    }
    return { inject: ['slots', 'layout'], apply(ctx) {
      const settingsTarget = new URLSearchParams(window.location.search).get('cyrene-plugin-settings');
      if (settingsTarget) {
        ctx.effect(() => {
          const abort = new AbortController();
          let done = false, targets = new Set(), bundle, failed = false, visibleSince = 0;
          const startedAt = Date.now();
          const status = document.createElement('div');
          status.setAttribute('role', 'status');
          status.style.cssText = 'position:fixed;top:12px;left:20%;right:20%;z-index:2147483647;padding:16px;border-radius:12px;background:#fff;color:#222;box-shadow:0 2px 20px #0003';
          status.textContent = '正在匹配 DSH 插件原生设置…'; document.body.append(status);
          const normalize = value => String(value ?? '').replace(/^(?:include:|profile:)/, '').replace(/^dsh-/, '').replace(/(?:-client|\/client)$/, '');
          const owned = entry => targets.has(normalize(entry.registrant)) || targets.has(normalize(entry.options.id));
          const probe = () => {
            if (done || failed || abort.signal.aborted || !targets.size) return;
            const section = ctx.slots.entries('settings.section').find(owned);
            const general = ctx.slots.entries('settings.general.item').find(owned);
            const shell = ctx.slots.entries('sidebar.settings').find(entry => entry.store?.create);
            if ((section || general) && shell) {
              const instance = shell.store.create(), actions = instance.actions;
              if (typeof actions.openSection !== 'function') return;
              const sectionId = section?.options.id ?? 'general';
              if (document.querySelector('[data-shortcut-modal="settings"]') && instance.getSnapshot?.().activeId === sectionId) {
                visibleSince ||= Date.now();
                // Startup onboarding can appear after the first settings render.
                done = Date.now() - visibleSince >= 1500 && Date.now() - startedAt >= 5000;
                status.remove(); return;
              }
              visibleSince = 0;
              // Onboarding and reconnects may close an early-opened shell; wait for the original modal lifecycle.
              if (!document.querySelector('[aria-modal="true"]')) actions.openSection(sectionId);
              return;
            }
            const ownPage = ctx.slots.entries('plugins.bundle.config').some(entry => entry.options.key === bundle?.name)
              || ctx.slots.entries('plugins.row.config').some(entry => entry.options.key?.startsWith(`${bundle?.name}#`));
            const navigation = ctx.get('pluginNavigation');
            if (navigation && bundle && (ownPage || Date.now() - startedAt >= 8000)) {
              // The native bundle page also supplies DSH's generated row forms when no custom slot exists.
              navigation.openBundle(bundle.name); done = true; status.remove();
            }
          };
          void native('plugins', { action: 'list' }, abort.signal).then(data => {
            bundle = data.bundles.find(item => item.name === settingsTarget);
            const plugin = data.plugins.find(item => item.name === settingsTarget || item.id === settingsTarget);
            if (!bundle && !plugin) throw Error('missing plugin');
            if (bundle?.enabled === false || (!bundle && plugin?.enabled === false)) {
              failed = true; status.textContent = '此插件当前已停用，原生设置界面尚未加载。请先在 Cyrene 或 DSH 中启用插件。'; return;
            }
            targets = new Set([settingsTarget, plugin?.id, plugin?.name, ...(bundle?.configurationTargets ?? [])].filter(Boolean).map(normalize));
            probe();
          }).catch(() => { if (!abort.signal.aborted) { failed = true; status.textContent = '原生设置连接失败，请关闭此窗口并重试。'; } });
          const timer = setInterval(probe, 300);
          const timeout = setTimeout(() => {
            if (done || abort.signal.aborted) return;
            failed = true;
            status.textContent = 'DSH 当前未为此插件注册原生设置页面。可在 DSH 设置侧栏核对，或在 Cyrene 使用标准配置表单。';
          }, 15000);
          return () => { abort.abort(); clearInterval(timer); clearTimeout(timeout); status.remove(); };
        }, 'ruwo-suoxie: native settings navigation');
        return;
      }
      let pendingSwitch;
      switchToCyrene = () => {
        if (pendingSwitch) return pendingSwitch;
        const signal = ctx.layout.beginNavigation();
        pendingSwitch = (async () => {
          await prepare(signal);
          const result = await send(window.dshDesktop?.keyboard ? 'switch' : 'open', undefined, signal);
          if (!result.running) throw new Error('Cyrene 尚未准备好');
        })().finally(() => { pendingSwitch = undefined; });
        return pendingSwitch;
      };
      function Launcher({ active, size }) {
        const icon = React.useRef(null);
        const initialPanel = ctx.layout.panelInfo.getSnapshot().activePanelId;
        const previousPanel = React.useRef(initialPanel === "ruwo-suoxie" ? null : initialPanel);
        const [anchor, setAnchor] = React.useState(null);
        const [preparation, setPreparation] = React.useState({ phase: 'idle' });
        React.useEffect(() => { preparationChanged = setPreparation; return () => { preparationChanged = () => {}; }; }, []);
        const preparingText = preparation.phase === 'downloading' ? `正在下载 Cyrene ${Math.floor(100 * preparation.received / (preparation.total || 1))}%`
          : preparation.phase === 'extracting' ? '正在解压 Cyrene…' : '正在准备并启动 Cyrene…';
        const [error, setError] = React.useState('');
        const [busy, setBusy] = React.useState(false);
        React.useEffect(() => ctx.layout.panelInfo.subscribe(() => {
          const id = ctx.layout.panelInfo.getSnapshot().activePanelId;
          if (id !== 'ruwo-suoxie') previousPanel.current = id;
        }), []);
        React.useLayoutEffect(() => {
          if (!active) return;
          const rect = icon.current?.getBoundingClientRect();
          if (rect) setAnchor({ left: rect.left, top: rect.bottom + 12 });
          ctx.layout.selectPanel(previousPanel.current);
        }, [active]);
        return h(React.Fragment, null,
          h('img', { ref: icon, src: 'data:image/png;base64,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', alt: '', width: size || 20, height: size || 20 }),
          anchor && createPortal(h(Menu, { open: true, portal: true, autoFocus: true, onClose: () => setAnchor(null),
            getAnchorRect: () => icon.current?.closest('button')?.getBoundingClientRect() ?? null,
            anchor: null },
            h(MenuItemButton, { disabled: busy, onSelect: () => { setBusy(true); setError(''); void switchToCyrene().then(() => setAnchor(null)).catch(error => setError(preparation.phase === 'error' ? preparation.error : error.message === 'Failed to fetch' ? '网络连接中断，请重试。' : error.message || '打开失败，请重试。')).finally(() => setBusy(false)); } }, busy ? preparingText : '进入翁法罗斯'),
            h(MenuItemButton, { onSelect: () => { setAnchor(null); ctx.layout.selectPanel('ruwo-suoxie-history'); } }, '觐见浮黎'),
            error && h('p', { role: 'alert', style: { padding: 12 } }, error)), document.body));
      }
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'ruwo-suoxie', order: 150, label: '如我所书' }, Launcher));
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'ruwo-suoxie' }, () => null));
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'ruwo-suoxie-history' }, HistoryPanel));
      if (ctx.layout.panelInfo.getSnapshot().activePanelId === 'ruwo-suoxie') ctx.layout.selectPanel(null);
    } };
  },
});
