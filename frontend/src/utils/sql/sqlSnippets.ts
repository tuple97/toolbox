/**
 * SQL 模板可插入的片段库。
 *
 * 说明：
 *  - 片段内容全部基于后端的 text/template 模板语法，
 *    变量名用户不写点号（预处理会自动补成 `{{ .变量 }}`）。
 *  - 自定义函数由 `internal/utils/tplfunc.go` 注册：
 *    quote / upper / lower / default / join / now / in。
 *  - 其余为 text/template 内置函数（and/or/not/len/eq/ne/lt/le/gt/ge/printf/index/slice 等）。
 *  - `变量` 是片段里的占位词，插入后会被自动选中，方便直接改写。
 */

export interface SqlSnippet {
  /** 唯一标识 */
  id: string
  /** 所属分类 */
  category: string
  /** 列表展示名 */
  name: string
  /** 插入到编辑器中的文本 */
  code: string
  /** 用法说明 */
  description: string
  /**
   * 示例。
   *
   * 表名 / 列名一律用 `table_name` / `column_name` / `value_list` 这类**占位名**，
   * 不写具体业务名（`device` / `user` 那种）：示例的作用是演示模板语法，
   * 带业务名会让人以为片段只适配那类表，也容易照抄出一段跑不通的 SQL。
   */
  example: string
}

/** 片段分类，顺序即展示顺序 */
export const SNIPPET_CATEGORIES = [
  '条件',
  '循环',
  '变量',
  '自定义函数',
  '内置函数',
  '其他',
] as const

