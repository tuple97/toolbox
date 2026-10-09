import { describe, expect, it } from 'vitest'
import { typeColorTokenOf } from '@/utils/sql/typeBadge'

describe('列类型配色', () => {
  it('三大常用类型各占一色', () => {
    expect(typeColorTokenOf('int')).toBe('brand')
    expect(typeColorTokenOf('varchar(64)')).toBe('success')
    expect(typeColorTokenOf('datetime')).toBe('warning')
  })

  it('布尔单独一色（0/1 最容易看错）', () => {
    expect(typeColorTokenOf('boolean')).toBe('danger')
    expect(typeColorTokenOf('bool')).toBe('danger')
    // MySQL 的 `tinyint(1)` 按共享的类型大类规则算数值（不另立特例，见 sqlTypeCompat）
    expect(typeColorTokenOf('tinyint(1)')).toBe('brand')
  })

  it('少见的类型走中性色，不把表头弄花', () => {
    expect(typeColorTokenOf('json')).toBe('muted')
    expect(typeColorTokenOf('blob')).toBe('muted')
    expect(typeColorTokenOf('')).toBe('muted')
    expect(typeColorTokenOf(undefined)).toBe('muted')
  })

  it('各家的类型名写法都归到大类，不需要新规则', () => {
    // MySQL 的带符号 / 带长度写法
    expect(typeColorTokenOf('BIGINT(20) UNSIGNED')).toBe('brand')
    expect(typeColorTokenOf('DECIMAL(10,2)')).toBe('brand')
    // PostgreSQL 的复合写法
    expect(typeColorTokenOf('character varying(64)')).toBe('success')
    expect(typeColorTokenOf('timestamp without time zone')).toBe('warning')
    expect(typeColorTokenOf('bytea')).toBe('muted')
  })

  it('大小写与空白不影响判定', () => {
    expect(typeColorTokenOf('  VARCHAR  ')).toBe('success')
    expect(typeColorTokenOf('Int')).toBe('brand')
  })
})
