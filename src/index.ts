/**
 * Archive retention (`dsh-archive-retention`): periodic physical cleanup of
 * archived conversation records with a page-configurable retention window.
 *
 * Two cleanup scopes, both opt-out:
 * 1. `sessions-archive/` — the physical archive pile (manual archives land
 *    here). Dirs whose latest artifact write predates the retention window
 *    are deleted.
 * 2. Page-archived sessions (the GUI registry-global `archivedSessionIds`
 *    set) — archiving hides a conversation but its record still loads into
 *    `session.list`; after the retention window the record is physically
 *    deleted, making the archive a grace period rather than a forever-pile.
 *    Attached (in-memory) sessions are never touched, whatever their age.
 *
 * Retention knobs live in the `archive-retention` settings namespace, edited
 * from the web Settings → 插件 page card (host half registers the section via
 * installSettingsSection; client half renders the card into the
 * `settings.plugin.item` slot).
 *
 * Safety rails carried over from the validated manual practice
 * (2026-08-26, 505 dirs / 627MB, zero incidents): per-directory re-check of
 * the latest artifact mtime immediately before each delete; running/attached
 * sessions excluded; every sweep lands a manifest under
 * `sessions-archive/_manifests/`.
 * @module @momojie-s/dsh-archive-retention
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import cronParser from 'cron-parser'
import type { parseExpression } from 'cron-parser'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer' // ctx.interval
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-workspace' // ctx.workspaceRegistry type merge
import type {} from '@deepseek-ai/dsh-session' // ctx.sessions type merge

export const name = 'dsh-archive-retention'
export const inject = ['timer', 'workspaceRegistry', 'sessions', 'settings']

/**
 * Page-editable settings namespace. 0.1.2-rc.1 dropped the
 * `settingsNamespace` brand helper — namespaces are now plain
 * lowercase-kebab strings validated by the settings service.
 */
export const SETTINGS_NS = 'archive-retention'

/**
 * Structural face of the settings service's `installSection` method
 * (0.1.2-rc.1). The locally installed `@deepseek-ai/dsh-settings` is still
 * 0.1.1-rc.2, whose `SettingsProvider` only declares the removed free
 * function — this bridge lets the plugin compile here while calling the
 * service method that exists at runtime on 0.1.2-rc.1+.
 */
interface SettingsSectionInstaller {
  installSection<const NS extends string, T>(
    owner: Context,
    ns: NS,
    schema: z<T>,
    entry: T,
    hooks: { setSource(current: () => T): void; onChange(): void },
  ): void
}

/** Default sweep schedule: once a day at 04:00. */
export const DEFAULT_SWEEP_CRON = '0 4 * * *'

export interface Config {
  /** Master switch for the periodic sweep (default true). */
  enabled?: boolean
  /** Retention amount; pairs with `retentionUnit` (default 7). */
  retentionValue?: number
  /** Retention unit: `days` (default) or `hours`. */
  retentionUnit?: 'days' | 'hours'
  /** Sweep the physical `sessions-archive/` pile (default true). */
  cleanSessionsArchive?: boolean
  /** Physically delete page-archived (GUI archive set) session records past retention (default true). */
  cleanGuiArchived?: boolean
  /** 5-field cron expression driving the sweep (default `0 4 * * *` — daily 04:00). */
  sweepCron?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  retentionValue: z.number().min(1).default(7),
  retentionUnit: z.union(['days', 'hours']).default('days'),
  cleanSessionsArchive: z.boolean().default(true),
  cleanGuiArchived: z.boolean().default(true),
  sweepCron: z.string().default(DEFAULT_SWEEP_CRON),
})

/** Convert a retention amount + unit into milliseconds. */
export function retentionToMs(value: number, unit: 'days' | 'hours'): number {
  return value * (unit === 'hours' ? 3_600_000 : 86_400_000)
}

/**
 * Whether a cron fire came due in (sinceMs, nowMs]: true when the expression's
 * latest occurrence at-or-before `nowMs` is strictly after `sinceMs`. A parse
 * failure answers false — the caller logs and keeps the last good schedule.
 */
export function cronDueSince(expr: string, sinceMs: number, nowMs: number): boolean {
  try {
    // cron-parser is CommonJS: resolve parseExpression off the interop default,
    // which carries the named exports under Node ESM.
    const mod = cronParser as unknown as { parseExpression?: typeof parseExpression; default?: { parseExpression: typeof parseExpression } }
    const parse = mod.parseExpression ?? mod.default?.parseExpression
    if (parse === undefined) return false
    const prev = parse(expr, { currentDate: new Date(nowMs) }).prev().getTime()
    return prev > sinceMs && prev <= nowMs
  } catch {
    return false
  }
}

/** Cheap structural cron check for page-side validation (full check is host-side). */
export function isPlausibleCron(expr: string): boolean {
  return /^[\d*,\-/\s]+$/.test(expr.trim()) && expr.trim().split(/\s+/).length >= 5
}

