/**
 * Archive retention (`dsh-archive-retention`): periodic physical cleanup of
 * archived conversation records with a page-configurable retention window.
 *
 * Three cleanup scopes, all opt-out:
 * 1. `sessions-archive/` — the physical archive pile (manual archives land
 *    here). Dirs whose latest artifact write predates the retention window
 *    are deleted.
 * 2. Page-archived sessions (the GUI registry-global `archivedSessionIds`
 *    set) — archiving hides a conversation but its record still loads into
 *    `session.list`; after the retention window the record is physically
 *    deleted, making the archive a grace period rather than a forever-pile.
 *    Attached (in-memory) sessions are never touched, whatever their age.
 * 3. Orphaned subagent directories — subagent session dirs under `sessions/`
 *    whose `parentSession` no longer resolves to any session directory on
 *    disk (the parent was deleted by scopes 1/2, a manual cleanup, or
 *    anything else). The UI offers no way to archive these dirs, so without
 *    this scope they accumulate forever and re-inflate `session.list`.
 *    Children of a parent deleted in this sweep are picked up in the same
 *    pass; a parent still on disk (grace period) keeps its children until
 *    the parent physically goes.
 *
 * Retention knobs are volatile Config fields (dsh 0.2.0 immediate config
 * forms): each is declared `.volatile()` in the schema and edited from the
 * web Plugins page form of this bundle's entry; page edits persist in the
 * settings store and apply live via the config editor's HMR, no client half
 * and no settings-namespace registration needed.
 *
 * Safety rails carried over from the validated manual practice
 * (2026-08-26, 505 dirs / 627MB, zero incidents): per-directory re-check of
 * the latest artifact mtime immediately before each delete; running/attached
 * sessions excluded; every sweep lands a manifest under
 * `sessions-archive/_manifests/`.
 * @module @momojie-s/dsh-archive-retention
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import cronParser from 'cron-parser'
import type { parseExpression } from 'cron-parser'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer' // ctx.interval
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-workspace' // ctx.workspaceRegistry type merge
import type {} from '@deepseek-ai/dsh-session' // ctx.sessions type merge

export const name = 'dsh-archive-retention'
export const inject = ['timer', 'workspaceRegistry', 'sessions']

/** Default sweep schedule: once a day at 04:00. */
export const DEFAULT_SWEEP_CRON = '0 4 * * *'

export interface Config {
  /** Master switch for the periodic sweep (default true). */
  enabled: Volatile<boolean | undefined>
  /** Retention amount; pairs with `retentionUnit` (default 7). */
  retentionValue: Volatile<number | undefined>
  /** Retention unit: `days` (default) or `hours`. */
  retentionUnit: Volatile<'days' | 'hours' | undefined>
  /** Sweep the physical `sessions-archive/` pile (default true). */
  cleanSessionsArchive: Volatile<boolean | undefined>
  /** Physically delete page-archived (GUI archive set) session records past retention (default true). */
  cleanGuiArchived: Volatile<boolean | undefined>
  /**
   * Physically delete orphaned subagent directories past retention: subagent
   * dirs whose `parentSession` no longer resolves to any session directory on
   * disk (default true).
   */
  cleanOrphanSubagents: Volatile<boolean | undefined>
  /** 5-field cron expression driving the sweep (default `0 4 * * *` — daily 04:00). */
  sweepCron: Volatile<string | undefined>
}

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  retentionValue: z.number().min(1).default(7).volatile(),
  retentionUnit: z.union(['days', 'hours']).default('days').volatile(),
  cleanSessionsArchive: z.boolean().default(true).volatile(),
  cleanGuiArchived: z.boolean().default(true).volatile(),
  cleanOrphanSubagents: z.boolean().default(true).volatile(),
  sweepCron: z.string().default(DEFAULT_SWEEP_CRON).volatile(),
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

export type RetentionSkipReason = 'empty-dir' | 'attached' | 'within-retention' | 'parent-alive'

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

/** One orphan-subagent candidate: a session dir whose header names a parent. */
export interface OrphanCandidate {
  readonly id: string
  /** Session id of the parent recorded in the dir's header. */
  readonly parentSession: string
  readonly lastWriteMs: number | undefined
  readonly attached: boolean
}

/**
 * Decide orphan-subagent eligibility, pure and total: a subagent directory
 * goes when its parent no longer exists on disk (`existingIds` — directory
 * names are session ids) and its latest write predates `cutoffMs`. A parent
 * still on disk keeps its children whatever their age; the parent's own
 * scopes decide when the family goes.
 */
