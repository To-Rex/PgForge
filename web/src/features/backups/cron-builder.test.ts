import { describe, expect, it } from 'vitest'
import { DEFAULT_SPEC, buildCron, parseCron, type ScheduleSpec } from './cron-builder.js'

const spec = (over: Partial<ScheduleSpec>): ScheduleSpec => ({ ...DEFAULT_SPEC, ...over })

describe('buildCron', () => {
  it('builds each frequency', () => {
    expect(buildCron(spec({ frequency: 'hourly', minute: 15 }))).toBe('15 * * * *')
    expect(buildCron(spec({ frequency: 'interval', minute: 0, intervalHours: 6 }))).toBe('0 */6 * * *')
    expect(buildCron(spec({ frequency: 'daily', minute: 30, hour: 2 }))).toBe('30 2 * * *')
    expect(buildCron(spec({ frequency: 'weekly', minute: 0, hour: 4, weekday: 1 }))).toBe('0 4 * * 1')
    expect(buildCron(spec({ frequency: 'monthly', minute: 0, hour: 5, dayOfMonth: 12 }))).toBe('0 5 12 * *')
    expect(
      buildCron(spec({ frequency: 'yearly', minute: 0, hour: 6, dayOfMonth: 1, month: 3 })),
    ).toBe('0 6 1 3 *')
  })

  it('passes a custom expression through, trimmed', () => {
    expect(buildCron(spec({ frequency: 'custom', custom: '  */5 * * * *  ' }))).toBe('*/5 * * * *')
  })
})

describe('parseCron', () => {
  it('round-trips every non-custom frequency', () => {
    const cases: ScheduleSpec[] = [
      spec({ frequency: 'hourly', minute: 15 }),
      spec({ frequency: 'interval', minute: 0, intervalHours: 6 }),
      spec({ frequency: 'daily', minute: 30, hour: 2 }),
      spec({ frequency: 'weekly', minute: 0, hour: 4, weekday: 1 }),
      spec({ frequency: 'monthly', minute: 0, hour: 5, dayOfMonth: 12 }),
      spec({ frequency: 'yearly', minute: 0, hour: 6, dayOfMonth: 1, month: 3 }),
    ]
    for (const original of cases) {
      const cron = buildCron(original)
      const parsed = parseCron(cron)
      expect(parsed.frequency).toBe(original.frequency)
      expect(buildCron(parsed)).toBe(cron)
    }
  })

  it('normalizes repeated whitespace', () => {
    expect(parseCron('  30   2  *  *  * ').frequency).toBe('daily')
    expect(parseCron('  30   2  *  *  * ').hour).toBe(2)
  })

  it('maps cron weekday 7 onto Sunday', () => {
    expect(parseCron('0 4 * * 7').weekday).toBe(0)
  })

  it('falls back to custom without losing the expression', () => {
    const parsed = parseCron('*/5 9-17 * * 1-5')
    expect(parsed.frequency).toBe('custom')
    expect(parsed.custom).toBe('*/5 9-17 * * 1-5')
    expect(buildCron(parsed)).toBe('*/5 9-17 * * 1-5')
  })

  it('treats an unparseable string as custom rather than throwing', () => {
    expect(parseCron('not a cron').frequency).toBe('custom')
  })
})
