/** 执行记录面板的自定义日志语言与四套编辑器主题 */
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import type { StreamParser } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { Tag, tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

/** 日志语言 ID（ExecutionLog 把它作为 language 传给编辑器） */
export const LOG_LANGUAGE_ID = 'toolbox-log'

/** 应用主题 → 编辑器调色板键（与 styles/global.css 的同名主题一一对应） */
export const APP_THEME_DARK = 'toolbox-dark'
/** 极夜黑主题 */
export const APP_THEME_MIDNIGHT = 'toolbox-midnight'
/** IDEA Darcula 主题 */
export const APP_THEME_IDEA = 'toolbox-idea'
/** 亮色主题 */
export const APP_THEME_LIGHT = 'toolbox-light'

/** 应用主题名（configStore.theme）→ 编辑器调色板键 */
const APP_THEME_OF: Record<string, string> = {
  dark: APP_THEME_DARK,
  midnight: APP_THEME_MIDNIGHT,
  idea: APP_THEME_IDEA,
  light: APP_THEME_LIGHT,
}

/** 由应用主题名取编辑器调色板键 */
export function editorThemeNameOf(appTheme: string): string {
  return APP_THEME_OF[appTheme] ?? APP_THEME_DARK
}

/** SQL 关键字（日志高亮与补全共用，统一小写比较） */
const SQL_KEYWORDS = [
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null', 'like', 'between',
  'insert', 'into', 'values', 'update', 'set', 'delete', 'truncate', 'replace',
  'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'on', 'as',
  'group', 'by', 'order', 'having', 'limit', 'offset', 'union', 'all', 'distinct',
  'case', 'when', 'then', 'else', 'end', 'exists', 'asc', 'desc',
  'count', 'sum', 'avg', 'max', 'min', 'coalesce', 'cast', 'convert',
  'create', 'alter', 'drop', 'table', 'index', 'view', 'with', 'over', 'partition',
]

/** 一条 token 配色规则（token 选择器 → 颜色） */
interface TokenRule {
  token: string
  /** 不带 # 的十六进制颜色 */
  foreground: string
  fontStyle?: string
}

/** 暗色下的 token 颜色 */
const DARK_RULES: TokenRule[] = [
  { token: 'log-request', foreground: '6e79f4', fontStyle: 'bold' },
  { token: 'log-response', foreground: '34d399', fontStyle: 'bold' },
  { token: 'log-success', foreground: '34d399' },
  { token: 'log-error', foreground: 'f87171', fontStyle: 'bold' },
  { token: 'log-time', foreground: '64748b' },
  { token: 'log-conn', foreground: '94a3b8' },
  { token: 'log-keyword', foreground: 'c084fc' },
  { token: 'log-string', foreground: 'fbbf24' },
  { token: 'log-number', foreground: 'fbbf24' },
]

/** 亮色下的 token 颜色，整体加深以保证对比度 */
const LIGHT_RULES: TokenRule[] = [
  { token: 'log-request', foreground: '4f46e5', fontStyle: 'bold' },
  { token: 'log-response', foreground: '15803d', fontStyle: 'bold' },
  { token: 'log-success', foreground: '15803d' },
  { token: 'log-error', foreground: 'dc2626', fontStyle: 'bold' },
  { token: 'log-time', foreground: '94a3b8' },
  { token: 'log-conn', foreground: '475569' },
  { token: 'log-keyword', foreground: '7c3aed' },
  { token: 'log-string', foreground: 'b45309' },
  { token: 'log-number', foreground: 'b45309' },
]

/** IDEA Darcula 风格的 token 颜色 */
const IDEA_RULES: TokenRule[] = [
  { token: 'log-request', foreground: 'cc7832', fontStyle: 'bold' },
  { token: 'log-response', foreground: '6a8759', fontStyle: 'bold' },
  { token: 'log-success', foreground: '6a8759' },
  { token: 'log-error', foreground: 'e05561', fontStyle: 'bold' },
  { token: 'log-time', foreground: '606366' },
  { token: 'log-conn', foreground: 'a9b7c6' },
  { token: 'log-keyword', foreground: 'cc7832' },
  { token: 'log-string', foreground: '6a8759' },
  { token: 'log-number', foreground: '6897bb' },
]

/** 一种应用主题对应的编辑器调色板（颜色均不带 #） */
interface EditorPalette {
  /** 是否暗色（决定 CM6 主题的 dark 标记） */
  dark: boolean
  rules: TokenRule[]
  /** 编辑器背景（本应用里统一透明，该值仅作参考/回退） */
  background: string
  /** 默认前景色 */
  foreground: string
  /** 行号 */
  lineNumber: string
  /** 当前行号 */
  lineNumberActive: string
  /** 光标 */
  cursor: string
  /** 选区（带透明度） */
  selection: string
  /** 当前行高亮 */
  lineHighlight: string
  /** 浮层（补全、悬停）背景 */
  widget: string
  /** 边框 / 分隔线 */
  border: string
  /** 强调色（补全命中等） */
  accent: string
}

/** 各主题的编辑器配色 */
const PALETTES: Record<string, EditorPalette> = {
  [APP_THEME_DARK]: {
    dark: true,
    rules: DARK_RULES,
    background: '0f172a',
    foreground: 'e2e8f0',
    lineNumber: '475569',
    lineNumberActive: '94a3b8',
    cursor: '6e79f4',
    selection: '6e79f440',
    lineHighlight: 'ffffff0a',
    widget: '16213c',
    border: 'ffffff1a',
    accent: '6e79f4',
  },
  [APP_THEME_MIDNIGHT]: {
    dark: true,
    rules: DARK_RULES,
    background: '0a0a0c',
    foreground: 'e8e8ea',
    lineNumber: '3f3f46',
    lineNumberActive: 'a1a1aa',
    cursor: '8b93fa',
    selection: '8b93fa40',
    lineHighlight: 'ffffff08',
    widget: '16161a',
    border: 'ffffff1f',
    accent: '8b93fa',
  },
  [APP_THEME_IDEA]: {
    dark: true,
    rules: IDEA_RULES,
    background: '2b2b2b',
    foreground: 'a9b7c6',
    lineNumber: '606366',
    lineNumberActive: 'a1a1aa',
    cursor: 'cc7832',
    selection: 'cc783233',
    lineHighlight: 'ffffff08',
    widget: '3c3f41',
    border: 'ffffff1a',
    accent: 'cc7832',
  },
  [APP_THEME_LIGHT]: {
    dark: false,
    rules: LIGHT_RULES,
    background: 'f1f5f9',
    foreground: '1e293b',
    lineNumber: '94a3b8',
    lineNumberActive: '475569',
    cursor: '4f46e5',
    selection: '4f46e533',
    lineHighlight: '0f172a0a',
    widget: 'ffffff',
    border: '0f172a1f',
    accent: '4f46e5',
  },
}

// ---------------------------------------------------------------- 日志语言

/** 日志用的自定义 token 标签（CM6 的 HighlightStyle 通过它们上色） */
const logRequest = Tag.define()
const logResponse = Tag.define()
const logSuccess = Tag.define()
const logError = Tag.define()
const logTime = Tag.define()
const logConn = Tag.define()
const logKeyword = Tag.define()
const logString = Tag.define()
const logNumber = Tag.define()

/** token 名（词法分析器返回的字符串）→ CM6 标签 */
const LOG_TAGS: Record<string, Tag> = {
  'log-request': logRequest,
  'log-response': logResponse,
  'log-success': logSuccess,
  'log-error': logError,
  'log-time': logTime,
  'log-conn': logConn,
  'log-keyword': logKeyword,
  'log-string': logString,
  'log-number': logNumber,
}

/** 日志词法分析器：逐行扫描，规则顺序与原 Monarch 版本一致 */
const logParser: StreamParser<null> = {
  name: LOG_LANGUAGE_ID,

  // 词法分析器返回的 token 名 → CM6 标签（HighlighterStyle 据此上色）
  tokenTable: LOG_TAGS,

  startState() {
    return null
  },

  token(stream) {
    // 行首的请求 / 响应标记
    if (stream.sol() && stream.match('>>')) {
      return 'log-request'
    }
    if (stream.sol() && stream.match('<<')) {
      return 'log-response'
    }

    // 结果关键字（中文）
    if (stream.match('错误')) {
      return 'log-error'
    }
    if (stream.match('成功')) {
      return 'log-success'
    }

    // [HH:mm:ss] 时间
    if (stream.match(/^\[\d{1,2}:\d{2}:\d{2}\]/)) {
      return 'log-time'
    }
    // [连接名] 等方括号内容
    if (stream.match(/^\[[^\]\n]*\]/)) {
      return 'log-conn'
    }

    // SQL 字面量
    if (stream.match(/^'[^'\n]*'/)) {
      return 'log-string'
    }
    if (stream.match(/^\d+(?:\.\d+)?/)) {
      return 'log-number'
    }

    // 标识符：命中关键字表则高亮
    const word = stream.match(/^[A-Za-z_][\w$]*/)
    if (word) {
      const text = String(Array.isArray(word) ? word[0] : word)
      return SQL_KEYWORDS.includes(text.toLowerCase()) ? 'log-keyword' : null
    }

    // 其它字符逐个消费，避免死循环
    stream.next()
    return null
  },
}

