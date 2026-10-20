window.__ModuleLoader__.load({
  id: 'dsh-role-gate',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'role-gate'

    const zh = {
      label: '身份',
      none: '未启用',
      noneHint: '全部工具可用',
      empty: '还没有身份。可以新建，或在对话里说「用 RoleGate 创建一个…」。',
      loading: '读取身份…',
      error: '身份读取失败',
      active: '当前',
      tools: '工具',
      skills: '技能',
      allTools: '全部工具',
      allSkills: '全部技能',
      nextStep: '下一步生效',
      libraryWarning: '身份库有加载警告',
      retry: '重试',
      create: '新建身份',
      edit: '编辑当前身份',
      draft: '待完善',
      draftHint: '待完善标记；仍可切换，补完后可取消',
      editorCreate: '新建 RoleGate 身份',
      editorEdit: '编辑 RoleGate 身份',
      name: '名称',
      title: '标题',
      description: '描述',
      inherits: '继承',
      noInherits: '没有可继承的身份',
      instructions: '行为指令',
      allowWeb: '联网兜底（web_search / web_fetch）',
      allToolsOption: '全部工具（*）',
      allSkillsOption: '全部技能（*）',
      searchTools: '搜索工具…',
      searchSkills: '搜索技能…',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      aiFill: '让 AI 补全',
      composerUnavailable: '输入框不可用，无法把补全请求放入对话',
      nameRequired: '名称必填',
      catalogFailed: '无法读取工具/技能目录',
      saved: '已保存',
      global: '全局',
      scoped: 'preset',
      newSession: '新会话',
      newSessionHint: '选择后在新会话创建时应用',
      newSessionNoEdit: '新会话创建后可编辑身份',
      pendingForNew: '待应用',
      pendingApplied: '已选择，新会话创建时应用',
    }
    const en = {
      label: 'Identity',
      none: 'Off',
      noneHint: 'All tools available',
      empty: 'No identities yet. Create one, or ask in chat: “Create a RoleGate identity for …”.',
      loading: 'Loading identities…',
      error: 'Could not load identities',
      active: 'Current',
      tools: 'tools',
      skills: 'skills',
      allTools: 'all tools',
      allSkills: 'all skills',
      nextStep: 'next step',
      libraryWarning: 'Identity library has a load warning',
      retry: 'Retry',
      create: 'New identity',
      edit: 'Edit current',
      draft: 'Draft',
      draftHint: 'Advisory marker only; still selectable',
      editorCreate: 'New RoleGate identity',
      editorEdit: 'Edit RoleGate identity',
      name: 'Name',
      title: 'Title',
      description: 'Description',
      inherits: 'Inherits',
      noInherits: 'No identities to inherit',
      instructions: 'Instructions',
      allowWeb: 'Web fallback (web_search / web_fetch)',
      allToolsOption: 'All tools (*)',
      allSkillsOption: 'All skills (*)',
      searchTools: 'Search tools…',
      searchSkills: 'Search skills…',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      aiFill: 'Ask AI to complete',
      composerUnavailable: 'Composer is unavailable; cannot place the completion request',
      nameRequired: 'Name is required',
      catalogFailed: 'Could not load the tool/skill catalog',
      saved: 'Saved',
      global: 'global',
      scoped: 'preset',
      newSession: 'New session',
      newSessionHint: 'Applied when the new session starts',
      newSessionNoEdit: 'Edit identities after the session starts',
      pendingForNew: 'pending',
      pendingApplied: 'Selected; applied when the new session starts',
    }

    const COLORS = ['#4f8cff', '#2fb8a6', '#e0a23a', '#b47cff', '#e2657a', '#5aa9e6']

    function colorFor(name) {
      let hash = 0
      const text = String(name ?? '')
      for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) >>> 0
      }
      return COLORS[hash % COLORS.length]
    }

    function countText(value, t, allKey) {
      if (value === 'all') return t(allKey)
      return `${value ?? 0} ${allKey === 'allTools' ? t('tools') : t('skills')}`
    }

    function Chevron({ open }) {
      return h('svg', {
        width: 12,
        height: 12,
        viewBox: '0 0 12 12',
        'aria-hidden': true,
        style: {
          transform: open ? 'rotate(180deg)' : 'none',
          transition: 'transform 120ms ease',
          flex: '0 0 auto',
        },
      }, h('path', {
        d: 'M2.5 4.5 6 8l3.5-3.5',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    function Check() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 14 14',
        'aria-hidden': true,
        style: { flex: '0 0 auto', color: 'var(--dsw-alias-brand-primary)' },
      }, h('path', {
        d: 'M2.5 7.5 5.5 10.5 11.5 3.5',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    async function readJson(response) {
      const data = await response.json()
      if (!response.ok || data?.ok !== true) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      return data
    }

    function IdentityEditor({ editor, catalog, sessionId, t, onClose, onSaved, inputActions }) {
      const [form, setForm] = React.useState(editor.form)
      const [toolQuery, setToolQuery] = React.useState('')
      const [skillQuery, setSkillQuery] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && !saving) onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose, saving])

      function update(field, value) {
        setForm((previous) => ({ ...previous, [field]: value }))
      }

      function toggleList(field, value) {
        setForm((previous) => {
          let list = Array.isArray(previous[field]) ? previous[field].filter((entry) => entry !== '*') : []
          list = list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]
          return { ...previous, [field]: list }
        })
      }

      function setAll(field, checked) {
        setForm((previous) => ({ ...previous, [field]: checked ? ['*'] : [] }))
      }

      function toggleInherit(name) {
        setForm((previous) => {
          const list = Array.isArray(previous.inherits) ? previous.inherits : []
          const next = list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name]
          return { ...previous, inherits: next }
        })
      }

      async function save() {
        if (typeof form.name !== 'string' || form.name.trim() === '') {
          setError(t('nameRequired'))
          return
        }
        setSaving(true)
        setError('')
        try {
          const response = await fetch('/role-gate/author/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              sessionId,
              mode: editor.mode === 'create' ? 'create' : 'update',
              name: form.name.trim(),
              identity: { ...form, name: form.name.trim() },
            }),
          })
          const data = await readJson(response)
          onSaved(data)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setSaving(false)
        }
      }

      function aiFill() {
        const draftText = JSON.stringify({ ...form, name: form.name || undefined }, null, 2)
        const prompt = [
          `请补全 RoleGate 身份「${form.name || '未命名'}」。当前设计如下：`,
          '```json',
          draftText,
          '```',
          '请先用 role_gate_author action=catalog 查看可用工具与技能，指出缺口并给出补充建议；我确认后再用 role_gate_author action=update（可配合 addTools/addSkills/removeTools/removeSkills）写入。若身份尚未创建，请先提议 create，并保持 draft=true。',
        ].join('\n')
        if (inputActions && typeof inputActions.setDraft === 'function') {
          try {
            const span = typeof inputActions.captureInsertion === 'function'
              ? inputActions.captureInsertion()
              : undefined
            const inserted = typeof inputActions.insertText === 'function' && span !== undefined
              ? inputActions.insertText(prompt, span)
              : false
            if (!inserted) inputActions.setDraft(prompt)
          } catch {
            inputActions.setDraft(prompt)
          }
          onClose()
        } else {
          setError(t('composerUnavailable'))
        }
      }

      const tools = Array.isArray(catalog?.tools) ? catalog.tools : []
      const skills = Array.isArray(catalog?.skills) ? catalog.skills : []
      const identities = Array.isArray(catalog?.identities) ? catalog.identities : []
      const toolNeedle = toolQuery.trim().toLowerCase()
      const skillNeedle = skillQuery.trim().toLowerCase()
      const visibleTools = toolNeedle === ''
        ? tools
        : tools.filter((tool) => `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(toolNeedle))
      const visibleSkills = skillNeedle === ''
        ? skills
        : skills.filter((skill) => `${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(skillNeedle))
      const inherited = new Set(Array.isArray(form.inherits) ? form.inherits : [])
      const selectedTools = new Set(Array.isArray(form.tools) ? form.tools : [])
      const selectedSkills = new Set(Array.isArray(form.skills) ? form.skills : [])

      function field(label, control) {
        return h('label', { className: 'rg-field', key: label }, [
          h('span', { key: 'label', className: 'rg-field-label' }, label),
          control,
        ])
      }

      function checkRow(key, checked, onChange, name, meta) {
        return h('label', { className: 'rg-check-row', key }, [
          h('input', { key: 'input', type: 'checkbox', checked, onChange }),
          h('span', { key: 'name', className: 'rg-check-name' }, name),
          meta ? h('span', { key: 'meta', className: 'rg-scope' }, meta) : null,
        ])
      }

      return h('div', {
        className: 'rg-overlay',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget && !saving) onClose()
        },
      }, h('div', {
        className: 'rg-editor',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': editor.mode === 'create' ? t('editorCreate') : t('editorEdit'),
      }, [
        h('div', { key: 'head', className: 'rg-editor-head' }, [
          h('strong', { key: 'title', className: 'rg-editor-title' }, editor.mode === 'create' ? t('editorCreate') : t('editorEdit')),
          form.draft ? h('span', { key: 'draft', className: 'rg-badge-draft' }, t('draft')) : null,
          h('button', { key: 'close', type: 'button', className: 'rg-icon-btn', onClick: onClose, disabled: saving, 'aria-label': t('cancel') }, '×'),
        ]),

        h('div', { key: 'basic', className: 'rg-editor-grid' }, [
          field(t('name'), h('input', {
            key: 'name',
            className: 'rg-input',
            value: form.name,
            disabled: editor.mode === 'edit',
            autoFocus: editor.mode === 'create',
            placeholder: 'code-review',
            onChange: (event) => update('name', event.target.value),
          })),
          field(t('title'), h('input', {
            key: 'title',
            className: 'rg-input',
            value: form.title,
            onChange: (event) => update('title', event.target.value),
          })),
        ]),

        field(t('description'), h('input', {
          key: 'description',
          className: 'rg-input',
          value: form.description,
          onChange: (event) => update('description', event.target.value),
        })),

        h('div', { key: 'flags', className: 'rg-editor-flags' }, [
          h('label', { key: 'web', className: 'rg-inline-check' }, [
            h('input', {
              key: 'input',
              type: 'checkbox',
              checked: form.allowWebFallback !== false,
              onChange: (event) => update('allowWebFallback', event.target.checked),
            }),
            h('span', { key: 'text' }, t('allowWeb')),
          ]),
          h('label', { key: 'draft', className: 'rg-inline-check', title: t('draftHint') }, [
            h('input', {
              key: 'input',
              type: 'checkbox',
              checked: form.draft === true,
              onChange: (event) => update('draft', event.target.checked),
            }),
            h('span', { key: 'text' }, t('draft')),
          ]),
        ]),

        h('div', { key: 'inherits', className: 'rg-field' }, [
          h('span', { key: 'label', className: 'rg-field-label' }, t('inherits')),
          identities.filter((identity) => identity.name !== form.name).length === 0
            ? h('div', { key: 'empty', className: 'rg-hint' }, t('noInherits'))
            : h('div', { key: 'list', className: 'rg-check-list rg-check-list-short' },
              identities
                .filter((identity) => identity.name !== form.name)
                .map((identity) => checkRow(
                  `inherit:${identity.name}`,
                  inherited.has(identity.name),
                  () => toggleInherit(identity.name),
                  identity.title || identity.name,
                  identity.draft ? t('draft') : null,
                ))),
        ]),

        h('div', { key: 'tools', className: 'rg-field' }, [
          h('span', { key: 'label', className: 'rg-field-label' }, `${t('tools')} (${selectedTools.has('*') ? '*' : selectedTools.size})`),
          h('input', {
            key: 'search',
            className: 'rg-input',
            placeholder: t('searchTools'),
            value: toolQuery,
            onChange: (event) => setToolQuery(event.target.value),
          }),
          h('div', { key: 'list', className: 'rg-check-list' }, [
            checkRow('tool:*', selectedTools.has('*'), (event) => setAll('tools', event.target.checked), t('allToolsOption'), null),
            ...visibleTools.map((tool) => checkRow(
              `tool:${tool.name}`,
              selectedTools.has(tool.name),
              () => toggleList('tools', tool.name),
              tool.name,
              tool.scope === 'global' ? t('global') : t('scoped'),
            )),
          ]),
        ]),

        h('div', { key: 'skills', className: 'rg-field' }, [
          h('span', { key: 'label', className: 'rg-field-label' }, `${t('skills')} (${selectedSkills.has('*') ? '*' : selectedSkills.size})`),
          h('input', {
            key: 'search',
            className: 'rg-input',
            placeholder: t('searchSkills'),
            value: skillQuery,
            onChange: (event) => setSkillQuery(event.target.value),
          }),
          catalog?.skillsAvailable === false
            ? h('div', { key: 'unavailable', className: 'rg-hint' }, catalog.skillsError || t('catalogFailed'))
            : h('div', { key: 'list', className: 'rg-check-list' }, [
              checkRow('skill:*', selectedSkills.has('*'), (event) => setAll('skills', event.target.checked), t('allSkillsOption'), null),
              ...visibleSkills.map((skill) => checkRow(
                `skill:${skill.name}`,
                selectedSkills.has(skill.name),
                () => toggleList('skills', skill.name),
                skill.name,
                null,
              )),
            ]),
        ]),

        field(t('instructions'), h('textarea', {
          key: 'instructions',
          className: 'rg-textarea',
          rows: 5,
          value: form.instructions,
          onChange: (event) => update('instructions', event.target.value),
        })),

        error ? h('div', { key: 'error', className: 'rg-error' }, error) : null,

        h('div', { key: 'actions', className: 'rg-editor-actions' }, [
          h('button', { key: 'ai', type: 'button', className: 'rg-btn', onClick: aiFill, disabled: saving }, t('aiFill')),
          h('button', { key: 'cancel', type: 'button', className: 'rg-btn', onClick: onClose, disabled: saving }, t('cancel')),
          h('button', { key: 'save', type: 'button', className: 'rg-btn rg-btn-primary', onClick: save, disabled: saving }, saving ? t('saving') : t('save')),
        ]),
      ]))
    }

    function NewSessionIdentity({ t }) {
      const [identities, setIdentities] = React.useState([])
      const [pending, setPending] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const rootRef = React.useRef(null)

      const load = React.useCallback(async () => {
        try {
          const response = await fetch('/role-gate/identities', {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
          })
          const data = await readJson(response)
          setIdentities(Array.isArray(data.identities) ? data.identities : [])
          setPending(typeof data.pending === 'string' ? data.pending : null)
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        load()
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') load()
        }, 5000)
        return () => clearInterval(timer)
      }, [load])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
            setOpen(false)
          }
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onPointer)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      async function select(name) {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const response = await fetch('/role-gate/pending', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ identity: name }),
          })
          await readJson(response)
          setPending(name)
          setOpen(false)
          load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const pendingIdentity = identities.find((identity) => identity.name === pending)
      const pendingTitle = pendingIdentity?.title || pending
      const rows = []
      rows.push(h('button', {
        key: '__none__',
        type: 'button',
        role: 'option',
        'aria-selected': pending === null,
        className: `rg-row${pending === null ? ' rg-row-current' : ''}`,
        disabled: busy,
        onClick: () => select(null),
      }, [
        h('span', { key: 'dot', className: 'rg-dot', style: { background: 'var(--dsw-alias-state-idle-primary)' } }),
        h('span', { key: 'main', className: 'rg-row-main' }, [
          h('span', { key: 'title', className: 'rg-row-title' }, t('none')),
          h('span', { key: 'meta', className: 'rg-row-meta' }, t('noneHint')),
        ]),
        pending === null ? h(Check, { key: 'check' }) : null,
      ]))
      for (const identity of identities) {
        const selected = identity.name === pending
        const meta = `${countText(identity.toolCount, t, 'allTools')} · ${countText(identity.skillCount, t, 'allSkills')}`
        rows.push(h('button', {
          key: identity.name,
          type: 'button',
          role: 'option',
          'aria-selected': selected,
          className: `rg-row${selected ? ' rg-row-current' : ''}${identity.error ? ' rg-row-error' : ''}${identity.draft ? ' rg-row-draft' : ''}`,
          disabled: busy,
          onClick: () => select(identity.name),
          title: identity.error || identity.description || identity.name,
        }, [
          h('span', { key: 'dot', className: 'rg-dot', style: { background: colorFor(identity.name) } }),
          h('span', { key: 'main', className: 'rg-row-main' }, [
            h('span', { key: 'line', className: 'rg-row-titleline' }, [
              h('span', { key: 'title', className: 'rg-row-title' }, identity.title || identity.name),
              identity.draft ? h('span', { key: 'draft', className: 'rg-badge-draft' }, t('draft')) : null,
            ]),
            h('span', { key: 'meta', className: 'rg-row-meta' }, identity.error ? identity.error : meta),
          ]),
          selected ? h(Check, { key: 'check' }) : null,
        ]))
      }

      return h('div', {
        className: 'rg-root',
        ref: rootRef,
        onClick: (event) => event.stopPropagation(),
        onMouseDown: (event) => event.stopPropagation(),
      }, [
        h('style', { key: 'style' }, CSS),
        h('button', {
          key: 'pill',
          type: 'button',
          className: `rg-pill${pending ? ' rg-pill-active' : ''}${open ? ' rg-pill-open' : ''}`,
          'aria-expanded': open,
          'aria-haspopup': 'listbox',
          onClick: () => setOpen((value) => !value),
          title: pending ? t('pendingApplied') : t('newSessionHint'),
        }, [
          h('span', {
            key: 'dot',
            className: 'rg-dot',
            style: { background: pending ? colorFor(pending) : 'var(--dsw-alias-state-idle-primary)' },
          }),
          h('span', { key: 'label', className: 'rg-label' }, `${t('label')} · ${t('newSession')}`),
          h('span', { key: 'name', className: 'rg-name' }, pending ? (pendingTitle || pending) : t('none')),
          pending ? h('span', { key: 'pending', className: 'rg-pending' }, t('pendingForNew')) : null,
          h('span', { key: 'chevron', className: 'rg-chevron' }, h(Chevron, { open })),
        ]),
        open ? h('div', {
          key: 'panel',
          className: 'rg-panel',
          role: 'listbox',
          'aria-label': t('newSession'),
        }, [
          h('div', { key: 'head', className: 'rg-panel-head' }, [
            h('span', { key: 'title', className: 'rg-panel-title' }, t('newSession')),
            h('span', { key: 'hint', className: 'rg-panel-rev' }, t('newSessionHint')),
          ]),
          loading ? h('div', { key: 'loading', className: 'rg-hint' }, t('loading')) : null,
          !loading && identities.length === 0 ? h('div', { key: 'empty', className: 'rg-hint' }, t('empty')) : null,
          ...rows,
          h('div', { key: 'footer', className: 'rg-panel-footer rg-panel-footer-hint' }, t('newSessionNoEdit')),
          error ? h('div', { key: 'error', className: 'rg-error' }, error) : null,
        ]) : null,
      ])
    }

    function IdentityDock(props) {
      const sessionId = props.sessionId
      const t = props.t
      const [snapshot, setSnapshot] = React.useState(null)
      const [catalog, setCatalog] = React.useState(null)
      const [editor, setEditor] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const rootRef = React.useRef(null)
      const aliveRef = React.useRef(true)

      const load = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        try {
          const response = await fetch(`/role-gate/state?sessionId=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
          })
          const data = await readJson(response)
          if (!aliveRef.current) return
          setSnapshot(data.state)
          setError('')
        } catch (failure) {
          if (!aliveRef.current) return
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [sessionId])

      React.useEffect(() => {
        aliveRef.current = true
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        load()
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') load()
        }, 3000)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') load()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          aliveRef.current = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [sessionId, load])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
            setOpen(false)
          }
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onPointer)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      async function switchTo(name) {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const response = await fetch('/role-gate/switch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ sessionId, name }),
          })
          const data = await readJson(response)
          setSnapshot(data.state)
          setOpen(false)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      async function openEditor(mode, identity) {
        if (busy) return
        setOpen(false)
        setBusy(true)
        setError('')
        try {
          const response = await fetch(`/role-gate/author/catalog?sessionId=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
          })
          const data = await readJson(response)
          const nextCatalog = data.catalog
          setCatalog(nextCatalog)
          const source = mode === 'edit' && identity
            ? (nextCatalog.identities.find((entry) => entry.name === identity.name) ?? identity)
            : {}
          setEditor({
            mode,
            form: {
              name: source.name ?? '',
              title: source.title ?? '',
              description: source.description ?? '',
              inherits: Array.isArray(source.inherits) ? [...source.inherits] : [],
              tools: Array.isArray(source.tools) ? [...source.tools] : [],
              skills: Array.isArray(source.skills) ? [...source.skills] : [],
              instructions: source.instructions ?? '',
              allowWebFallback: source.allowWebFallback !== false,
              draft: mode === 'create' ? false : source.draft === true,
            },
          })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setOpen(true)
        } finally {
          setBusy(false)
        }
      }

      function onSaved(data) {
        setSnapshot(data.state)
        setCatalog(data.catalog)
        setEditor(null)
        setError('')
        load()
      }

      if (typeof sessionId !== 'string' || sessionId === '') return h(NewSessionIdentity, { t })

      const identities = Array.isArray(snapshot?.identities) ? snapshot.identities : []
      const currentName = snapshot?.current ?? null
      const current = identities.find((identity) => identity.name === currentName)
      const currentTitle = current?.title || currentName
      const pending = snapshot?.pending === true
      const warning = snapshot?.loadError

      const rows = []
      rows.push(h('button', {
        key: '__none__',
        type: 'button',
        role: 'option',
        'aria-selected': currentName === null,
        className: `rg-row${currentName === null ? ' rg-row-current' : ''}`,
        disabled: busy,
        onClick: () => switchTo(null),
      }, [
        h('span', { key: 'dot', className: 'rg-dot', style: { background: 'var(--dsw-alias-state-idle-primary)' } }),
        h('span', { key: 'main', className: 'rg-row-main' }, [
          h('span', { key: 'title', className: 'rg-row-title' }, t('none')),
          h('span', { key: 'meta', className: 'rg-row-meta' }, t('noneHint')),
        ]),
        currentName === null ? h(Check, { key: 'check' }) : null,
      ]))

      for (const identity of identities) {
        const selected = identity.name === currentName
        const meta = `${countText(identity.toolCount, t, 'allTools')} · ${countText(identity.skillCount, t, 'allSkills')}`
        rows.push(h('div', { key: identity.name, className: 'rg-row-wrap' }, [
          h('button', {
            key: 'row',
            type: 'button',
            role: 'option',
            'aria-selected': selected,
            className: `rg-row${selected ? ' rg-row-current' : ''}${identity.error ? ' rg-row-error' : ''}${identity.draft ? ' rg-row-draft' : ''}`,
            disabled: busy,
            onClick: () => switchTo(identity.name),
            title: identity.error || identity.description || identity.name,
          }, [
            h('span', { key: 'dot', className: 'rg-dot', style: { background: colorFor(identity.name) } }),
            h('span', { key: 'main', className: 'rg-row-main' }, [
              h('span', { key: 'line', className: 'rg-row-titleline' }, [
                h('span', { key: 'title', className: 'rg-row-title' }, identity.title || identity.name),
                identity.draft ? h('span', { key: 'draft', className: 'rg-badge-draft' }, t('draft')) : null,
              ]),
              h('span', { key: 'meta', className: 'rg-row-meta' }, identity.error ? identity.error : meta),
            ]),
            selected ? h(Check, { key: 'check' }) : null,
          ]),
          h('button', {
            key: 'edit',
            type: 'button',
            className: 'rg-edit-btn',
            title: t('edit'),
            'aria-label': `${t('edit')}: ${identity.title || identity.name}`,
            disabled: busy,
            onClick: (event) => {
              event.stopPropagation()
              openEditor('edit', identity)
            },
          }, '✎'),
        ]))
      }

      return h('div', { className: 'rg-root', ref: rootRef }, [
        h('style', { key: 'style' }, CSS),
        h('button', {
          key: 'pill',
          type: 'button',
          className: `rg-pill${currentName ? ' rg-pill-active' : ''}${open ? ' rg-pill-open' : ''}`,
          'aria-expanded': open,
          'aria-haspopup': 'listbox',
          onClick: () => setOpen((value) => !value),
          title: pending ? t('nextStep') : undefined,
        }, [
          h('span', {
            key: 'dot',
            className: 'rg-dot',
            style: { background: currentName ? colorFor(currentName) : 'var(--dsw-alias-state-idle-primary)' },
          }),
          h('span', { key: 'label', className: 'rg-label' }, t('label')),
          h('span', { key: 'name', className: 'rg-name' }, currentName ? (currentTitle || currentName) : t('none')),
          current?.draft ? h('span', { key: 'draft', className: 'rg-badge-draft' }, t('draft')) : null,
          pending ? h('span', { key: 'pending', className: 'rg-pending' }, t('nextStep')) : null,
          warning ? h('span', { key: 'warn', className: 'rg-warn', title: warning }, '!') : null,
          h('span', { key: 'chevron', className: 'rg-chevron' }, h(Chevron, { open })),
        ]),
        open ? h('div', {
          key: 'panel',
          className: 'rg-panel',
          role: 'listbox',
          'aria-label': t('label'),
        }, [
          h('div', { key: 'head', className: 'rg-panel-head' }, [
            h('span', { key: 'title', className: 'rg-panel-title' }, t('label')),
            snapshot ? h('span', { key: 'rev', className: 'rg-panel-rev' }, `r${snapshot.revision}`) : null,
          ]),
          snapshot === null ? h('div', { key: 'loading', className: 'rg-hint' }, t('loading')) : null,
          snapshot !== null && identities.length === 0 ? h('div', { key: 'empty', className: 'rg-hint' }, t('empty')) : null,
          ...rows,
          h('div', { key: 'footer', className: 'rg-panel-footer' }, [
            h('button', {
              key: 'create',
              type: 'button',
              className: 'rg-btn',
              disabled: busy,
              onClick: () => openEditor('create', null),
            }, t('create')),
            current ? h('button', {
              key: 'edit',
              type: 'button',
              className: 'rg-btn',
              disabled: busy,
              onClick: () => openEditor('edit', current),
            }, t('edit')) : null,
          ]),
          warning ? h('div', { key: 'library-warning', className: 'rg-warning', title: warning }, `${t('libraryWarning')}: ${warning}`) : null,
          error ? h('div', { key: 'error', className: 'rg-error' }, [
            h('span', { key: 'text' }, `${t('error')}: ${error}`),
            h('button', { key: 'retry', type: 'button', className: 'rg-retry', onClick: load, disabled: busy }, t('retry')),
          ]) : null,
        ]) : null,
        editor ? h(IdentityEditor, {
          key: `${editor.mode}:${editor.form.name}`,
          editor,
          catalog,
          sessionId,
          t,
          onClose: () => setEditor(null),
          onSaved,
          inputActions: props.inputActions,
        }) : null,
      ])
    }

    const CSS = `
.rg-root { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 2px 0 4px; font-size: 12px; line-height: 1.4; color: var(--dsw-alias-label-primary); }
.rg-pill { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; max-width: 100%; height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer; transition: border-color 120ms ease, background 120ms ease; }
.rg-pill:hover { border-color: var(--dsw-alias-border-l2); }
.rg-pill-active { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l1)); }
.rg-pill-open { background: var(--dsw-alias-bg-layer-2); }
.rg-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 10%, transparent); }
.rg-label { color: var(--dsw-alias-label-secondary); }
.rg-name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.rg-pending { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.rg-warn { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-bg-base); font-size: 10px; font-weight: 700; }
.rg-chevron { display: inline-flex; color: var(--dsw-alias-label-secondary); }
.rg-panel { position: relative; display: flex; flex-direction: column; gap: 2px; width: min(440px, 100%); max-height: 320px; overflow: auto; padding: 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-overlay); box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
.rg-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 6px 6px; }
.rg-panel-title { color: var(--dsw-alias-label-secondary); font-weight: 600; letter-spacing: 0.02em; }
.rg-panel-rev { color: var(--dsw-alias-label-secondary); font-size: 10px; opacity: 0.7; }
.rg-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.rg-row-wrap { display: flex; align-items: stretch; gap: 2px; }
.rg-row-wrap .rg-row { flex: 1 1 auto; min-width: 0; }
.rg-edit-btn { flex: 0 0 auto; width: 28px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 14px; cursor: pointer; }
.rg-edit-btn:hover { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
.rg-edit-btn:disabled { opacity: 0.55; cursor: default; }
.rg-row:hover { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l1); }
.rg-row-current { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l1); }
.rg-row-error .rg-row-meta { color: var(--dsw-alias-state-error-primary); }
.rg-row-draft .rg-row-meta { color: var(--dsw-alias-label-secondary); }
.rg-row-main { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; gap: 1px; }
.rg-row-titleline { display: flex; align-items: center; gap: 6px; min-width: 0; }
.rg-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.rg-row-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.rg-badge-draft { flex: 0 0 auto; padding: 1px 5px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); color: var(--dsw-alias-state-warn-primary); font-size: 10px; font-weight: 600; }
.rg-hint { padding: 8px; color: var(--dsw-alias-label-secondary); }
.rg-panel-footer { display: flex; gap: 6px; flex-wrap: wrap; padding: 6px 4px 2px; border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 4px; }
.rg-panel-footer-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.rg-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 26px; padding: 3px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer; }
.rg-btn:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.rg-btn:disabled { opacity: 0.55; cursor: default; }
.rg-btn-primary { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.rg-btn-primary:hover { background: var(--dsw-alias-brand-primary); }
.rg-warning { margin-top: 4px; padding: 6px 8px; border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color: var(--dsw-alias-state-warn-primary); font-size: 11px; }
.rg-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; padding: 6px 8px; border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); font-size: 11px; }
.rg-retry { border: 1px solid currentColor; border-radius: 6px; background: transparent; color: inherit; font: inherit; padding: 2px 6px; cursor: pointer; }
.rg-overlay { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,0.44); }
.rg-editor { display: flex; flex-direction: column; gap: 10px; width: min(720px, 100%); max-height: min(86vh, 900px); overflow: auto; padding: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: 0 24px 64px rgba(0,0,0,0.28); font-size: 12px; }
.rg-editor-head { display: flex; align-items: center; gap: 8px; }
.rg-editor-title { flex: 1 1 auto; font-size: 14px; }
.rg-icon-btn { width: 24px; height: 24px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 16px; line-height: 1; cursor: pointer; }
.rg-editor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.rg-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.rg-field-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.rg-input, .rg-textarea { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; }
.rg-input:disabled { opacity: 0.6; }
.rg-textarea { resize: vertical; min-height: 90px; font-family: inherit; }
.rg-editor-flags { display: flex; gap: 16px; flex-wrap: wrap; }
.rg-inline-check { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.rg-check-list { display: flex; flex-direction: column; gap: 1px; max-height: 180px; overflow: auto; padding: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); }
.rg-check-list-short { max-height: 120px; }
.rg-check-row { display: flex; align-items: center; gap: 8px; padding: 3px 6px; border-radius: 6px; cursor: pointer; }
.rg-check-row:hover { background: var(--dsw-alias-bg-layer-1); }
.rg-check-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rg-scope { margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 10px; }
.rg-editor-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; padding-top: 4px; border-top: 1px solid var(--dsw-alias-border-l1); }
`

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : (key) => zh[key] ?? key
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'role-gate: dictionaries')
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'role-gate',
          order: 20,
        }, (props) => h(IdentityDock, { ...props, t })))
        ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options',
          id: 'role-gate-hero',
          order: 100,
        }, () => h(NewSessionIdentity, { t })))
      },
    }
  },
})
