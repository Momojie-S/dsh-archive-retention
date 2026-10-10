/**
 * dsh-archive-retention — web client half (bundle body).
 *
 * Registers the configuration form for the bundle's `archive-retention` row
 * into the Plugins page's `plugins.row.config` slot (dsh 0.2.0 mechanism).
 * The page owner hands the card `props.form` — `state` (a ConfigFormSnapshot
 * over the `archive-retention` entry namespace) and `mutate(ops, revision)` —
 * so no direct settings/configForms wiring is needed here.
 *
 * Staged-edit UX mirroring the official plugin cards: edits stage locally,
 * Save writes all fields through one atomic mutate, Discard drops them.
 * React arrives through the module-table require injected by the loader
 * factory wrapper (see scripts/build.mjs).
 */

const react = require('react')
const { createElement: h, useState } = react

const NS = 'archive-retention'
const ROW_KEY = '@momojie-s/dsh-archive-retention#archive-retention'

const inject = ['slots']

const FIELDS = [
  { field: 'enabled', kind: 'bool', label: '启用定期清扫', hint: '总开关（默认开）' },
  { field: 'cleanSessionsArchive', kind: 'bool', label: '清理物理归档堆', hint: 'sessions-archive/ 下超期目录（默认开）' },
  { field: 'cleanGuiArchived', kind: 'bool', label: '清理页面归档会话', hint: 'GUI 归档名单中超期记录（默认开）' },
  { field: 'cleanOrphanSubagents', kind: 'bool', label: '清理孤儿子 agent', hint: '父会话目录已消失的超期子 agent 目录（默认开）' },
  { field: 'retentionValue', kind: 'number', label: '保留期数值', hint: '配合单位，默认 7' },
  { field: 'retentionUnit', kind: 'unit', label: '保留期单位', hint: 'days / hours，默认 days' },
  { field: 'sweepCron', kind: 'cron', label: '清扫节奏 (cron)', hint: '5 字段，默认 0 4 * * *（每天 04:00）' },
]

function labelFor(field) {
  const meta = FIELDS.find(f => f.field === field)
  return meta ? meta.label : field
}

function ArchiveRetentionCard(props) {
  const view = props.view
  if (view === 'summary') {
    return h('p', null, '归档会话定期清理：保留期（默认 7 天）、清扫范围与节奏。')
  }
  const form = props.form
  const [drafts, setDrafts] = useState({})
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  if (form === undefined) {
    return h('p', null, '配置页暂不可用（表单服务未就绪或非本地访问）。')
  }
  const snap = form.state
  const values = (snap && snap.value) || {}
  const writable = snap && snap.writable
  const userLayer = (snap && snap.user) || {}
  const dirty = Object.keys(drafts).length > 0

  const stage = (field, value) => {
    setFailed(false)
    setDrafts(prev => {
      const next = { ...prev }
      if (value === undefined) delete next[field]
      else next[field] = value
      return next
    })
  }
  const effective = (field) => (Object.prototype.hasOwnProperty.call(drafts, field) ? drafts[field] : values[field])

  const save = async () => {
    if (!dirty || busy) return
    setBusy(true)
    setFailed(false)
    try {
      const ops = Object.entries(drafts).map(([field, value]) => (
        value === null
          ? { op: 'unset', path: [field] }
          : { op: 'set', path: [field], value }
      ))
      const ok = await form.mutate(ops, snap.revision)
      if (ok) setDrafts({})
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  const discard = () => { setDrafts({}); setFailed(false) }

  const controls = FIELDS.map(({ field, kind, label, hint }) => {
    const overridden = Object.prototype.hasOwnProperty.call(userLayer, field)
    const common = { key: field, style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' } }
    if (kind === 'bool') {
      const checked = effective(field) !== false && effective(field) !== undefined ? effective(field) === true : true
      return h('label', common,
        h('input', {
          type: 'checkbox',
          checked,
          disabled: !writable,
          onChange: (e) => stage(field, e.target.checked),
        }),
        label,
        h('small', { style: { color: '#888' } }, hint),
        overridden ? h('button', {
          type: 'button', disabled: !writable, onClick: () => stage(field, null),
          style: { marginLeft: 'auto' }, title: '恢复默认',
        }, '↺') : null,
      )
    }
    if (kind === 'unit') {
      const value = effective(field) || 'days'
      return h('label', common,
        label + '：',
        h('select', {
          value, disabled: !writable,
          onChange: (e) => stage(field, e.target.value),
        },
          h('option', { value: 'days' }, '天 (days)'),
          h('option', { value: 'hours' }, '小时 (hours)')),
        h('small', { style: { color: '#888' } }, hint),
      )
    }
    const value = effective(field)
    const text = value === undefined || value === null ? '' : String(value)
    return h('label', { ...common, style: { ...common.style, display: 'grid', gridTemplateColumns: '160px 1fr', alignItems: 'center' } },
      label + '：',
      h('input', {
        type: 'text', value: text, disabled: !writable,
        onChange: (e) => stage(field, kind === 'number' ? (e.target.value.trim() === '' ? null : Number(e.target.value)) : e.target.value),
        style: { maxWidth: '220px' },
      }),
      h('small', { style: { gridColumn: '2', color: '#888' } }, hint),
    )
  })

  return h('div', null,
    ...controls,
    h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'center' } },
      h('button', { type: 'button', disabled: !writable || !dirty || busy, onClick: save }, busy ? '保存中…' : '保存'),
      h('button', { type: 'button', disabled: !dirty || busy, onClick: discard }, '放弃修改'),
      failed ? h('span', { style: { color: '#c33' } }, '保存被拒绝：值未通过校验或已过期，请刷新后重试') : null,
      !writable ? h('span', { style: { color: '#888' } }, '当前页面只读') : null,
    ),
  )
}

function apply(ctx) {
  ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: ROW_KEY,
  }, ArchiveRetentionCard)), 'dsh-archive-retention: row config page')
}

module.exports = { name: 'dsh-archive-retention/client', inject, apply }
