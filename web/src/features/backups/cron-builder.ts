/**
 * Bidirectional mapping between a friendly schedule description and a 5-field
 * cron expression. `parseCron` is best-effort: expressions that don't match a
 * simple shape fall back to 'custom' so nothing the user typed is ever lost.
 */

export type Frequency = 'hourly' | 'interval' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom'

export interface ScheduleSpec {
  frequency: Frequency
  /** 0–59; used by every non-custom frequency. */
  minute: number
  /** 0–23; used by daily/weekly/monthly/yearly. */
  hour: number
  /** Used by 'interval' (every N hours). */
  intervalHours: number
  /** 0 (Sunday) – 6 (Saturday); used by 'weekly'. */
  weekday: number
  /** 1–31; used by monthly/yearly. */
  dayOfMonth: number
  /** 1–12; used by 'yearly'. */
  month: number
  /** Raw expression for 'custom'. */
  custom: string
}

export const INTERVAL_CHOICES = [2, 3, 4, 6, 8, 12] as const

export const DEFAULT_SPEC: ScheduleSpec = {
  frequency: 'daily',
  minute: 0,
  hour: 3,
  intervalHours: 6,
  weekday: 1,
  dayOfMonth: 1,
  month: 1,
  custom: '0 3 * * *',
}

export function buildCron(spec: ScheduleSpec): string {
  const { minute, hour } = spec
  switch (spec.frequency) {
    case 'hourly':
      return `${minute} * * * *`
    case 'interval':
      return `${minute} */${spec.intervalHours} * * *`
    case 'daily':
      return `${minute} ${hour} * * *`
    case 'weekly':
      return `${minute} ${hour} * * ${spec.weekday}`
    case 'monthly':
      return `${minute} ${hour} ${spec.dayOfMonth} * *`
    case 'yearly':
      return `${minute} ${hour} ${spec.dayOfMonth} ${spec.month} *`
    case 'custom':
      return spec.custom.trim()
  }
}

const N = String.raw`(\d{1,2})`
const MATCHERS: [Exclude<Frequency, 'custom'>, RegExp][] = [
  ['hourly', new RegExp(`^${N} \\* \\* \\* \\*$`)],
  ['interval', new RegExp(`^${N} \\*/${N} \\* \\* \\*$`)],
  ['daily', new RegExp(`^${N} ${N} \\* \\* \\*$`)],
  ['weekly', new RegExp(`^${N} ${N} \\* \\* ${N}$`)],
  ['monthly', new RegExp(`^${N} ${N} ${N} \\* \\*$`)],
  ['yearly', new RegExp(`^${N} ${N} ${N} ${N} \\*$`)],
]

export function parseCron(cron: string): ScheduleSpec {
  const spec: ScheduleSpec = { ...DEFAULT_SPEC, custom: cron, frequency: 'custom' }
  const normalized = cron.trim().replaceAll(/\s+/g, ' ')
  for (const [frequency, matcher] of MATCHERS) {
    const match = matcher.exec(normalized)
    if (!match) continue
    const nums = match.slice(1).map(Number)
    spec.frequency = frequency
    spec.minute = nums[0]!
    switch (frequency) {
      case 'interval':
        spec.intervalHours = nums[1]!
        break
      case 'daily':
        spec.hour = nums[1]!
        break
      case 'weekly':
        spec.hour = nums[1]!
        spec.weekday = nums[2]! % 7
        break
      case 'monthly':
        spec.hour = nums[1]!
        spec.dayOfMonth = nums[2]!
        break
      case 'yearly':
        spec.hour = nums[1]!
        spec.dayOfMonth = nums[2]!
        spec.month = nums[3]!
        break
      case 'hourly':
        break
    }
    return spec
  }
  return spec
}

// Uzbek names are inlined: not every browser ships Intl locale data for 'uz',
// and it is the product's primary language — never fall back to English there.
const UZ_WEEKDAYS = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba']
const UZ_MONTHS = [
  'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
  'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr',
]

/** Localized weekday name for cron weekday 0 (Sunday) – 6 (Saturday). */
export function weekdayName(weekday: number, locale: string): string {
  if (locale.startsWith('uz')) return UZ_WEEKDAYS[weekday] ?? String(weekday)
  // 2024-01-07 was a Sunday.
  const date = new Date(Date.UTC(2024, 0, 7 + weekday))
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(date)
}

/** Localized month name for 1–12. */
export function monthName(month: number, locale: string): string {
  if (locale.startsWith('uz')) return UZ_MONTHS[month - 1] ?? String(month)
  const date = new Date(Date.UTC(2024, month - 1, 1))
  return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(date)
}