// ---------------------------------------------------------------------------
// Pure planning core (exported for unit tests)
// ---------------------------------------------------------------------------

/** One retention candidate: a session directory plus its latest write time. */
export interface RetentionCandidate {
  readonly id: string
  readonly scope: 'archive-dir' | 'gui-archived'
  /** Latest artifact mtime in ms; `undefined` when the directory has no files. */
  readonly lastWriteMs: number | undefined
  /** True when the session is still attached to the live store (never delete). */
  readonly attached: boolean
}

export type RetentionSkipReason = 'empty-dir' | 'attached' | 'within-retention'

export interface RetentionPlanEntry {
  readonly id: string
  readonly eligible: boolean
  readonly skipReason: RetentionSkipReason | undefined
}

/**
 * Decide retention eligibility, pure and total: a candidate goes when its
 * latest write predates `cutoffMs`, unless it is attached (in-memory) or
 * carries no files at all.
 */
export function planRetention(candidates: readonly RetentionCandidate[], nowMs: number, cutoffMs: number): RetentionPlanEntry[] {
  return candidates.map(candidate => {
    if (candidate.attached) return { id: candidate.id, eligible: false, skipReason: 'attached' as const }
    if (candidate.lastWriteMs === undefined) return { id: candidate.id, eligible: false, skipReason: 'empty-dir' as const }
    if (candidate.lastWriteMs >= cutoffMs) return { id: candidate.id, eligible: false, skipReason: 'within-retention' as const }
    void nowMs
    return { id: candidate.id, eligible: true, skipReason: undefined }
  })
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Latest mtime + total size over every file under dir (recursive). */
async function probeDir(dir: string): Promise<{ lastWriteMs: number | undefined; sizeBytes: number }> {
  let latest: number | undefined
  let total = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        const info = await stat(full)
        total += info.size
        if (latest === undefined || info.mtimeMs > latest) latest = info.mtimeMs
      } catch {
        // raced away: ignore
      }
    }
  }
  return { lastWriteMs: latest, sizeBytes: total }
}

/** Re-check the artifact right before acting; false when it moved or got rewritten. */
async function stillQuiescent(dir: string, plannedLastWriteMs: number | undefined): Promise<boolean> {
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) return false
    const artifact = join(dir, 'session.jsonl.zstd')
    if (existsSync(artifact)) {
      const art = await stat(artifact)
      if (plannedLastWriteMs !== undefined && art.mtimeMs > plannedLastWriteMs) return false
    }
    return true
  } catch {
    return false
  }
}

interface SweepOutcome {
  enabled: boolean
  scannedArchiveDir: number
  scannedGuiArchived: number
  deleted: number
  freedBytes: number
  failures: number
  failureDetails: string[]
  skippedAttached: number
  manifestPath: string | null
}

