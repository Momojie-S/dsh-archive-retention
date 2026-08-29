/**
 * dsh-archive-retention — web client half (bundle body).
 *
 * Renders one card into the `settings.plugin.item` slot (Settings → 插件 →
 * 可配置), bound to the `archive-retention` settings namespace the host half
 * registers. React arrives through the module-table require injected by the
 * loader factory wrapper; slots/settingsScope arrive as injected services.
 *
 * The form is a mini staged editor: edits stage locally, a save writes them
 * through the settings scope, discard drops them — mirroring the official
 * plugin cards' staged-edit UX without importing their internal kit.
 */

const react = require('react')
const { createElement: h, useSyncExternalStore, useState } = react

const NS = 'archive-retention'

const inject = ['slots', 'settingsScope']

// Concatenated bundle: exports become module.exports assignments (the loader
// factory's stripped-export convention — see scripts/build.mjs).
function apply(ctx) {  const scope = ctx.settingsScope.bind({ namespace: NS })

  // ---- staged form state (module-local; one card instance per page) ----
  let state = {
    available: false, writable: false, dirty: false, saving: false, failed: false,
    values: {},        // effective values from the scope snapshot
    drafts: {},        // staged edits (actual typed values, not text)
  }
  const listeners = new Set()
  const publish = () => { state = { ...state, recompute: (state.recompute ?? 0) + 1 }; for (const l of listeners) l() }
  const store = {
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    getSnapshot: () => state,
  }

  const refresh = () => {
    const snap = scope.getSnapshot()
    const values = (snap.value ?? {})
    // drop drafts whose value now equals the stored effective value
    for (const [k, v] of Object.entries(state.drafts)) {
      if (values[k] === v) delete state.drafts[k]
    }
    state = {
      ...state,
      available: snap.status === 'ready',
      writable: snap.writable === true,
      values,
      dirty: Object.keys(state.drafts).length > 0,
    }
    publish()
  }
  scope.subscribe(refresh)
  refresh()

  const stage = (field, value) => {
    state.drafts[field] = value
    state.failed = false
    state.dirty = true
    publish()
  }
  const discard = () => {
    state.drafts = {}
    state.failed = false
    state.dirty = false
    publish()
  }
  const save = async () => {
    if (!state.dirty || state.saving) return
    state.saving = true
    state.failed = false
    publish()
    let landed = true
    try {
      for (const [field, value] of Object.entries(state.drafts)) {
        await scope.set(field, value)
        if (scope.getSnapshot().value?.[field] !== value) landed = false
      }
    } catch { landed = false }
    state.saving = false
    if (landed) { state.drafts = {}; state.dirty = false } else { state.failed = true }
    refresh()
  }

  // ---- card state projection ----
  const effective = (field) => {
    if (Object.hasOwn(state.drafts, field)) return { value: state.drafts[field], overridden: true }
    const v = state.values[field]
    return { value: v, overridden: false }
  }

  // ---- card component (registered into settings.plugin.item) ----
  const btn = { padding: '4px 12px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #444)',
    background: 'var(--dsw-alias-interactive-bg, transparent)', color: 'inherit', cursor: 'pointer', fontSize: 12 }
  const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', fontSize: 13 }

  function RetentionCard() {
    const s = useSyncExternalStore(store.subscribe, store.getSnapshot)
    if (!s.available) return null
    const enabled = effective('enabled')
    const valueFld = effective('retentionValue')
    const unitFld = effective('retentionUnit')
    const cleanArchive = effective('cleanSessionsArchive')
    const cleanGui = effective('cleanGuiArchived')
    const cronFld = effective('sweepCron')
    const disabled = !s.writable || s.saving
    const checkbox = (field, checked, label, hint) => h('label', { style: { ...rowStyle, cursor: disabled ? 'default' : 'pointer' } },
      h('input', {
        type: 'checkbox', checked: checked === true, disabled,
        onChange: (e) => { if (!disabled) stage(field, e.target.checked) },
      }),
      h('span', null,
        label,
        hint ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #888)', marginLeft: 6, fontSize: 12 } }, hint) : null),
      enabledOrOverriddenMark(checked, s, field),
    )
    return h('li', { style: { listStyle: 'none', border: '1px solid var(--dsw-alias-border-l1, #333)', borderRadius: 10, padding: '10px 14px', margin: '8px 0' } },
      h('div', { style: { fontWeight: 600, fontSize: 13 } }, '归档自动清理'),
      h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12, margin: '2px 0 8px' } },
        '超过保留期的归档会话记录会被定期物理删除;页面归档的会话满保留期后同样删除。'),
      checkbox('enabled', enabled.value, '启用定期清理', '关闭后保留现状,不再删除'),
      h('div', { style: rowStyle },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          '保留',
          h('input', {
            type: 'number', min: 1, disabled,
            value: typeof valueFld.value === 'number' ? String(valueFld.value) : '',
            style: { width: 72, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #444)', background: 'transparent', color: 'inherit' },
            onChange: (e) => {
              const n = Number(e.target.value)
              if (e.target.value !== '' && Number.isFinite(n) && n >= 1) stage('retentionValue', n)
            },
          }),
          h('select', {
            disabled,
            value: typeof unitFld.value === 'string' ? unitFld.value : 'days',
            style: { padding: '3px 6px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #444)', background: 'transparent', color: 'inherit' },
            onChange: (e) => { if (!disabled) stage('retentionUnit', e.target.value) },
          },
            h('option', { value: 'days' }, '天'),
            h('option', { value: 'hours' }, '小时'),
          ),
        ),
        valueFld.overridden || unitFld.overridden ? overrideMark(s) : null,
      ),
      checkbox('cleanSessionsArchive', cleanArchive.value, '清理物理归档堆', 'sessions-archive 里超期的归档目录'),
      checkbox('cleanGuiArchived', cleanGui.value, '清理页面归档的会话', '页面上归档的会话满保留期后物理删除'),
      h('div', { style: rowStyle },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          '清扫节奏(cron)',
          h('input', {
            type: 'text', disabled,
            value: typeof cronFld.value === 'string' ? cronFld.value : '',
            placeholder: '0 4 * * *',
            style: { width: 130, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #444)', background: 'transparent', color: 'inherit', fontFamily: 'monospace' },
            onChange: (e) => { if (!disabled) stage('sweepCron', e.target.value) },
          }),
        ),
        cronFld.overridden ? overrideMark() : null,
      ),
      h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 11, margin: '-2px 0 4px' } },
        '5 段 cron 表达式(分 时 日 月 周);默认 0 4 * * * = 每天凌晨 4 点。保存时由宿主校验,非法表达式拒绝写入。'),
      h('div', { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' } },
        h('button', { style: btn, disabled: !s.dirty || s.saving || disabled,
          onClick: () => { void save() } }, s.saving ? '保存中…' : '保存'),
        h('button', { style: btn, disabled: !s.dirty || s.saving,
          onClick: () => { discard() } }, '放弃修改'),
        s.failed ? h('span', { style: { color: 'var(--dsw-alias-label-danger, #e5484d)', fontSize: 12 } }, '保存未生效,请重试') : null,
        s.dirty && !s.saving ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12 } }, '有未保存的修改') : null,
      ),
    )
  }

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'archive-retention',
      key: 'archive-retention', // keyed slot: options.key is mandatory (gate-4 lesson)
      order: 30,
      inject: () => ({ hooks: { card: store }, save, discard }),
    }, RetentionCard)
  })

  ctx.logger.info('archive-retention: settings card registered')
}

// Concatenated-bundle export surface (the loader factory reads module.exports).
module.exports = { name: 'dsh-archive-retention-client', inject, apply }

function enabledOrOverriddenMark() { return null }

function overrideMark() {
  return h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 11 } }, '(已覆盖默认)')
}
