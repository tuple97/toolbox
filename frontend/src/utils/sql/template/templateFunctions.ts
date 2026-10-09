/**
 * 模板函数 / 指令的「规格表」。
 *
 * 与纯粹的文档表不同，这里的每一项都带结构信息：
 *  - `kind`：是普通函数还是块指令（决定候选分类与是否需要配对收尾）；
 *  - `args`：参数名与期望类型（决定参数位该给什么候选，例如第 2 个参数必须是字符串）；
 *  - `returns`：返回类型（决定能否继续接管道段）；
 *  - `block`：块指令的收尾要求（是否需要 `end`、是否允许多分支）。
 *
 * 候选生成与「当前该给什么」的判断都读这份规格，避免散落在各处的字符串比较。
 */

/** 模板值的类型（用于参数与变量匹配，不求精确，只求够用） */
export type TemplateValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'any'
  | 'unknown'

/** 一个参数位的规格 */
export interface TemplateArgumentSpec {
  /** 参数名（选填时给文档用） */
  name: string
  /** 期望类型 */
  type: TemplateValueType
  /** 是否可省略（省略时不参与「参数位提示」） */
  optional?: boolean
}

/** 模板函数 / 指令的完整规格 */
export interface TemplateFunctionSpec {
  name: string
  kind: 'function' | 'directive'
  args: TemplateArgumentSpec[]
  returns?: TemplateValueType
  /** 块指令：必须以 `end` 收尾，可选是否允许 `else` 分支 */
  block?: {
    close: 'end'
    allowElse?: boolean
  }
  /** 候选右侧的短签名 */
  signature: string
  /** 提示面板里的说明（可多行） */
  description: string
  /** 示例 */
  example: string
  /** 插入后是否补一个空格（要接参数的都补） */
  trailingSpace?: boolean
}

/** 便于书写的简写：`arg('值', 'any')` */
function arg(name: string, type: TemplateValueType, optional = false): TemplateArgumentSpec {
  return { name, type, optional }
}

/**
 * 规格表。
 *
 * 自定义函数（quote / upper / lower / default / join / now / in）与后端
 * `app/internal/utils/tplfunc.go` 注册的实现保持一致；其余是模板语言内置函数。
 */
