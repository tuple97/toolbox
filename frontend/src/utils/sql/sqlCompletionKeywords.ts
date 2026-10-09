/** SQL 补全的候选权重与关键字 / 函数清单（纯数据，无逻辑） */
import { SQL_FUNCTION_DOCS } from './functionCatalog'

/** 候选权重（CodeMirror 的 boost）—— 类别次序的唯一出处；层间距 1000 量级，层内交给匹配分 */
export const BOOST_COLUMN = 8000
export const BOOST_ALIAS = 7000
export const BOOST_TABLE = 6000
export const BOOST_NAMESPACE = 5500
/** 语句级 / DDL：`SELECT`、`INSERT INTO` … */
export const BOOST_STATEMENT_KEYWORD = 2000
/** 表达式：`AND`、`CASE`、`AS` … */
export const BOOST_EXPRESSION_KEYWORD = 1500
/** 子句：`FROM`、`WHERE`、`GROUP BY` … */
export const BOOST_CLAUSE_KEYWORD = 1200
export const BOOST_FUNCTION = 1000

/** 智能项（* 展开 / 分组列 / 比较值 / INSERT 列清单）权重，高于列 */
export const BOOST_SMART_ITEM = 9000

/** 上下文优先的列（如 GROUP BY 位置上的 SELECT 非聚合列），略高于普通列 */
export const BOOST_SMART_COLUMN = 8500

/* 关键字按「允许出现的位置」分类，补全只给该位置写得出来的那些 */

/** 语句级 / DDL：只有新语句开头（`kind === 'any'`）才给 */
export const STATEMENT_KEYWORDS = [
  'SELECT', 'WITH', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE',
  'DROP TABLE', 'ALTER TABLE', 'TRUNCATE TABLE', 'CREATE INDEX', 'DROP INDEX',
  'SHOW TABLES', 'DESCRIBE', 'EXPLAIN', 'USE',
]

/** 连接：表来源写完后接着写的下一个表 / 关联条件 */
export const JOIN_KEYWORDS = ['JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'ON']

/** 子句：开始一个新子句（表达式写完后收尾或续写） */
export const CLAUSE_KEYWORDS = [
  'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'UNION ALL', 'SET', 'VALUES',
]

/** 表达式：条件与表达式内部 */
export const EXPRESSION_KEYWORDS = [
  'AND', 'OR', 'NOT', 'NULL', 'IN', 'BETWEEN', 'LIKE', 'IS NULL', 'EXISTS',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'AS', 'ASC', 'DESC',
]

/** 全部关键字（数组顺序即候选顺序），语句开头一次性给出 */
export const SQL_KEYWORDS = [
  ...STATEMENT_KEYWORDS, ...JOIN_KEYWORDS, ...CLAUSE_KEYWORDS, ...EXPRESSION_KEYWORDS,
]

/** 表达式关键字的集合版，用于决定候选权重 */
export const EXPRESSION_KEYWORD_SET = new Set(EXPRESSION_KEYWORDS)

/** 语句关键字的集合版，用于决定候选权重 */
export const STATEMENT_KEYWORD_SET = new Set(STATEMENT_KEYWORDS)

/** 关键字词表（多词结构拆成单个词、小写）；用于扫描判断紧贴光标的词是否关键字 */
export const KEYWORD_WORDS = new Set(
  SQL_KEYWORDS.flatMap(keyword => keyword.toLowerCase().split(/\s+/)),
)

/** 需要引用符才能当标识符用的保留字；判据只用于插入时要不要加引用符 */
export const RESERVED_WORDS = new Set([
  // 补全里的关键字（含多词结构拆开后的单词）
  ...KEYWORD_WORDS,
  // 两词结构的后半截
  'group', 'order', 'union', 'cross', 'outer', 'inner', 'left', 'right',
  // 列名里最常见的保留字
  'key', 'index', 'user', 'database', 'schema', 'column',
  'primary', 'foreign', 'references', 'constraint', 'default', 'unique', 'check',
  'rank', 'row', 'rows', 'window', 'match', 'natural', 'except', 'intersect',
  'partition', 'procedure', 'function', 'trigger', 'view', 'comment',
  'grant', 'revoke', 'commit', 'rollback', 'transaction', 'lock', 'unlock',
  'replace', 'ignore', 'force', 'precision',
  'current_user', 'current_date', 'current_time', 'current_timestamp',
])

/* 常用函数（名字 → 一行签名说明），由 functionCatalog.ts 派生 */
export const SQL_FUNCTIONS: Record<string, string> = Object.fromEntries(
  SQL_FUNCTION_DOCS.map((fn) => {
    const params = fn.params
      .map(param => (param.optional ? `${param.name}?` : param.name))
      .join(', ')
    return [fn.name, `${fn.name}(${params}${fn.variadic ? ', …' : ''})`]
  }),
)
