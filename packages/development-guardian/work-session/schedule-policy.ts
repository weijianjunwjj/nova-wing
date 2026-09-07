/** Built-in preset, never fetched at runtime.
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * Verified: 2026-08-31. Prices may change; this is not a savings guarantee.
 */
export const DEEPSEEK_PRICING_SCHEDULE = {
  timezone: 'Asia/Shanghai',
  peakWeekdays: [1, 2, 3, 4, 5],
  peakWindows: [{ start: 9 * 60, end: 12 * 60 }, { start: 14 * 60, end: 18 * 60 }],
} as const

export type ScheduleSource = 'immediate' | 'custom' | 'deepseek_off_peak'

export function getDeepSeekPricingPeriod(now: Date): {
  period: 'peak' | 'off_peak'
  nextOffPeakAt: Date | null
  reason: 'weekend' | 'already_off_peak' | 'peak'
} {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid date')
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DEEPSEEK_PRICING_SCHEDULE.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: string): number => Number(parts.find((item) => item.type === type)?.value)
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))
  const weekday = new Date(wall).getUTCDay()
  if (!(DEEPSEEK_PRICING_SCHEDULE.peakWeekdays as readonly number[]).includes(weekday)) {
    return { period: 'off_peak', nextOffPeakAt: null, reason: 'weekend' }
  }
  const minute = part('hour') * 60 + part('minute')
  const window = DEEPSEEK_PRICING_SCHEDULE.peakWindows.find((item) => minute >= item.start && minute < item.end)
  if (window === undefined) return { period: 'off_peak', nextOffPeakAt: null, reason: 'already_off_peak' }
  // Difference between two Beijing wall-clock instants, not host-local hours.
  const delta = (window.end - minute) * 60_000 - part('second') * 1_000 - now.getUTCMilliseconds()
  return { period: 'peak', nextOffPeakAt: new Date(now.getTime() + delta), reason: 'peak' }
}

/** Require an explicit offset; reject ambiguous local and calendar-overflow dates. */
export function normalizeScheduledStart(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('Invalid scheduled timestamp')
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (match === null) throw new Error('Timestamp must include timezone')
  const [, y, m, d, h, minute, second, , offset] = match
  const days = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate()
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > days ||
    Number(h) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    (offset !== 'Z' && (Number(offset!.slice(1, 3)) > 23 || Number(offset!.slice(4)) > 59))) {
    throw new Error('Invalid calendar timestamp')
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error('Invalid scheduled timestamp')
  return new Date(timestamp).toISOString()
}
