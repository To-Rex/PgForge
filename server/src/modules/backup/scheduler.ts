import { Cron } from 'croner'
import type { BackupSchedule } from '@pgforge/shared'
import { BadRequestError } from '../../core/errors.js'
import { nowIso } from '../../core/util.js'
import type { AppContext } from '../../context.js'
import type { BackupRepo } from './backup.repo.js'
import type { BackupService } from './backup.service.js'

export function validateCron(expression: string): void {
  try {
    new Cron(expression, { paused: true }).stop()
  } catch {
    throw new BadRequestError(`Invalid cron expression: ${expression}`)
  }
}

export function nextRun(expression: string): string | null {
  return nextRuns(expression, 1)?.[0] ?? null
}

/** Next `count` fire times, or null when the expression is invalid. */
export function nextRuns(expression: string, count: number): string[] | null {
  try {
    const job = new Cron(expression, { paused: true })
    const runs = job.nextRuns(count).map((d) => d.toISOString())
    job.stop()
    return runs
  } catch {
    return null
  }
}

/** Owns one Croner instance per enabled schedule; reloads on any change. */
export class BackupScheduler {
  private readonly crons = new Map<string, Cron>()

  constructor(
    private readonly ctx: AppContext,
    private readonly repo: BackupRepo,
    private readonly service: BackupService,
    private readonly log: (msg: string) => void,
  ) {}

  start(): void {
    for (const schedule of this.repo.listSchedules()) {
      if (schedule.enabled) this.arm(schedule)
    }
  }

  sync(schedule: BackupSchedule): void {
    this.disarm(schedule.id)
    if (schedule.enabled) this.arm(schedule)
  }

  remove(scheduleId: string): void {
    this.disarm(scheduleId)
  }

  async runNow(scheduleId: string): Promise<void> {
    const schedule = this.repo.scheduleById(scheduleId)
    if (schedule) await this.trigger(schedule)
  }

  stop(): void {
    for (const cron of this.crons.values()) cron.stop()
    this.crons.clear()
  }

  private arm(schedule: BackupSchedule): void {
    try {
      const cron = new Cron(schedule.cron, { protect: true }, () => void this.trigger(schedule))
      this.crons.set(schedule.id, cron)
    } catch {
      this.log(`Schedule '${schedule.name}' has an invalid cron expression; skipped`)
    }
  }

  private disarm(scheduleId: string): void {
    this.crons.get(scheduleId)?.stop()
    this.crons.delete(scheduleId)
  }

  private async trigger(schedule: BackupSchedule): Promise<void> {
    // Re-read: settings may have changed since this cron was armed.
    const current = this.repo.scheduleById(schedule.id)
    if (!current || !current.enabled) return
    this.repo.touchScheduleRun(current.id, nowIso())
    try {
      await this.service.createBackup(
        {
          connectionId: current.connectionId,
          database: current.database,
          format: current.format,
        },
        'scheduled',
        current.id,
      )
      this.ctx.audit.log({
        actor: null,
        action: 'backup.scheduled',
        target: current.name,
        connectionId: current.connectionId,
        database: current.database,
      })
    } catch (err) {
      this.log(
        `Scheduled backup '${current.name}' failed to start: ${err instanceof Error ? err.message : err}`,
      )
      this.ctx.audit.log({
        actor: null,
        action: 'backup.scheduled',
        target: current.name,
        connectionId: current.connectionId,
        database: current.database,
        details: err instanceof Error ? err.message : 'failed to start',
        status: 'error',
      })
    }
  }
}
