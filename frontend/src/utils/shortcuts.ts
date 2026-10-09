/** 可配置快捷键的统一目录；页面按 action id 读取 */
export interface ShortcutDefinition {
  id: string
  group: string
  label: string
  defaultKey: string
  hint: string
}

export const SHORTCUTS: ShortcutDefinition[] = [
  { id: 'open-settings', group: '全局', label: '打开设置', defaultKey: 'Ctrl+,', hint: '随时打开设置页' },
  { id: 'new-tab', group: '工作台', label: '新建标签', defaultKey: 'Ctrl+T', hint: '打开新建标签面板' },
  { id: 'close-tab', group: '工作台', label: '关闭当前标签', defaultKey: 'Ctrl+W', hint: '仅关闭可关闭的工作标签' },
  { id: 'run-sql', group: 'SQL 查询', label: '执行当前语句', defaultKey: 'Ctrl+Enter', hint: '有选区时执行选区，否则执行光标所在语句' },
  { id: 'format-sql', group: 'SQL 查询', label: '美化 / 压缩 SQL', defaultKey: 'Alt+Shift+F', hint: '按当前语句的形态切换' },
  { id: 'refresh-metadata', group: 'SQL 查询', label: '刷新元数据', defaultKey: 'Ctrl+Shift+R', hint: '重新读取表和字段缓存' },
  { id: 'save-connection', group: '连接管理', label: '保存连接', defaultKey: 'Ctrl+S', hint: '保存当前连接' },
  { id: 'save-template', group: 'SQL 模板', label: '保存模板', defaultKey: 'Ctrl+S', hint: '保存当前模板' },
  { id: 'save-dictionary', group: '词典', label: '保存词典条目', defaultKey: 'Ctrl+S', hint: '保存当前词典条目' },
  { id: 'rename-sql-symbol', group: 'SQL 查询', label: '重命名表 / 列别名', defaultKey: '', hint: '在光标处重命名语义对象' },
  { id: 'goto-sql-definition', group: 'SQL 查询', label: '跳转到定义', defaultKey: 'F12', hint: '跳转到别名、CTE 等定义位置' },
  { id: 'copy-create-table', group: 'SQL 查询', label: '复制建表语句', defaultKey: '', hint: '复制光标所在表的 CREATE TABLE' },
]

export function parseShortcutConfig(raw: string | undefined): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, key]) => typeof key === 'string')) as Record<string, string>
  }
  catch { return {} }
}

export function shortcutOf(id: string, raw: string | undefined): string {
  return parseShortcutConfig(raw)[id] || SHORTCUTS.find(item => item.id === id)?.defaultKey || ''
}

/** 用标准显示格式保存 */
export function normalizeShortcut(value: string): string {
  const tokens = value.split(/[+\-\s]+/).filter(Boolean).map(item => item.toLowerCase())
  const modifier = (names: string[]) => names.some(name => tokens.includes(name))
  const key = tokens.find(item => !['ctrl', 'control', 'cmd', 'command', 'meta', 'alt', 'shift'].includes(item))
  if (!key) return ''
  const parts = [modifier(['ctrl', 'control', 'cmd', 'command', 'meta']) ? 'Ctrl' : '', modifier(['alt']) ? 'Alt' : '', modifier(['shift']) ? 'Shift' : ''].filter(Boolean)
  const normalizedKey = key === 'space' ? 'Space' : key === 'comma' ? ',' : key === 'enter' ? 'Enter' : key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1)
  return [...parts, normalizedKey].join('+')
}

/** 按下按键 → 配置的标准写法（设置页按键录入用） */
export function shortcutFromEvent(event: KeyboardEvent): string {
  const key = event.key === ' ' ? 'Space' : event.key === ',' ? ',' : event.key
  return normalizeShortcut([
    event.ctrlKey || event.metaKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    key,
  ].filter(Boolean).join('+'))
}

export function matchesShortcut(event: KeyboardEvent, value: string): boolean {
  const normalized = normalizeShortcut(value)
  if (!normalized) return false
  const parts = normalized.split('+')
  const key = parts.at(-1)!
  // “Ctrl” 同时代表 macOS 的 Command
  return (event.ctrlKey || event.metaKey) === parts.includes('Ctrl')
    && event.altKey === parts.includes('Alt')
    && event.shiftKey === parts.includes('Shift')
    && (event.key.toLowerCase() === key.toLowerCase() || (key === ',' && event.code === 'Comma'))
}
