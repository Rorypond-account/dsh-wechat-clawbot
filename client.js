window.__ModuleLoader__.load({
  id: 'dsh-wechat-clawbot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const PLUGIN_ID = 'dsh-wechat-clawbot';
    const API = 'api/wechat-clawbot';
    const LOCALE = (typeof navigator !== 'undefined' && /^en/i.test(navigator.language || '')) ? 'en' : 'zh';

    const TEXT = {
      zh: {
        title: '微信 ClawBot 桥接',
        subtitle: '扫码登录微信；DSH 启动时自动连接；回复由本机 DSH agent（本地插件与提示词）生成。',
        connect: '连接状态',
        phase: '当前状态',
        account: '账号',
        notLoggedIn: '未登录',
        qrTitle: '微信登录二维码',
        qrHint: '用手机微信扫描二维码；若手机上显示数字配对码，请填到下方。',
        qrEmpty: '还没有二维码。点击「登录 / 重新登录」获取。',
        openLink: '在微信里打开链接',
        verifyTitle: '配对码',
        verifyHint: '手机微信上显示的数字配对码。',
        verifySubmit: '提交配对码',
        begin: '登录 / 重新登录',
        restart: '重启桥接',
        logout: '退出登录',
        logoutConfirm: '确定退出登录？退出后需要重新扫码。',
        save: '保存设置',
        saved: '已保存',
        switches: '开关',
        autoSaveHint: '开关改动会立即保存；文本框停止输入后自动保存。',
        enabled: '启用微信桥接',
        autoStart: 'DSH 启动时自动连接',
        replyEnabled: '接入本地插件/提示词（用本机 DSH agent 回复）',
        useLocalPrompt: '使用本机提示词（微信会话人设）',
        progress: '处理时先回「正在处理」',
        announce: '启动/新会话时播报参数卡（工作区、模型、思考等级、权限）',
        agent: '本地 agent',
        prompt: '微信会话提示词',
        promptHint: '仅当「使用本机提示词」开启时注入；关闭则沿用 profile 默认人设。',
        replyDisabledText: '关闭本地回复时的固定回复',
        model: '模型（留空跟随 profile 默认）',
        reasoning: '思考等级',
        reasoningHint: '留空跟随模型默认；常见值 low / medium / high / max，以模型声明为准。',
        workspaces: '已登记工作区（每行一个绝对路径）',
        workspacesHint: '微信里用 /ws 查看、/ws add <路径> 新增并切换、/ws use <编号|路径> 切换。',
        provider: 'provider（留空跟随默认）',
        cwd: '微信会话工作目录（绝对路径，留空用默认）',
        permission: '会话权限',
        allowFrom: '允许的微信用户（每行一个；留空仅允许扫码者本人）',
        advanced: '高级',
        python: 'Python 可执行文件（留空自动探测）',
        logLevel: '日志级别',
        logs: '诊断日志',
        refresh: '刷新',
        error: '错误',
        running: '运行中',
        stopped: '未运行',
        saving: '保存中…',
        noBridge: '桥接进程未运行',
      },
      en: {
        title: 'WeChat ClawBot Bridge',
        subtitle: 'Scan a QR code to sign in; ClawBot connects automatically when DSH starts; replies come from the local DSH agent.',
        connect: 'Connection',
        phase: 'Phase',
        account: 'Account',
        notLoggedIn: 'not signed in',
        qrTitle: 'WeChat login QR',
        qrHint: 'Scan it with WeChat on your phone. If WeChat shows a pairing code, enter it below.',
        qrEmpty: 'No QR code yet. Use "Sign in / Reconnect".',
        openLink: 'Open the link in WeChat',
        verifyTitle: 'Pairing code',
        verifyHint: 'The digits WeChat shows on your phone.',
        verifySubmit: 'Submit code',
        begin: 'Sign in / Reconnect',
        restart: 'Restart bridge',
        logout: 'Sign out',
        logoutConfirm: 'Sign out? You will need to scan again.',
        save: 'Save settings',
        saved: 'Saved',
        switches: 'Switches',
        autoSaveHint: 'Switches save immediately; text fields save shortly after you stop typing.',
        enabled: 'Enable the bridge',
        autoStart: 'Connect automatically when DSH starts',
        replyEnabled: 'Answer through the local plugins/prompt (local DSH agent)',
        useLocalPrompt: 'Use the local prompt as the WeChat persona',
        progress: 'Send an "in progress" message first',
        announce: 'Announce the session card on start / new session (workspace, model, effort, permission)',
        agent: 'Local agent',
        prompt: 'WeChat persona prompt',
        promptHint: 'Injected only while "Use the local prompt" is on; otherwise the profile persona applies.',
        replyDisabledText: 'Fixed reply when local answering is off',
        model: 'Model (empty follows the profile default)',
        reasoning: 'Reasoning effort',
        reasoningHint: 'Empty follows the model default; usually low / medium / high / max.',
        workspaces: 'Registered workspaces (one absolute path per line)',
        workspacesHint: 'In WeChat: /ws to list, /ws add <path> to create and switch, /ws use <index|path> to switch.',
        provider: 'Provider (empty follows the default)',
        cwd: 'Working directory for WeChat sessions (absolute; empty uses the default)',
        permission: 'Session permission',
        allowFrom: 'Allowed WeChat users (one per line; empty allows only the account owner)',
        advanced: 'Advanced',
        python: 'Python executable (empty = auto-detect)',
        logLevel: 'Log level',
        logs: 'Diagnostics',
        refresh: 'Refresh',
        error: 'Error',
        running: 'running',
        stopped: 'stopped',
        saving: 'Saving…',
        noBridge: 'Bridge process is not running',
      },
    }[LOCALE];

    const CSS = `
.cw-root { display: flex; flex-direction: column; gap: 18px; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-text-primary, #1f2328); }
.cw-card { border: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25)); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.cw-card > h3 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-text-secondary, #4a5158); text-transform: uppercase; }
.cw-head { display: flex; flex-direction: column; gap: 4px; }
.cw-head b { font-size: 15px; }
.cw-muted { color: var(--dsw-alias-text-secondary, #5b636b); font-size: 12px; }
.cw-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.cw-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; font-size: 12px; border: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3)); }
.cw-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-text-tertiary, #98a0a8); }
.cw-dot.ok { background: #18a058; }
.cw-dot.warn { background: #d99b00; }
.cw-dot.err { background: #d03050; }
.cw-grid { display: grid; grid-template-columns: minmax(120px, 180px) 1fr; gap: 8px 14px; align-items: start; }
.cw-grid > label { color: var(--dsw-alias-text-secondary, #5b636b); padding-top: 6px; }
.cw-input, .cw-textarea, .cw-select { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35)); border-radius: 8px; background: var(--dsw-alias-bg-input, transparent); color: inherit; font: inherit; padding: 6px 9px; }
.cw-textarea { min-height: 74px; resize: vertical; }
.cw-switch { display: flex; align-items: center; gap: 9px; padding: 3px 0; }
.cw-switch input { inline-size: 16px; block-size: 16px; }
.cw-btn { border: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35)); background: var(--dsw-alias-bg-secondary, rgba(128,128,128,.08)); color: inherit; border-radius: 8px; padding: 6px 13px; font: inherit; cursor: pointer; }
.cw-btn:hover { border-color: var(--dsw-alias-border-primary, rgba(128,128,128,.6)); }
.cw-btn.primary { background: #18a058; border-color: #18a058; color: #fff; }
.cw-btn.danger { color: #d03050; }
.cw-qr { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.cw-qr img { width: 176px; height: 176px; border-radius: 8px; background: #fff; padding: 6px; border: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25)); }
.cw-link { word-break: break-all; font-size: 12px; color: var(--dsw-alias-text-link, #247bbf); }
.cw-log { max-height: 220px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1.5; border: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25)); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; word-break: break-all; background: var(--dsw-alias-bg-secondary, rgba(128,128,128,.06)); }
.cw-err { color: #d03050; font-size: 12px; }
.cw-saved { color: #18a058; font-size: 12px; }
`;

    async function call(path, init) {
      const response = await fetch(`${API}/${path}`, {
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        throw new Error((payload && payload.error) || `HTTP ${response.status}`);
      }
      return payload;
    }

    function phaseTone(phase) {
      if (!phase) return '';
      if (phase === 'connected' || phase === 'confirmed') return 'ok';
      if (phase === 'error' || phase === 'disabled') return 'err';
      if (phase === 'waiting_qr' || phase === 'qr_ready' || phase === 'need_verify' || phase === 'starting') return 'warn';
      return '';
    }

    function Field(props) {
      return h(
        React.Fragment,
        null,
        h('label', { title: props.hint || '' }, props.label),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          props.children,
          props.hint ? h('span', { className: 'cw-muted' }, props.hint) : null,
        ),
      );
    }

    function Switch(props) {
      return h(
        'label',
        { className: 'cw-switch' },
        h('input', {
          type: 'checkbox',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          checked: Boolean(props.checked),
          onChange: (event) => props.onChange(event.target.checked),
          disabled: Boolean(props.disabled),
        }),
        h('span', null, props.label),
      );
    }

    function WechatPage(props) {
      const view = props && props.view === 'summary' ? 'summary' : 'page';
      const [status, setStatus] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');
      const [draft, setDraft] = useState(null);
      const [verifyCode, setVerifyCode] = useState('');
      const [notice, setNotice] = useState('');
      const [logs, setLogs] = useState({ lines: [], bridgeLog: [] });
      const alive = useRef(true);
      const draftRef = useRef(null);
      const saveTimer = useRef(null);
      const saveSeq = useRef(0);

      useEffect(() => {
        draftRef.current = draft;
      }, [draft]);

      useEffect(
        () => () => {
          if (saveTimer.current) clearTimeout(saveTimer.current);
        },
        [],
      );

      useEffect(() => {
        alive.current = true;
        const tick = async () => {
          try {
            const next = await call('status');
            if (!alive.current) return;
            setStatus(next);
            setError('');
            setDraft((current) => {
              if (current) return current;
              return next && next.config ? next.config : null;
            });
          } catch (cause) {
            if (alive.current) setError(String((cause && cause.message) || cause));
          }
        };
        tick();
        const timer = setInterval(tick, 2500);
        return () => {
          alive.current = false;
          clearInterval(timer);
        };
      }, []);

      useEffect(() => {
        if (view !== 'page') return undefined;
        let stopped = false;
        const load = async () => {
          try {
            const next = await call('logs?tail=200');
            if (!stopped && next) setLogs({ lines: next.lines || [], bridgeLog: next.bridgeLog || [] });
          } catch {
            /* diagnostics are optional */
          }
        };
        load();
        const timer = setInterval(load, 5000);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, [view]);

      const action = async (name, work) => {
        setBusy(name);
        setNotice('');
        try {
          const result = await work();
          if (result && result.status) setStatus(result.status);
          setError('');
        } catch (cause) {
          setError(String((cause && cause.message) || cause));
        } finally {
          setBusy('');
        }
      };

      const publish = async (next) => {
        const seq = (saveSeq.current += 1);
        const payload = {
          ...next,
          allowFrom: Array.isArray(next.allowFrom)
            ? next.allowFrom.map((item) => String(item).trim()).filter(Boolean)
            : String(next.allowFrom || '')
                .split(/[\n,]/)
                .map((item) => item.trim())
                .filter(Boolean),
        };
        const result = await call('config', { method: 'POST', body: JSON.stringify({ config: payload }) });
        // A newer save may already be in flight; only the latest response may win.
        if (seq !== saveSeq.current) return result;
        const saved = result && result.config ? result.config : payload;
        draftRef.current = saved;
        setDraft(saved);
        setNotice(TEXT.saved);
        setError('');
        if (result && result.status) setStatus(result.status);
        return result;
      };

      const setField = (key, value) => {
        const next = { ...(draftRef.current || {}), [key]: value };
        draftRef.current = next;
        setDraft(next);
        return next;
      };

      // A switch must stick the moment it is flipped; finding a separate save
      // control for it is exactly the complaint this avoids.
      const toggleField = (key, value) => {
        const next = setField(key, value);
        setBusy('auto');
        publish(next)
          .catch((cause) => setError(String((cause && cause.message) || cause)))
          .finally(() => setBusy(''));
      };

      // Typed fields save shortly after typing stops.
      const typeField = (key, value) => {
        const next = setField(key, value);
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null;
          publish(next).catch((cause) => setError(String((cause && cause.message) || cause)));
        }, 800);
      };

      const save = async () => {
        if (!draftRef.current) return;
        setBusy('save');
        if (saveTimer.current) {
          clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        try {
          await publish(draftRef.current);
        } catch (cause) {
          setError(String((cause && cause.message) || cause));
        } finally {
          setBusy('');
        }
      };

      const phase = status ? status.phase : 'idle';
      const running = Boolean(status && status.running);
      const qrUrl = status && status.qrcodeUrl ? status.qrcodeUrl : '';
      const qrSrc = status ? `${API}/qr.svg?t=${encodeURIComponent(status.updatedAt || '')}` : '';

      if (view === 'summary') {
        return h(
          'span',
          { className: 'cw-root' },
          h('span', { className: `cw-dot ${phaseTone(phase)}` }),
          ` ${phase || 'idle'}${running ? '' : ` · ${TEXT.stopped}`}`,
        );
      }

      return h(
        'div',
        { className: 'cw-root' },
        h(
          'div',
          { className: 'cw-head' },
          h('b', null, TEXT.title),
          h('span', { className: 'cw-muted' }, TEXT.subtitle),
        ),

        error ? h('div', { className: 'cw-err' }, `${TEXT.error}: ${error}`) : null,
        notice ? h('div', { className: 'cw-saved' }, notice) : null,

        h(
          'section',
          { className: 'cw-card' },
          h('h3', null, TEXT.connect),
          h(
            'div',
            { className: 'cw-row' },
            h(
              'span',
              { className: 'cw-badge' },
              h('span', { className: `cw-dot ${phaseTone(phase)}` }),
              `${TEXT.phase}: ${phase || 'idle'}`,
            ),
            h('span', { className: 'cw-badge' }, `${TEXT.account}: ${(status && status.accountId) || TEXT.notLoggedIn}`),
            h('span', { className: 'cw-badge' }, running ? TEXT.running : TEXT.noBridge),
          ),
          status && status.message ? h('div', { className: 'cw-muted' }, status.message) : null,
          h(
            'div',
            { className: 'cw-row' },
            h('button', { className: 'cw-btn primary', onClick: () => action('begin', () => call('begin', { method: 'POST' })), disabled: busy === 'begin' }, TEXT.begin),
            h('button', { className: 'cw-btn', onClick: () => action('restart', () => call('restart', { method: 'POST' })), disabled: busy === 'restart' }, TEXT.restart),
            h(
              'button',
              {
                className: 'cw-btn danger',
                onClick: () => {
                  if (typeof window !== 'undefined' && !window.confirm(TEXT.logoutConfirm)) return;
                  action('logout', () => call('logout', { method: 'POST' }));
                },
                disabled: busy === 'logout',
              },
              TEXT.logout,
            ),
          ),
        ),

        h(
          'section',
          { className: 'cw-card' },
          h('h3', null, TEXT.qrTitle),
          qrUrl
            ? h(
                'div',
                { className: 'cw-qr' },
                h('img', { src: qrSrc, alt: 'WeChat login QR', width: 176, height: 176 }),
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220 } },
                  h('span', { className: 'cw-muted' }, TEXT.qrHint),
                  h('a', { className: 'cw-link', href: qrUrl, target: '_blank', rel: 'noreferrer' }, qrUrl),
                ),
              )
            : h('div', { className: 'cw-muted' }, TEXT.qrEmpty),
          phase === 'need_verify'
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                h('b', null, TEXT.verifyTitle),
                h('span', { className: 'cw-muted' }, TEXT.verifyHint),
                h(
                  'div',
                  { className: 'cw-row' },
                  h('input', {
                    className: 'cw-input',
                    style: { maxWidth: 180 },
                    value: verifyCode,
                    inputMode: 'numeric',
                    onChange: (event) => setVerifyCode(event.target.value),
                    placeholder: '123456',
                  }),
                  h(
                    'button',
                    {
                      className: 'cw-btn primary',
                      disabled: busy === 'verify' || !verifyCode.trim(),
                      onClick: () =>
                        action('verify', async () => {
                          const result = await call('verify-code', { method: 'POST', body: JSON.stringify({ code: verifyCode.trim() }) });
                          setVerifyCode('');
                          return result;
                        }),
                    },
                    TEXT.verifySubmit,
                  ),
                ),
              )
            : null,
        ),

        draft
          ? h(
              'section',
              { className: 'cw-card' },
              h('h3', null, TEXT.switches),
              h('span', { className: 'cw-muted' }, TEXT.autoSaveHint),
              h(Switch, {
                label: TEXT.enabled,
                checked: draft.enabled,
                onChange: (value) => toggleField('enabled', value),
              }),
              h(Switch, {
                label: TEXT.autoStart,
                checked: draft.autoStart,
                onChange: (value) => toggleField('autoStart', value),
              }),
              h(Switch, {
                label: TEXT.replyEnabled,
                checked: draft.replyEnabled,
                onChange: (value) => toggleField('replyEnabled', value),
              }),
              h(Switch, {
                label: TEXT.useLocalPrompt,
                checked: draft.useLocalPrompt,
                onChange: (value) => toggleField('useLocalPrompt', value),
              }),
              h(Switch, {
                label: TEXT.progress,
                checked: draft.progressMessages,
                onChange: (value) => toggleField('progressMessages', value),
              }),
              h(Switch, {
                label: TEXT.announce,
                checked: draft.announceSession !== false,
                onChange: (value) => toggleField('announceSession', value),
              }),
              h(
                'div',
                { className: 'cw-grid' },
                h(Field, { label: TEXT.replyDisabledText }, h('textarea', {
                  className: 'cw-textarea',
                  value: draft.replyDisabledText || '',
                  onChange: (event) => typeField('replyDisabledText', event.target.value),
                })),
                h(
                  Field,
                  { label: TEXT.prompt, hint: TEXT.promptHint },
                  h('textarea', {
                    className: 'cw-textarea',
                    value: draft.systemPrompt || '',
                    onChange: (event) => typeField('systemPrompt', event.target.value),
                  }),
                ),
              ),
              h(
                'div',
                { className: 'cw-row' },
                h('button', { className: 'cw-btn primary', onClick: save, disabled: busy === 'save' }, busy === 'save' ? TEXT.saving : TEXT.save),
              ),
            )
          : null,

        draft
          ? h(
              'section',
              { className: 'cw-card' },
              h('h3', null, TEXT.agent),
              h(
                'div',
                { className: 'cw-grid' },
                h(Field, { label: TEXT.provider }, h('input', {
                  className: 'cw-input',
                  value: draft.provider || '',
                  onChange: (event) => typeField('provider', event.target.value),
                })),
                h(Field, { label: TEXT.model }, h('input', {
                  className: 'cw-input',
                  value: draft.model || '',
                  onChange: (event) => typeField('model', event.target.value),
                })),
                h(
                  Field,
                  { label: TEXT.reasoning, hint: TEXT.reasoningHint },
                  h('input', {
                    className: 'cw-input',
                    value: draft.reasoningEffort || '',
                    onChange: (event) => typeField('reasoningEffort', event.target.value),
                    placeholder: 'low / medium / high / max',
                  }),
                ),
                h(Field, { label: TEXT.cwd }, h('input', {
                  className: 'cw-input',
                  value: draft.cwd || '',
                  onChange: (event) => typeField('cwd', event.target.value),
                  placeholder: 'C:\\Users\\you\\.dsh\\wechat-clawbot\\workspace',
                })),
                h(
                  Field,
                  { label: TEXT.permission },
                  h(
                    'select',
                    {
                      className: 'cw-select',
                      value: draft.permission || 'workspace-write',
                      onChange: (event) => toggleField('permission', event.target.value),
                    },
                    h('option', { value: 'read-only' }, 'read-only'),
                    h('option', { value: 'workspace-write' }, 'workspace-write'),
                    h('option', { value: 'danger-full-access' }, 'danger-full-access'),
                  ),
                ),
                h(
                  Field,
                  { label: TEXT.allowFrom },
                  h('textarea', {
                    className: 'cw-textarea',
                    value: Array.isArray(draft.allowFrom) ? draft.allowFrom.join('\n') : String(draft.allowFrom || ''),
                    onChange: (event) => typeField('allowFrom', event.target.value.split('\n')),
                  }),
                ),
                h(
                  Field,
                  { label: TEXT.workspaces, hint: TEXT.workspacesHint },
                  h('textarea', {
                    className: 'cw-textarea',
                    value: Array.isArray(draft.workspaces) ? draft.workspaces.join('\n') : String(draft.workspaces || ''),
                    onChange: (event) => typeField('workspaces', event.target.value.split('\n')),
                  }),
                ),
              ),
            )
          : null,

        draft
          ? h(
              'section',
              { className: 'cw-card' },
              h('h3', null, TEXT.advanced),
              h(
                'div',
                { className: 'cw-grid' },
                h(Field, { label: TEXT.python }, h('input', {
                  className: 'cw-input',
                  value: draft.pythonPath || '',
                  onChange: (event) => typeField('pythonPath', event.target.value),
                  placeholder: 'python',
                })),
                h(
                  Field,
                  { label: TEXT.logLevel },
                  h(
                    'select',
                    {
                      className: 'cw-select',
                      value: draft.logLevel || 'INFO',
                      onChange: (event) => toggleField('logLevel', event.target.value),
                    },
                    h('option', { value: 'DEBUG' }, 'DEBUG'),
                    h('option', { value: 'INFO' }, 'INFO'),
                    h('option', { value: 'WARNING' }, 'WARNING'),
                    h('option', { value: 'ERROR' }, 'ERROR'),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'cw-row' },
                h('button', { className: 'cw-btn primary', onClick: save, disabled: busy === 'save' }, busy === 'save' ? TEXT.saving : TEXT.save),
              ),
            )
          : null,

        h(
          'section',
          { className: 'cw-card' },
          h(
            'div',
            { className: 'cw-row', style: { justifyContent: 'space-between' } },
            h('h3', { style: { margin: 0 } }, TEXT.logs),
            h('button', {
              className: 'cw-btn',
              onClick: async () => {
                try {
                  const next = await call('logs?tail=200');
                  if (next) setLogs({ lines: next.lines || [], bridgeLog: next.bridgeLog || [] });
                } catch {
                  /* ignore */
                }
              },
            }, TEXT.refresh),
          ),
          h('div', { className: 'cw-log' }, [...(logs.lines || []), ...(logs.bridgeLog || [])].slice(-260).join('\n') || '(empty)'),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {};
          const tag = document.createElement('style');
          tag.dataset.plugin = PLUGIN_ID;
          tag.dataset.pluginCss = `${PLUGIN_ID}/client.js`;
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => tag.remove();
        }, 'wechat-clawbot: page styles');

        const mount = (slotName, options, label) => {
          ctx.effect(() => {
            try {
              return ctx.slots.inject(slotName, () => ctx.slots.register(options, WechatPage));
            } catch (cause) {
              console.warn(`[wechat-clawbot] cannot mount ${slotName}`, cause);
              return () => {};
            }
          }, label);
        };

        // A page in Settings itself, which is where the user expects a switch.
        mount(
          'settings.section',
          {
            name: 'settings.section',
            id: PLUGIN_ID,
            order: 60,
            label: () => (LOCALE === 'en' ? 'WeChat ClawBot' : '微信 ClawBot'),
          },
          'wechat-clawbot: settings page',
        );

        // And the bundle's own page (Settings → Plugins → dsh-wechat-clawbot).
        mount(
          'plugins.bundle.config',
          { name: 'plugins.bundle.config', key: PLUGIN_ID, id: `${PLUGIN_ID}-bundle` },
          'wechat-clawbot: bundle page',
        );
      },
    };
  },
});