export function planOrphans(candidates: readonly OrphanCandidate[], existingIds: ReadonlySet<string>, cutoffMs: number): RetentionPlanEntry[] {
  return candidates.map(candidate => {
    if (candidate.attached) return { id: candidate.id, eligible: false, skipReason: 'attached' as const }
    if (candidate.lastWriteMs === undefined) return { id: candidate.id, eligible: false, skipReason: 'empty-dir' as const }
    if (candidate.lastWriteMs >= cutoffMs) return { id: candidate.id, eligible: false, skipReason: 'within-retention' as const }
    if (existingIds.has(candidate.parentSession)) return { id: candidate.id, eligible: false, skipReason: 'parent-alive' as const }
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

/**
 * Read { id, parentSession } from a session dir's zstd JSONL header.
 * Undefined on any failure — callers must treat unreadable headers as
 * "no parent information" and never delete on that basis.
 */
function readSessionHeader(dir: string): { parentSession?: string } | undefined {
  try {
    const artifact = join(dir, 'session.jsonl.zstd')
    if (!existsSync(artifact)) return undefined
    const firstLine = zstdDecompressSync(readFileSync(artifact)).toString('utf8').split('\n')[0]
    const header = JSON.parse(firstLine)
    if (typeof header !== 'object' || header === null) return undefined
    return { parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined }
  } catch {
    return undefined
  }
}

interface SweepOutcome {
  enabled: boolean
  scannedArchiveDir: number
  scannedGuiArchived: number
  scannedOrphans: number
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

  // Resolved (defaults applied) shape of the volatile Config fields.
  interface ResolvedConfig {
    enabled: boolean
    retentionValue: number
    retentionUnit: 'days' | 'hours'
    cleanSessionsArchive: boolean
    cleanGuiArchived: boolean
    cleanOrphanSubagents: boolean
    sweepCron: string
  }
  const withDefaults = (c: {
    enabled?: boolean
    retentionValue?: number
    retentionUnit?: 'days' | 'hours'
    cleanSessionsArchive?: boolean
    cleanGuiArchived?: boolean
    cleanOrphanSubagents?: boolean
    sweepCron?: string
  }): ResolvedConfig => ({
    enabled: c.enabled ?? true,
    retentionValue: c.retentionValue ?? 7,
    retentionUnit: c.retentionUnit ?? 'days',
    cleanSessionsArchive: c.cleanSessionsArchive ?? true,
    cleanGuiArchived: c.cleanGuiArchived ?? true,
    cleanOrphanSubagents: c.cleanOrphanSubagents ?? true,
    sweepCron: c.sweepCron ?? DEFAULT_SWEEP_CRON,
  })

  // The Plugins-page form edits land in the settings store and apply live
  // (config-editor volatile HMR); every sweep and the ticker read the
  // volatile getters fresh, so no cached copy is kept.
  const current = (): ResolvedConfig => withDefaults({
    enabled: config.enabled.get(),
    retentionValue: config.retentionValue.get(),
    retentionUnit: config.retentionUnit.get(),
    cleanSessionsArchive: config.cleanSessionsArchive.get(),
    cleanGuiArchived: config.cleanGuiArchived.get(),
    cleanOrphanSubagents: config.cleanOrphanSubagents.get(),
    sweepCron: config.sweepCron.get(),
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
      enabled: false, scannedArchiveDir: 0, scannedGuiArchived: 0, scannedOrphans: 0, deleted: 0,
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

    // ---- scope 3: orphaned subagent directories ----
    // A subagent dir whose parentSession no longer resolves to any session
    // directory on disk. Parents deleted in scopes 1/2 of this same sweep are
    // already absent here, so their children go in the same pass; a parent
    // still inside its grace period keeps its children until it physically
    // goes. Unreadable headers mean "no parent information": never delete.
    if (cfg.cleanOrphanSubagents) {
      let workspaces: string[] = []
      try {
        workspaces = (await readdir(sessionsRoot, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
      } catch { /* no sessions root yet */ }
      const existing = new Set<string>()
      const dirs: { ws: string; path: string; name: string }[] = []
      for (const ws of workspaces) {
        let names: string[] = []
        try {
          names = (await readdir(join(sessionsRoot, ws), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
        } catch { continue }
        for (const name of names) {
          existing.add(name)
          dirs.push({ ws, path: join(sessionsRoot, ws, name), name })
        }
      }
      for (const entry of dirs) {
        if (registry.sessions.get(entry.name) !== undefined) { outcome.skippedAttached += 1; continue }
        const probe = await probeDir(entry.path)
        const [cold] = planRetention(
          [{ id: entry.name, scope: 'archive-dir', lastWriteMs: probe.lastWriteMs, attached: false }],
          now, cutoff,
        )
        if (cold.eligible !== true) continue // warm dirs skip the header read entirely
        const header = readSessionHeader(entry.path)
        const parent = header?.parentSession
        if (typeof parent !== 'string' || parent.length === 0) continue
        outcome.scannedOrphans += 1
        const [verdict] = planOrphans(
          [{ id: entry.name, parentSession: parent, lastWriteMs: probe.lastWriteMs, attached: false }],
          existing, cutoff,
        )
        if (verdict.eligible !== true) continue
        if (!(await stillQuiescent(entry.path, probe.lastWriteMs))) continue
        try {
          await rm(entry.path, { recursive: true, force: true })
          outcome.deleted += 1
          outcome.freedBytes += probe.sizeBytes
          deletedList.push({ id: entry.name, from: join('sessions', entry.ws), sizeBytes: probe.sizeBytes })
        } catch (error) {
          outcome.failures += 1
          outcome.failureDetails.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
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

  const active = current()
  ctx.logger.info(
    `archive-retention: active (retention ${active.retentionValue}${active.retentionUnit === 'hours' ? 'h' : 'd'}, cron "${active.sweepCron}", volatile config)`,
  )
}