export function apply(ctx: Context, config: Config): void {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const archiveRoot = join(home, 'sessions-archive')
  const sessionsRoot = join(home, 'sessions')

  // The settings section's source is a thunk returning the resolved section;
  // normalize optionality with defaults for the sweep's reads.
  const withDefaults = (c: Config): Required<Config> => ({
    enabled: c.enabled ?? true,
    retentionValue: c.retentionValue ?? 7,
    retentionUnit: c.retentionUnit ?? 'days',
    cleanSessionsArchive: c.cleanSessionsArchive ?? true,
    cleanGuiArchived: c.cleanGuiArchived ?? true,
    sweepCron: c.sweepCron ?? DEFAULT_SWEEP_CRON,
  })
  let current: () => Config = () => config

  // Page edits land in the settings store; the sweep reads `current()` each run.
  // 0.1.2-rc.1 removed the `installSettingsSection` free function; the wiring
  // now goes through the settings service's `installSection` method.
  ;(ctx.settings as unknown as SettingsSectionInstaller).installSection(ctx, SETTINGS_NS, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {
      const c = current()
      ctx.logger.info(
        `archive-retention: settings updated (enabled=${c.enabled}, retention=${c.retentionValue}${c.retentionUnit === 'hours' ? 'h' : 'd'}, ` +
        `archiveDir=${c.cleanSessionsArchive}, guiArchived=${c.cleanGuiArchived})`,
      )
    },
  })

  const registry = ctx as unknown as {
    workspaceRegistry: { archivedSessionIds: readonly string[] }
    sessions: { get(id: string): unknown }
  }

  /** Latest write probe for one session dir; undefined when missing. */
  async function locate(id: string): Promise<{ dir: string; probe: { lastWriteMs: number | undefined; sizeBytes: number } } | undefined> {
    let workspaces: string[] = []
    try {
      workspaces = (await readdir(sessionsRoot, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
    } catch {
      return undefined
    }
    for (const ws of workspaces) {
      const dir = join(sessionsRoot, ws, id)
      if (existsSync(dir)) return { dir, probe: await probeDir(dir) }
    }
    return undefined
  }

  async function sweep(): Promise<SweepOutcome> {
    const outcome: SweepOutcome = {
      enabled: false, scannedArchiveDir: 0, scannedGuiArchived: 0, deleted: 0,
      freedBytes: 0, failures: 0, failureDetails: [], skippedAttached: 0, manifestPath: null,
    }
    const cfg = withDefaults(current())
    if (!cfg.enabled) return outcome
    const now = Date.now()
    const cutoff = now - retentionToMs(cfg.retentionValue, cfg.retentionUnit)
    const deletedList: { id: string; from: string; sizeBytes: number }[] = []

    // ---- scope 1: physical sessions-archive pile ----
    if (cfg.cleanSessionsArchive) {
      let workspaces: string[] = []
      try {
        workspaces = (await readdir(archiveRoot, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
      } catch { /* no archive root yet */ }
      for (const ws of workspaces) {
        let ids: string[] = []
        try {
          ids = (await readdir(join(archiveRoot, ws), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
        } catch { continue }
        for (const id of ids) {
          outcome.scannedArchiveDir += 1
          const dir = join(archiveRoot, ws, id)
          const probe = await probeDir(dir)
          const [verdict] = planRetention(
            [{ id, scope: 'archive-dir', lastWriteMs: probe.lastWriteMs, attached: false }],
            now, cutoff,
          )
          if (verdict.eligible !== true) continue
          if (!(await stillQuiescent(dir, probe.lastWriteMs))) continue
          try {
            await rm(dir, { recursive: true, force: true })
            outcome.deleted += 1
            outcome.freedBytes += probe.sizeBytes
            deletedList.push({ id, from: join('sessions-archive', ws), sizeBytes: probe.sizeBytes })
          } catch (error) {
            outcome.failures += 1
            outcome.failureDetails.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    }

    // ---- scope 2: page-archived (GUI archive set) session records ----
    if (cfg.cleanGuiArchived) {
      let archived: readonly string[] = []
      try {
        archived = registry.workspaceRegistry.archivedSessionIds
      } catch (error) {
        outcome.failureDetails.push(`registry: ${error instanceof Error ? error.message : String(error)}`)
      }
      for (const id of archived) {
        if (registry.sessions.get(id) !== undefined) { outcome.skippedAttached += 1; continue }
        const located = await locate(id)
        if (located === undefined) continue // already gone
        outcome.scannedGuiArchived += 1
        const [verdict] = planRetention(
          [{ id, scope: 'gui-archived', lastWriteMs: located.probe.lastWriteMs, attached: false }],
          now, cutoff,
        )
        if (verdict.eligible !== true) continue
        if (!(await stillQuiescent(located.dir, located.probe.lastWriteMs))) continue
        try {
          await rm(located.dir, { recursive: true, force: true })
          outcome.deleted += 1
          outcome.freedBytes += located.probe.sizeBytes
          deletedList.push({ id, from: 'sessions', sizeBytes: located.probe.sizeBytes })
        } catch (error) {
          outcome.failures += 1
          outcome.failureDetails.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    if (outcome.deleted > 0) {
      try {
        const manifestDir = join(archiveRoot, '_manifests')
        await mkdir(manifestDir, { recursive: true })
        const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
        const manifestPath = join(manifestDir, `retention-${stamp}.json`)
        await writeFile(manifestPath, JSON.stringify({
          createdAt: new Date(now).toISOString(),
          retention: `${cfg.retentionValue} ${cfg.retentionUnit}`,
          deleted: deletedList,
        }, null, 2), 'utf8')
        outcome.manifestPath = manifestPath
      } catch (error) {
        outcome.failureDetails.push(`manifest: ${error instanceof Error ? error.message : String(error)}`)
      }
      ctx.logger.info(
        `archive-retention: deleted ${outcome.deleted} record(s), freed ${(outcome.freedBytes / 1e6).toFixed(1)}MB ` +
        `(retention ${cfg.retentionValue}${cfg.retentionUnit === 'hours' ? 'h' : 'd'})`,
      )
    }
    return outcome
  }

  // Cron-driven scheduling: a 30s ticker checks whether the expression's
  // latest occurrence came due since the last sweep; sweeper fires at most
  // once per due window and never concurrently with itself.
  let lastSweepAt = Date.now()
  let sweeping = false
  ctx.interval(() => {
    if (sweeping) return
    const cfg = withDefaults(current())
    if (!cfg.enabled) { lastSweepAt = Date.now(); return }
    const now = Date.now()
    if (!cronDueSince(cfg.sweepCron, lastSweepAt, now)) return
    lastSweepAt = now
    sweeping = true
    void sweep().catch((error) => {
      ctx.logger.warn(`archive-retention: sweep failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { sweeping = false })
  }, 30_000)

  const active = withDefaults(current())
  ctx.logger.info(
    `archive-retention: active (retention ${active.retentionValue}${active.retentionUnit === 'hours' ? 'h' : 'd'}, cron "${active.sweepCron}", ns "${String(SETTINGS_NS)}")`,
  )
}
