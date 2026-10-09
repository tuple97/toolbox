import { describe, expect, it } from 'vitest'
import { csvCellText, escapeCsvField, toCsv } from '@/utils/csv'

describe('CSV 字段转义', () => {
  it('普通文本不加引号（加得到处都是引号反而难比对）', () => {
    expect(escapeCsvField('启用')).toBe('启用')
    expect(escapeCsvField('2026-09-20 10:00:00')).toBe('2026-09-20 10:00:00')
  })

  it('含逗号 / 引号 / 换行时加引号，引号本身翻倍', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"')
    expect(escapeCsvField('说"引号"')).toBe('"说""引号"""')
    expect(escapeCsvField('第一行\n第二行')).toBe('"第一行\n第二行"')
    expect(escapeCsvField('回车\r\n换行')).toBe('"回车\r\n换行"')
  })
})

describe('单元格取值', () => {
  it('空值给空串，而不是字面量 null（否则会被当成字符串）', () => {
    expect(csvCellText(null)).toBe('')
    expect(csvCellText(undefined)).toBe('')
  })

  it('数字与布尔按原样转字符串', () => {
    expect(csvCellText(0)).toBe('0')
    expect(csvCellText(false)).toBe('false')
    expect(csvCellText(12.5)).toBe('12.5')
  })

  it('对象给 JSON 而不是 [object Object]', () => {
    expect(csvCellText({ a: 1 })).toBe('{"a":1}')
    expect(csvCellText([1, 2])).toBe('[1,2]')
  })

  it('日期给 ISO 串（跨时区粘贴时不产生歧义）', () => {
    expect(csvCellText(new Date('2026-09-20T10:00:00Z'))).toBe('2026-09-20T10:00:00.000Z')
  })

  it('循环引用对象不会抛错（结果集里理论上不会有，但别让复制崩溃）', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => csvCellText(circular)).not.toThrow()
  })
})

describe('生成 CSV', () => {
  it('首行是列名，行尾用 \\r\\n，且不留末尾空行', () => {
    const csv = toCsv(['id', '名称'], [[1, '张三'], [2, '李四']])
    expect(csv).toBe('id,名称\r\n1,张三\r\n2,李四')
  })

  it('表头与数据用同一套转义（列名里也可能有逗号）', () => {
    const csv = toCsv(['a,b', 'c"d'], [['x,y', 'z']])
    expect(csv).toBe('"a,b","c""d"\r\n"x,y",z')
  })

  it('空行数组只剩表头（选中 0 行时不该产出半截 CSV）', () => {
    expect(toCsv(['id'], [])).toBe('id')
  })

  it('空值字段留空位，列数不错位', () => {
    expect(toCsv(['a', 'b', 'c'], [[1, null, 3]])).toBe('a,b,c\r\n1,,3')
  })
})
