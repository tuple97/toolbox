/** 自绘图标库（替代 `@element-plus/icons-vue`），每个都是一段 SVG 内部内容（24×24 视图） */

/** 一个图标：`body` 是 SVG 内部内容 */
export interface IconDefinition {
  /** 中文名，供无障碍标签与调试用 */
  label: string
  body: string
}

export const ICONS: Record<string, IconDefinition> = {
  home: {
    label: '首页',
    body: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>',
  },
  link: {
    label: '连接',
    body: '<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4 0l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4l-1 1"/>'
      + '<path d="M13.5 10.5a4.5 4.5 0 0 0-6.4 0l-2.6 2.6a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  },
  document: {
    label: '文档',
    body: '<path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>',
  },
  search: {
    label: '搜索',
    body: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  },
  terminal: {
    label: '终端',
    body: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>',
  },
  book: {
    label: '词典',
    body: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  },
  github: {
    label: 'GitHub',
    // 实心 mark：根 svg 是描边风格，这里显式改回填充（缩放自 16 视图）
    body: '<g transform="scale(1.5)"><path fill="currentColor" stroke="none" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></g>',
  },
  settings: {
    label: '设置',
    body: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/>'
      + '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34'
      + ' 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.35a1.7 1.7 0 0 0-1.87.34l-.06.06'
      + 'a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H2a2 2 0 1 1 0-4h.09'
      + 'A1.7 1.7 0 0 0 3.65 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 8 4.65'
      + 'h.08A1.7 1.7 0 0 0 9.65 3.1V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06'
      + 'a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08A1.7 1.7 0 0 0 20.9 10.65H21a2 2 0 1 1 0 4h-.09'
      + 'a1.7 1.7 0 0 0-1.51 1.03Z"/>',
  },
  puzzle: {
    label: '插件',
    body: '<path d="M9.5 4.5a2 2 0 0 1 4 0V6H16a1.5 1.5 0 0 1 1.5 1.5V10h1.5a2 2 0 0 1 0 4H17.5v2.5A1.5 1.5 0 0 1 16 18h-2.5v-1.5'
      + 'a2 2 0 0 0-4 0V18H7a1.5 1.5 0 0 1-1.5-1.5V13h1.5a2 2 0 0 0 0-4H5.5V7.5A1.5 1.5 0 0 1 7 6h2.5V4.5Z"/>',
  },
  plus: {
    label: '新增',
    body: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  },
  close: {
    label: '关闭',
    body: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  },
  eye: {
    label: '显示',
    body: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/>'
      + '<circle cx="12" cy="12" r="3"/>',
  },
  'eye-off': {
    label: '隐藏',
    body: '<path d="M10.6 5.2A9.6 9.6 0 0 1 12 5.1c6.4 0 10 6.9 10 6.9a17 17 0 0 1-3.2 4.2"/>'
      + '<path d="M6.5 6.9A17 17 0 0 0 2 12s3.6 6.9 10 6.9a9.9 9.9 0 0 0 3.9-.8"/>'
      + '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M2 2l20 20"/>',
  },
  pencil: {
    label: '编辑',
    body: '<path d="M12 20h9"/><path d="M16.7 3.3a2.1 2.1 0 0 1 3 3L7.5 18.5 3.5 19.5l1-4z"/>',
  },
  trash: {
    label: '删除',
    body: '<path d="M3 6h18"/>'
      + '<path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/>'
      + '<path d="M5.5 6l1 13.5a1.5 1.5 0 0 0 1.5 1.4h8a1.5 1.5 0 0 0 1.5-1.4L19 6"/>'
      + '<path d="M10 11v5"/><path d="M14 11v5"/>',
  },
  'chevrons-left': {
    label: '收起',
    body: '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
  },
  'chevrons-right': {
    label: '展开',
    body: '<path d="m13 17 5-5-5-5"/><path d="m6 17 5-5-5-5"/>',
  },
  'chevron-down': {
    label: '展开',
    body: '<path d="m6 9.5 6 6 6-6"/>',
  },
  'chevron-up': {
    label: '收起',
    body: '<path d="m6 14.5 6-6 6 6"/>',
  },
  inbox: {
    label: '暂无数据',
    body: '<path d="M3 13.5 5.5 5h13L21 13.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
      + '<path d="M3 13.5h5l1 2.5h6l1-2.5h5"/>',
  },
  refresh: {
    label: '刷新',
    body: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>'
      + '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>',
  },
  download: {
    label: '下载',
    body: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/>',
  },
  folder: {
    label: '文件夹',
    body: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h7A1.5 1.5 0 0 1 19 9.5v7A1.5 1.5 0 0 1 17.5 18h-13A1.5 1.5 0 0 1 3 16.5z"/>',
  },
  package: {
    label: '安装包',
    body: '<path d="M12 3.5 20 8v8l-8 4.5L4 16V8z"/><path d="m4 8 8 4.5L20 8"/><path d="M12 12.5v8"/>',
  },
  play: {
    label: '执行',
    body: '<path d="M7 4.8v14.4l11.5-7.2z"/>',
  },
  pause: {
    label: '终止',
    body: '<rect x="6.5" y="4.5" width="3.5" height="15" rx="1.2" fill="currentColor" stroke="none"/>'
      + '<rect x="14" y="4.5" width="3.5" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
  },
  'arrow-left': {
    label: '左移',
    body: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  },
  'arrow-right': {
    label: '右移',
    body: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  },
  lock: {
    label: '锁定',
    body: '<rect x="4.5" y="10" width="15" height="10.5" rx="2"/>'
      + '<path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
  },
  key: {
    label: '主键',
    body: '<circle cx="8.5" cy="8.5" r="4.5"/><path d="m11.8 11.8 8.2 8.2"/>'
      + '<path d="m17.5 17.5 2.2-2.2"/><path d="m20 20 1.8-1.8"/>',
  },
  wand: {
    label: '美化',
    body: '<path d="m3 21 12-12"/>'
      + '<path d="M15 3.5 15.9 6l2.5.9-2.5.9-.9 2.5-.9-2.5L11.6 7l2.5-.9z"/>'
      + '<path d="m20 12.5.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/>',
  },
  chart: {
    label: '分析',
    body: '<path d="M4 20V11"/><path d="M10 20V4"/><path d="M16 20v-6"/><path d="M3 20h18"/>',
  },
  check: {
    label: '对勾',
    body: '<path d="m4.5 12.5 5 5 10-11"/>',
  },
  'check-circle': {
    label: '成功',
    body: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16 9.5"/>',
  },
  'x-circle': {
    label: '失败',
    body: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  },
  'alert-triangle': {
    label: '警告',
    body: '<path d="M10.3 4.3 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z"/>'
      + '<path d="M12 9v4"/><path d="M12 17h.01"/>',
  },
  'info-circle': {
    label: '提示',
    body: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  },
  question: {
    label: '未知图标',
    body: '<circle cx="12" cy="12" r="9"/>'
      + '<path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.5v.2"/><path d="M12 17h.01"/>',
  },
  // ---- 模板片段分类 ----
  branch: {
    label: '条件分支',
    body: '<circle cx="6.5" cy="5.5" r="2.2"/><circle cx="6.5" cy="18.5" r="2.2"/>'
      + '<circle cx="17.5" cy="9.5" r="2.2"/><path d="M6.5 7.7v8.6"/>'
      + '<path d="M17.5 11.7c0 3.2-2.6 4.2-5.4 4.7"/>',
  },
  repeat: {
    label: '循环',
    body: '<path d="M17 3.5 20 6.5l-3 3"/><path d="M4 12V10a3.5 3.5 0 0 1 3.5-3.5H20"/>'
      + '<path d="M7 20.5 4 17.5l3-3"/><path d="M20 12v2a3.5 3.5 0 0 1-3.5 3.5H4"/>',
  },
  braces: {
    label: '变量占位',
    body: '<path d="M9 3.5H7.5a2 2 0 0 0-2 2v3A2.5 2.5 0 0 1 3 11v2a2.5 2.5 0 0 1 2.5 2.5v3a2 2 0 0 0 2 2H9"/>'
      + '<path d="M15 3.5h1.5a2 2 0 0 1 2 2v3A2.5 2.5 0 0 0 21 11v2a2.5 2.5 0 0 0-2.5 2.5v3'
      + 'a2 2 0 0 1-2 2H15"/>',
  },
  function: {
    label: '自定义函数',
    body: '<path d="M14 4h-1.5A3 3 0 0 0 9.5 7v13"/><path d="M6 11h7"/>'
      + '<path d="m15.5 11.5 5 6"/><path d="m20.5 11.5-5 6"/>',
  },
  box: {
    label: '内置函数',
    body: '<path d="m12 3 8.5 4.7v8.6L12 21 3.5 16.3V7.7z"/><path d="m3.5 7.7 8.5 4.8 8.5-4.8"/>'
      + '<path d="M12 21v-8.5"/>',
  },
  more: {
    label: '其他',
    body: '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/>'
      + '<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>'
      + '<circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  },
}

/** 拼错名字时的兜底 */
const FALLBACK = 'question'

/** 取一段图标的 SVG 内容；名字不存在时返回兜底图形 */
export function iconBody(name: string): string {
  const icon = ICONS[name]
  if (icon) {
    return icon.body
  }
  if (import.meta.env.DEV) {
    console.warn(`[icons] 图标「${name}」不存在，请检查 utils/icons.ts`)
  }
  return ICONS[FALLBACK].body
}

/** 图标是否存在 */
export function hasIcon(name: string): boolean {
  return Object.hasOwn(ICONS, name)
}