/** 日志语言扩展（ExecutionLog 的 language="toolbox-log" 走这里） */
export function logLanguage(): Extension {
  return StreamLanguage.define(logParser)
}

// ---------------------------------------------------------------- CM6 主题

/** 日志 token 规则 → HighlightStyle（颜色值原样沿用调色板数据） */
function logHighlightStyle(rules: TokenRule[]): HighlightStyle {
  const specs = rules.flatMap((rule) => {
    const tag = LOG_TAGS[rule.token]
    if (!tag) {
      return []
    }
    return [{
      tag,
      color: `#${rule.foreground}`,
      fontWeight: rule.fontStyle?.includes('bold') ? '600' : undefined,
    }]
  })
  return HighlightStyle.define(specs)
}

/** 代码（SQL / JS）的语法高亮：复用调色板里的语法色，保证与日志观感一致 */
function codeHighlightStyle(palette: EditorPalette): HighlightStyle {
  const color = (token: string, fallback: string) =>
    `#${palette.rules.find(rule => rule.token === token)?.foreground ?? fallback}`

  const keyword = color('log-keyword', palette.accent)
  const string = color('log-string', palette.accent)
  const number = color('log-number', palette.accent)
  const invalid = color('log-error', palette.foreground)
  const comment = `#${palette.lineNumber}`

  return HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.controlKeyword], color: keyword },
    { tag: [t.string, t.special(t.string), t.regexp], color: string },
    { tag: [t.number, t.bool, t.null, t.integer, t.float], color: number },
    { tag: [t.comment, t.lineComment, t.blockComment], color: comment, fontStyle: 'italic' },
    { tag: [t.invalid], color: invalid },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: palette.accent },
    { tag: [t.typeName, t.className, t.namespace], color: palette.accent },
    { tag: [t.operator, t.punctuation, t.separator], color: palette.foreground, opacity: '0.85' },
  ])
}