export const SQL_SNIPPETS: SqlSnippet[] = [
  // ---------------------------------------------------------- 条件
  {
    id: 'if',
    category: '条件',
    name: 'if 条件拼接',
    code: '{{if 变量}} AND 变量 = {{变量}} {{end}}',
    description: '变量为空时整段不拼接，是实现「可选查询条件」最常用的写法。',
    example: '{{if column_name}} AND column_name = {{column_name}} {{end}}',
  },
  {
    id: 'if-else',
    category: '条件',
    name: 'if / else 二选一',
    code: '{{if 变量}} AND status = {{变量}} {{else}} AND 1 = 1 {{end}}',
    description: '变量有值时走 if 分支，否则走 else 分支。',
    example: '{{if column_name}} AND column_name = {{column_name}} {{else}} AND column_name IS NOT NULL {{end}}',
  },
  {
    id: 'if-not',
    category: '条件',
    name: 'if not 取反',
    code: '{{if not 变量}} AND deleted = 0 {{end}}',
    description: '变量为空（假值）时才拼接。',
    example: '{{if not include_deleted}} AND column_flag = 0 {{end}}',
  },
  {
    id: 'if-eq',
    category: '条件',
    name: 'if eq 相等判断',
    code: '{{if eq 变量 "值"}} AND type = {{变量}} {{end}}',
    description: '与指定字面量比较，相等才拼接。',
    example: '{{if eq column_name "值"}} AND column_type = 1 {{end}}',
  },
  {
    id: 'if-in',
    category: '条件',
    name: 'if in 多值命中',
    code: '{{if in "值1,值2" 变量}} AND type = {{变量}} {{end}}',
    description: '变量命中给定集合（逗号分隔）时拼接，用于多环境/多类型判断。',
    example: '{{if in "值1,值2" column_name}} AND column_type = 1 {{end}}',
  },

  // ---------------------------------------------------------- 循环
  {
    id: 'range',
    category: '循环',
    name: 'range 遍历',
    code: '{{range 变量}}{{.}}{{end}}',
    description: '遍历数组变量，{{.}} 为当前元素。',
    example: 'column_name in ({{range value_list}}\'{{.}}\',{{end}}\'\')',
  },
  {
    id: 'range-index',
    category: '循环',
    name: 'range 带下标（逗号分隔）',
    code: '{{range $index, $item := 变量}}{{if $index}},{{end}}\'{{$item}}\'{{end}}',
    description: '带下标遍历，首个元素前不加逗号，适合拼 IN 列表。',
    example: 'column_name in ({{range $i, $v := value_list}}{{if $i}},{{end}}{{quote $v}}{{end}})',
  },

  // ---------------------------------------------------------- 变量
  {
    id: 'var',
    category: '变量',
    name: '变量插值',
    code: '{{ 变量 }}',
    description: '最基础的占位符，执行时用填入的值替换；未填值时渲染为空串。',
    example: 'SELECT * FROM table_name WHERE column_name = {{ column_name }}',
  },
  {
    id: 'comment',
    category: '变量',
    name: '模板注释',
    code: '{{/* 注释内容 */}}',
    description: '模板注释，不会输出到最终 SQL，可用于说明模板意图。',
    example: '{{/* 该条件用于分页导出场景 */}}',
  },

  // ---------------------------------------------------------- 自定义函数
  {
    id: 'fn-quote',
    category: '自定义函数',
    name: 'quote 安全加引号',
    code: '{{ quote 变量 }}',
    description: '按类型加 SQL 引号：字符串→\'值\'（内部单引号转义），数字/布尔原样输出，空值→NULL。写字符串条件时优先用它防注入。',
    example: 'WHERE column_name = {{ quote column_name }}',
  },
  {
    id: 'fn-default',
    category: '自定义函数',
    name: 'default 默认值',
    code: '{{ 变量 | default "默认值" }}',
    description: '变量为空值或零值时使用默认值（管道写法：默认值在前）。',
    example: 'LIMIT {{ page_size | default "50" }}',
  },
  {
    id: 'fn-upper',
    category: '自定义函数',
    name: 'upper 转大写',
    code: '{{ upper 变量 }}',
    description: '把值转为大写。',
    example: 'WHERE code = {{ upper code }}',
  },
  {
    id: 'fn-lower',
    category: '自定义函数',
    name: 'lower 转小写',
    code: '{{ lower 变量 }}',
    description: '把值转为小写。',
    example: 'WHERE lower_name = {{ lower name }}',
  },
  {
    id: 'fn-join',
    category: '自定义函数',
    name: 'join 数组拼接',
    code: '{{ join "\',\'" 变量 }}',
    description: '把数组按分隔符合并成字符串；配合 quote 使用更安全。',
    example: 'column_name in (\'{{ join "\',\'" value_list }}\')',
  },
  {
    id: 'fn-now',
    category: '自定义函数',
    name: 'now 当前时间',
    code: '{{ now "2006-01-02 15:04:05" }}',
    description: '按 Go 时间格式输出当前时间，参数留空默认 2006-01-02 15:04:05。',
    example: 'AND create_time <= \'{{ now "2006-01-02 15:04:05" }}\'',
  },

  // ---------------------------------------------------------- 内置函数
  {
    id: 'fn-not',
    category: '内置函数',
    name: 'not 取反',
    code: '{{if not 变量}}...{{end}}',
    description: '对后续单个值取反。',
    example: '{{if not ignore_deleted}} AND deleted = 0 {{end}}',
  },
  {
    id: 'fn-and',
    category: '内置函数',
    name: 'and 与',
    code: '{{if and 变量A 变量B}}...{{end}}',
    description: '多个条件同时为真才拼接（遇到假值即停止求值）。',
    example: '{{if and start_time end_time}} AND create_time BETWEEN {{start_time}} AND {{end_time}} {{end}}',
  },
  {
    id: 'fn-or',
    category: '内置函数',
    name: 'or 或',
    code: '{{if or 变量A 变量B}}...{{end}}',
    description: '任一条件为真即拼接。',
    example: '{{if or keyword column_name}} AND 1 = 1 {{end}}',
  },
  {
    id: 'fn-len',
    category: '内置函数',
    name: 'len 长度判断',
    code: '{{if gt (len 变量) 0}}...{{end}}',
    description: '判断数组/字符串非空，常用于列表类变量。',
    example: '{{if gt (len value_list) 0}} AND column_name IN ({{join "," value_list}}) {{end}}',
  },
  {
    id: 'fn-ne',
    category: '内置函数',
    name: 'ne / lt / gt 比较',
    code: '{{if ne 变量 "值"}}...{{end}}',
    description: '不等（ne）、小于（lt）、大于（gt）等比较函数，写法一致。',
    example: '{{if gt (len value_list) 0}} AND 1 = 1 {{end}}',
  },
  {
    id: 'fn-printf',
    category: '内置函数',
    name: 'printf 格式化',
    code: '{{ printf "%s%%" 变量 }}',
    description: '按 Go 格式化语法拼接，常用于 LIKE 模糊查询（%% 转义为 %）。',
    example: 'WHERE column_name LIKE \'{{ printf "%%%s%%" column_name }}\'',
  },
  {
    id: 'fn-index',
    category: '内置函数',
    name: 'index 取数组元素',
    code: '{{ index 变量 0 }}',
    description: '按下标取数组/映射中的值。',
    example: 'AND column_name = {{ index value_list 0 }}',
  },

  // ---------------------------------------------------------- 其他
  {
    id: 'with',
    category: '其他',
    name: 'with 作用域',
    code: '{{with 变量}} {{.}} {{end}}',
    description: '变量非空时进入该作用域，内部可直接用 {{.}}。',
    example: '{{with table_name}} AND column_name = {{.column_name}} {{end}}',
  },
  {
    id: 'fuzzy',
    category: '其他',
    name: '常用：模糊查询片段',
    code: '{{if 变量}} AND name LIKE {{ printf "%%%s%%" 变量 }} {{end}}',
    description: '关键词模糊查询，变量为空时不拼接该条件。',
    example: '{{if keyword}} AND column_name LIKE {{ printf "%%%s%%" keyword }} {{end}}',
  },
  {
    id: 'pagerange',
    category: '其他',
    name: '常用：时间范围片段',
    code: '{{if and 开始时间 结束时间}} AND create_time BETWEEN {{quote 开始时间}} AND {{quote 结束时间}} {{end}}',
    description: '起止时间都有值时才加时间范围条件。',
    example: '{{if and start_time end_time}} AND create_time BETWEEN {{quote start_time}} AND {{quote end_time}} {{end}}',
  },
]
