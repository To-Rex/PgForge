import { describe, expect, it } from 'vitest'
import { displayValue, formatBytes, formatCompact, formatMs, formatUptime } from './format.js'

describe('formatBytes', () => {
  it('renders an em dash for absent values', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })

  it('keeps bytes unscaled below 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('scales through the units', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
  })

  it('drops the decimal once the number is large', () => {
    expect(formatBytes(1024 * 150)).toBe('150 KB')
  })
})

describe('formatMs', () => {
  it('renders an em dash for absent values', () => {
    expect(formatMs(null)).toBe('—')
  })

  it('rounds sub-second values to whole milliseconds', () => {
    expect(formatMs(12.4)).toBe('12 ms')
  })

  it('switches to seconds then minutes', () => {
    expect(formatMs(1500)).toBe('1.5 s')
    expect(formatMs(90_000)).toBe('1m 30s')
  })
})

describe('formatCompact', () => {
  it('leaves small counts alone', () => {
    expect(formatCompact(999)).toBe('999')
  })

  it('abbreviates thousands, millions and billions', () => {
    expect(formatCompact(1_500)).toBe('1.5k')
    expect(formatCompact(15_000)).toBe('15k')
    expect(formatCompact(2_500_000)).toBe('2.5M')
    expect(formatCompact(3_000_000_000)).toBe('3.0B')
  })
})

describe('formatUptime', () => {
  it('prefers the two largest units', () => {
    expect(formatUptime(90)).toBe('1m')
    expect(formatUptime(3_660)).toBe('1h 1m')
    expect(formatUptime(90_000)).toBe('1d 1h')
  })
})

describe('displayValue', () => {
  it('renders null and undefined as empty', () => {
    expect(displayValue(null)).toBe('')
    expect(displayValue(undefined)).toBe('')
  })

  it('serializes objects and arrays as JSON', () => {
    expect(displayValue({ a: 1 })).toBe('{"a":1}')
    expect(displayValue([1, 2])).toBe('[1,2]')
  })

  it('stringifies primitives', () => {
    expect(displayValue(0)).toBe('0')
    expect(displayValue(false)).toBe('false')
    expect(displayValue('x')).toBe('x')
  })
})
