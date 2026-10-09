import { describe, expect, it } from 'vitest'
import { ICONS, hasIcon, iconBody } from '@/utils/icons'
import { TOOLS } from '@/utils/tools'

/** 自绘图标库的不变式 */
describe('自绘图标库', () => {
  it('工具注册表的图标名都存在（拼错会让菜单与标签静默没有图标）', () => {
    for (const tool of TOOLS) {
      expect(hasIcon(tool.icon), `工具「${tool.label}」的图标 ${tool.icon} 不存在`).toBe(true)
    }
  })

  it('每个图标都有中文名与非空内容', () => {
    for (const [name, icon] of Object.entries(ICONS)) {
      expect(icon.label, `${name} 缺少中文名`).toBeTruthy()
      expect(icon.body.length, `${name} 的内容为空`).toBeGreaterThan(0)
    }
  })

  it('图标名用短横线小写，不迁就旧的帕斯卡命名', () => {
    for (const name of Object.keys(ICONS)) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })

  it('内容是纯图形，不含脚本或事件属性（静态字符串，不留注入面）', () => {
    for (const [name, icon] of Object.entries(ICONS)) {
      expect(icon.body, `${name} 含可疑内容`).not.toMatch(/<script|on\w+=|javascript:/i)
      expect(icon.body, `${name} 不是图形元素`).toMatch(/^<(path|circle|rect|g)/)
    }
  })

  it('未知名字给兜底图形而不是空内容（否则界面上就是「图标没了」）', () => {
    expect(iconBody('这个图标不存在')).toBe(ICONS.question.body)
    expect(iconBody('question')).toBe(ICONS.question.body)
  })
})