/** 生成某套应用主题对应的 CM6 扩展（渲染层 + 高亮层） */
export function editorThemeExtensions(themeName: string): Extension[] {
  const palette = PALETTES[themeName] ?? PALETTES[APP_THEME_DARK]
  const h = (value: string) => `#${value}`
  /** 语句边框颜色：品牌色半透明，既能看清边界又不抢眼 */
  const frame = `${h(palette.accent)}55`

  const theme = EditorView.theme(
    {
      // 背景透明：编辑器要融入所在容器
      '&': {
        color: h(palette.foreground),
        backgroundColor: 'transparent',
        height: '100%',
      },
      '.cm-content': { caretColor: h(palette.cursor) },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: h(palette.cursor) },
      '.cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: h(palette.selection),
      },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: h(palette.selection) },
      '.cm-activeLine': { backgroundColor: h(palette.lineHighlight) },
      /* 语句边框（utils/sqlStatementBox.ts）：光标所在语句的整框，层不吃鼠标事件 */
      '.cm-sql-box-layer': {
        pointerEvents: 'none',
      },
      '.cm-sql-box': {
        border: `1px solid ${frame}`,
        borderRadius: '2px',
        pointerEvents: 'none',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: h(palette.lineNumber),
        border: 'none',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: h(palette.lineNumberActive),
      },
      /* 浮层（补全列表 / 悬停卡片）：圆角 + 阴影 + 边框 */
      '.cm-tooltip': {
        backgroundColor: h(palette.widget),
        border: `1px solid ${h(palette.border)}`,
        borderRadius: '8px',
        boxShadow: palette.dark
          ? '0 12px 30px rgba(0, 0, 0, 0.45)'
          : '0 12px 30px rgba(15, 23, 42, 0.16)',
        color: h(palette.foreground),
        overflow: 'hidden',
      },
      '.cm-tooltip-autocomplete': {
        fontStyle: 'normal',
        padding: '4px',
      },
      /* 弹层宽高：需显式放宽，否则长内容被 CM6 基础主题截断 */
      '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        maxWidth: 'min(1100px, 95vw)',
        maxHeight: '300px',
      },
      '.cm-tooltip-autocomplete > ul > li': {
        color: h(palette.foreground),
        // 基础主题的行内边距偏挤，放松一点，同时给选中行留出圆角
        padding: '4px 8px',
        borderRadius: '5px',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: h(palette.selection),
        color: h(palette.foreground),
      },
      /* 补全弹层排版：命中片段用品牌色加粗，不用基础主题的下划线 */
      '.cm-tooltip-autocomplete ul li .cm-completionMatchedText': {
        textDecoration: 'none',
        color: h(palette.accent),
        fontWeight: '600',
      },
      '.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionMatchedText': {
        color: h(palette.accent),
      },
      '.cm-tooltip-autocomplete ul li .cm-completionDetail': {
        marginLeft: '0.75em',
        fontStyle: 'normal',
        fontSize: '0.92em',
        opacity: '0.55',
      },
      /* 列名多选勾选框：未勾选空心方框，勾选后填品牌色并显示对勾 */
      '.cm-tooltip-autocomplete ul li .cm-sqlcheck': {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '0.85em',
        height: '0.85em',
        // 边框走 border-box：不加盒子尺寸，方框始终是正方形
        boxSizing: 'border-box',
        flex: 'none',
        border: `1px solid ${h(palette.lineNumber)}`,
        borderRadius: '3px',
        color: '#fff',
        // 与文本基线对齐（inline-flex 默认按底边对齐会偏下）
        verticalAlign: '-1px',
        // 勾选框只是状态显示，点击仍然交给整行（点击即插入）
        pointerEvents: 'none',
      },
      '.cm-tooltip-autocomplete ul li[aria-selected] .cm-sqlcheck': {
        borderColor: h(palette.lineNumberActive),
      },
      '.cm-tooltip-autocomplete ul li .cm-sqlcheck[data-checked="true"]': {
        borderColor: h(palette.accent),
        backgroundColor: h(palette.accent),
      },
      '.cm-tooltip-autocomplete ul li .cm-sqlcheck[data-checked="true"]::after': {
        content: '"✓"',
        fontSize: '0.72em',
        lineHeight: '1',
      },
      /* 列候选描述区：「类型 · 来源 · 注释」三段，来源与注释各带彩色图标 */
      '.cm-tooltip-autocomplete ul li .cm-column-detail': {
        display: 'inline-flex',
        alignItems: 'center',
        // 放不下时折行，避免内容被截断
        flexWrap: 'wrap',
        // tips 文本放开选择，便于复制类型 / 来源表 / 注释
        userSelect: 'text',
        gap: '0.7em',
        marginLeft: '1.1em',
        fontSize: '0.92em',
      },
      /* 变淡的只有文字（类型 / 值），图标保持原色 */
      '.cm-tooltip-autocomplete ul li .cm-column-detail__type, .cm-tooltip-autocomplete ul li .cm-column-detail__value': {
        opacity: '0.75',
      },
      /* 备注允许换行（最宽约 46 字符），避免长注释被省略 */
      '.cm-tooltip-autocomplete ul li .cm-column-detail__part--comment .cm-column-detail__value': {
        minWidth: '0',
        maxWidth: '46ch',
        whiteSpace: 'normal',
        overflowWrap: 'anywhere',
      },
      // 表名一般很短；超长时才省略（否则会把整行推宽）
      '.cm-tooltip-autocomplete ul li .cm-column-detail__part--source .cm-column-detail__value': {
        minWidth: '0',
        maxWidth: '24ch',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      '.cm-tooltip-autocomplete ul li[aria-selected] .cm-column-detail__type, .cm-tooltip-autocomplete ul li[aria-selected] .cm-column-detail__value': {
        opacity: '1',
      },
      '.cm-tooltip-autocomplete ul li .cm-column-detail__part': {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.28em',
        // 同上：放不下时折行，别让内容消失
        flexWrap: 'wrap',
      },
      /* 列类型字体跟随编辑器，不用等宽字体 */
      '.cm-tooltip-autocomplete ul li .cm-column-detail__type': {
        fontFamily: 'inherit',
      },
      '.cm-tooltip-autocomplete ul li .cm-column-detail__icon': {
        display: 'inline-flex',
        alignItems: 'center',
      },
      '.cm-tooltip-autocomplete ul li .cm-column-detail__icon svg': {
        width: '0.95em',
        height: '0.95em',
      },
      /* 两个图标配色：来源用品牌色，注释用琥珀色 */
      '.cm-tooltip-autocomplete ul li .cm-column-detail__part--source .cm-column-detail__icon': {
        color: h(palette.accent),
      },
      // 来源表可点击（点击弹出表结构卡片，见 CodeEditor 的 openTableCardFromDetail）
      '.cm-tooltip-autocomplete ul li .cm-column-detail__part--link': {
        cursor: 'pointer',
      },
      '.cm-tooltip-autocomplete ul li .cm-column-detail__part--link:hover .cm-column-detail__value': {
        textDecoration: 'underline',
      },
      '.cm-tooltip-autocomplete ul li .cm-column-detail__part--comment .cm-column-detail__icon': {
        color: palette.dark ? '#fbbf24' : '#b45309',
      },
      /* 候选类型图标：每个类型一种颜色，一眼分出这是什么候选 */
      '.cm-tooltip-autocomplete ul li .cm-type-icon': {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '1.1em',
        marginRight: '0.45em',
        verticalAlign: '-0.18em',
      },
      '.cm-tooltip-autocomplete ul li .cm-type-icon svg': {
        width: '1em',
        height: '1em',
      },
      // 列
      '.cm-tooltip-autocomplete ul li .cm-type-icon--field': {
        color: palette.dark ? '#2dd4bf' : '#0d9488',
      },
      // 表（跟随主题品牌色）
      '.cm-tooltip-autocomplete ul li .cm-type-icon--class': {
        color: h(palette.accent),
      },
      // 别名 / 变量
      '.cm-tooltip-autocomplete ul li .cm-type-icon--variable': {
        color: palette.dark ? '#c084fc' : '#7c3aed',
      },
      // 库
      '.cm-tooltip-autocomplete ul li .cm-type-icon--namespace': {
        color: palette.dark ? '#34d399' : '#15803d',
      },
      // 关键字
      '.cm-tooltip-autocomplete ul li .cm-type-icon--keyword': {
        color: palette.dark ? '#fb923c' : '#c2410c',
      },
      // 函数
      '.cm-tooltip-autocomplete ul li .cm-type-icon--function': {
        color: palette.dark ? '#f472b6' : '#db2777',
      },
      // 模板属性
      '.cm-tooltip-autocomplete ul li .cm-type-icon--property': {
        color: palette.dark ? '#94a3b8' : '#475569',
      },
      // 片段 / 智能项
      '.cm-tooltip-autocomplete ul li .cm-type-icon--text': {
        color: palette.dark ? '#fbbf24' : '#b45309',
      },
      /* 错误标记：底部红色波浪线，悬停显示消息 */
      '.cm-error-mark': {
        textDecoration: `underline wavy ${palette.dark ? '#f87171' : '#dc2626'}`,
        // 下划线穿过下伸部（g / y 等），更接近 IDE 的波浪线观感
        textDecorationSkipInk: 'none',
        textUnderlineOffset: '3px',
      },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: h(palette.selection),
        outline: `1px solid ${h(palette.border)}`,
      },
      /* 查找 / 替换面板与命中高亮：按当前配色重写官方浅色样式 */
      '.cm-panel.cm-search': {
        backgroundColor: h(palette.widget),
        borderTop: `1px solid ${h(palette.border)}`,
        color: h(palette.foreground),
        padding: '6px 8px',
        fontFamily: 'inherit',
        fontSize: 'inherit',
      },
      '.cm-panel.cm-search .cm-textfield': {
        padding: '2px 6px',
        border: `1px solid ${h(palette.border)}`,
        borderRadius: '4px',
        backgroundColor: 'transparent',
        color: h(palette.foreground),
        fontFamily: 'inherit',
        fontSize: 'inherit',
      },
      '.cm-panel.cm-search .cm-textfield:focus': {
        outline: 'none',
        borderColor: h(palette.accent),
      },
      '.cm-panel.cm-search .cm-button': {
        padding: '2px 8px',
        border: `1px solid ${h(palette.border)}`,
        borderRadius: '4px',
        // 官方给按钮铺了一张渐变底图，不清掉就会盖住上面的透明底
        backgroundImage: 'none',
        backgroundColor: 'transparent',
        color: h(palette.foreground),
        fontFamily: 'inherit',
        fontSize: 'inherit',
        cursor: 'pointer',
      },
      '.cm-panel.cm-search .cm-button:hover': {
        borderColor: h(palette.accent),
        color: h(palette.accent),
      },
      '.cm-panel.cm-search label': {
        color: h(palette.foreground),
        fontSize: '0.92em',
        opacity: '0.75',
      },
      '.cm-panel.cm-search [name=close]': {
        color: h(palette.lineNumberActive),
        fontFamily: 'inherit',
      },
      // 命中：品牌色半透明底 + 描边；当前命中再实一层，与其它命中区分开
      '.cm-searchMatch': {
        backgroundColor: `${h(palette.accent)}33`,
        outline: `1px solid ${h(palette.accent)}55`,
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: `${h(palette.accent)}66`,
      },
      // 「选中词在文中的其它出现」：比查找命中更淡，不与查找结果抢注意力
      '.cm-selectionMatch': {
        backgroundColor: h(palette.selection),
      },
    },
    { dark: palette.dark },
  )

  return [
    theme,
    syntaxHighlighting(logHighlightStyle(palette.rules)),
    syntaxHighlighting(codeHighlightStyle(palette)),
  ]
}