export const TEMPLATE_FUNCTION_SPECS: Record<string, TemplateFunctionSpec> = {
  // ---- 自定义函数（后端注册）
  quote: {
    name: 'quote',
    kind: 'function',
    args: [arg('值', 'any')],
    returns: 'string',
    signature: 'quote 值',
    description: '按值类型加 SQL 引号：字符串 → \'值\'（内部单引号转义），数字 / 布尔原样输出，空值 → NULL。',
    example: 'WHERE device_name = {{ quote device_name }}',
    trailingSpace: true,
  },
  upper: {
    name: 'upper',
    kind: 'function',
    args: [arg('值', 'any')],
    returns: 'string',
    signature: 'upper 值',
    description: '把值转成大写。',
    example: 'WHERE code = {{ upper code }}',
    trailingSpace: true,
  },
  lower: {
    name: 'lower',
    kind: 'function',
    args: [arg('值', 'any')],
    returns: 'string',
    signature: 'lower 值',
    description: '把值转成小写。',
    example: 'WHERE code = {{ lower code }}',
    trailingSpace: true,
  },
  default: {
    name: 'default',
    kind: 'function',
    args: [arg('默认值', 'string'), arg('值', 'any')],
    returns: 'any',
    signature: 'default "默认值" 值',
    description: '值为空（零值）时使用默认值；管道写法更常见：{{ 变量 | default "50" }}。',
    example: 'LIMIT {{ page_size | default "50" }}',
    trailingSpace: true,
  },
  join: {
    name: 'join',
    kind: 'function',
    args: [arg('分隔符', 'string'), arg('数组', 'array')],
    returns: 'string',
    signature: 'join "分隔符" 数组',
    description: '把数组按分隔符拼成字符串，常配合 quote 拼 IN 列表。',
    example: "device_no in ('{{ join \"','\" device_list }}')",
    trailingSpace: true,
  },
  now: {
    name: 'now',
    kind: 'function',
    args: [arg('格式', 'string', true)],
    returns: 'string',
    signature: 'now "2006-01-02 15:04:05"',
    description: '按时间格式输出当前时间，参数留空默认 2006-01-02 15:04:05。',
    example: "AND create_time <= '{{ now \"2006-01-02 15:04:05\" }}'",
    trailingSpace: true,
  },
  in: {
    name: 'in',
    kind: 'function',
    args: [arg('集合', 'string'), arg('值', 'any')],
    returns: 'boolean',
    signature: 'in "a,b" 值',
    description: '判断值是否命中给定集合（逗号分隔的字符串），用于多环境 / 多类型判断。',
    example: '{{if in "prod,uat" env}} AND env_type = 1 {{end}}',
    trailingSpace: true,
  },

  // ---- 块指令
  if: {
    name: 'if',
    kind: 'directive',
    args: [arg('条件', 'boolean')],
    block: { close: 'end', allowElse: true },
    signature: 'if 条件',
    description: '条件为真时输出块内内容，必须以 {{end}} 收尾；可选多个 {{else if}} 与一个 {{else}} 分支。',
    example: '{{if device_no}} AND device_no = {{device_no}} {{end}}',
    trailingSpace: true,
  },
  range: {
    name: 'range',
    kind: 'directive',
    args: [arg('数组', 'array')],
    block: { close: 'end', allowElse: true },
    signature: 'range 数组',
    description: '遍历数组，块内用 {{.}} 表示当前元素；带下标用 {{range $i, $v := 数组}}。',
    example: "device_no in ({{range device_list}}'{{.}}',{{end}}'')",
    trailingSpace: true,
  },
  with: {
    name: 'with',
    kind: 'directive',
    args: [arg('值', 'any')],
    block: { close: 'end', allowElse: true },
    signature: 'with 值',
    description: '值为非空时进入该作用域，块内可直接用 {{.字段}}。',
    example: '{{with device}} AND device_no = {{.device_no}} {{end}}',
    trailingSpace: true,
  },

  // ---- 常用内置函数
  and: { name: 'and', kind: 'function', args: [arg('值1', 'any'), arg('值2', 'any', true)], returns: 'any', signature: 'and 值1 值2 …', description: '全部为真才为真（遇假值即停止求值）。', example: '{{if and start_time end_time}} … {{end}}', trailingSpace: true },
  or: { name: 'or', kind: 'function', args: [arg('值1', 'any'), arg('值2', 'any', true)], returns: 'any', signature: 'or 值1 值2 …', description: '任一为真即输出。', example: '{{if or keyword device_no}} … {{end}}', trailingSpace: true },
  not: { name: 'not', kind: 'function', args: [arg('值', 'boolean')], returns: 'boolean', signature: 'not 值', description: '对单个值取反，常用于「变量为空时才拼接」。', example: '{{if not show_deleted}} AND deleted = 0 {{end}}', trailingSpace: true },
  eq: { name: 'eq', kind: 'function', args: [arg('值1', 'any'), arg('值2', 'any')], returns: 'boolean', signature: 'eq 值1 值2', description: '相等判断。', example: '{{if eq env "prod"}} … {{end}}', trailingSpace: true },
  ne: { name: 'ne', kind: 'function', args: [arg('值1', 'any'), arg('值2', 'any')], returns: 'boolean', signature: 'ne 值1 值2', description: '不等判断。', example: '{{if ne env "prod"}} … {{end}}', trailingSpace: true },
  lt: { name: 'lt', kind: 'function', args: [arg('值1', 'any'), arg('值2', 'any')], returns: 'boolean', signature: 'lt 值1 值2', description: '小于判断。', example: '{{if lt page_size 100}} … {{end}}', trailingSpace: true },
  gt: { name: 'gt', kind: 'function', args: [arg('值1', 'any'), arg('值2', 'any')], returns: 'boolean', signature: 'gt 值1 值2', description: '大于判断（常与 len 搭配判断非空）。', example: '{{if gt (len device_list) 0}} … {{end}}', trailingSpace: true },
  len: { name: 'len', kind: 'function', args: [arg('值', 'any')], returns: 'number', signature: 'len 值', description: '取长度，配合 gt / eq 判断数组 / 字符串是否为空。', example: '{{if gt (len device_list) 0}} … {{end}}', trailingSpace: true },
  index: { name: 'index', kind: 'function', args: [arg('数组', 'array'), arg('下标', 'number')], returns: 'any', signature: 'index 数组 下标', description: '按下标取值。', example: 'AND first_tag = {{ index tag_list 0 }}', trailingSpace: true },
  slice: { name: 'slice', kind: 'function', args: [arg('数组', 'array'), arg('起', 'number'), arg('止', 'number', true)], returns: 'array', signature: 'slice 数组 起 止', description: '截取切片（下标从 0 开始，含起不含止）。', example: '{{range slice tag_list 0 3}} … {{end}}', trailingSpace: true },
  printf: {
    name: 'printf',
    kind: 'function',
    args: [arg('格式', 'string'), arg('值', 'any', true)],
    returns: 'string',
    signature: 'printf "格式" 值',
    description: '按格式串拼接；SQL 里的 LIKE 模糊匹配常写成 printf "%%%s%%"（%% 转义为 %）。',
    example: "WHERE name LIKE '{{ printf \"%%%s%%\" keyword }}'",
    trailingSpace: true,
  },
  print: { name: 'print', kind: 'function', args: [arg('值', 'any', true)], returns: 'string', signature: 'print 值…', description: '原样打印（不做格式化）。', example: '{{print device_no}}', trailingSpace: true },
}

/** 取某个函数 / 指令的规格 */
export function templateFunctionSpec(name: string): TemplateFunctionSpec | undefined {
  return TEMPLATE_FUNCTION_SPECS[name.toLowerCase()]
}

/** 全部函数 / 指令名（小写） */
export function templateFunctionNames(): string[] {
  return Object.keys(TEMPLATE_FUNCTION_SPECS)
}

/** 块指令名（需要 `end` 收尾） */
export function templateDirectiveNames(): string[] {
  return Object.values(TEMPLATE_FUNCTION_SPECS)
    .filter(spec => spec.kind === 'directive')
    .map(spec => spec.name)
}

/**
 * 当前参数位期望的类型（取不到返回 'any'）。
 *
 * 用于「第 2 个参数必须是字符串」这类判断：`{{ printf | }}` 与 `{{ eq | }}`
 * 的候选排序/过滤可以据此区分。
 */
export function expectedArgumentType(name: string, argumentIndex: number): TemplateValueType {
  const spec = templateFunctionSpec(name)
  if (!spec || argumentIndex < 0) {
    return 'any'
  }
  const declared = spec.args[argumentIndex]
  return declared ? declared.type : 'any'
}

/**
 * 某个函数还能不能再接参数（已经写满且没有可变参数时返回 false）。
 *
 * 只用于提示强弱，不做硬性拦截：模板语言本身对参数个数并不严格。
 */
export function acceptsMoreArguments(name: string, written: number): boolean {
  const spec = templateFunctionSpec(name)
  if (!spec) {
    return true
  }
  const fixed = spec.args.filter(item => !item.optional).length
  const total = spec.args.length
  if (total === 1 && fixed === 1) {
    return false
  }
  return written < total || spec.args.some(item => item.optional)
}
