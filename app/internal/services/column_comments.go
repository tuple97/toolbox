package services

import (
	"context"
	"database/sql"
	"regexp"
	"strings"
)

/*
 * 结果列的「注释 / 来源表 / 完整类型」补全。
 *
 * database/sql 的 ColumnType 只提供类型名（MySQL 下是 `VARCHAR` 这种不带长度的），
 * 拿不到注释，也拿不到声明的长度；这些只存在数据库自己的数据字典里
 * （MySQL 的 information_schema.columns）。所以结果返回前用语句里出现的表名
 * 反查一次字典：列名能对上就填注释、来源表与**含长度的类型**
 * （`varchar(255)` / `decimal(10,2)`），对不上（表达式列、别名列、聚合列）
 * 留空 / 保留驱动给的类型 —— 前端只在有值时展示。
 *
 * 查询范围是**语句里实际出现的 schema 集合**（限定名 `mydb.users` 带出 mydb，
 * 裸表名回退到连接默认库）：连接没配默认库、模板里全用限定名时，只查
 * conn.Database 会得到 `table_schema = ''`，一条注释都查不到 —— 模板查询
 * 曾因此「只有类型没有描述」。
 *
 * 只做 MySQL / MariaDB：PostgreSQL 的注释在 pg_description 里需要额外 join，
 * 收益有限，暂不处理（那里的结果列注释恒为空）。
 */

// annotateResultColumns 就地给结果列补注释、来源表与含长度的类型。
//
// 失败时静默跳过：这些都是展示增强，绝不能因为查字典失败而让整个查询失败。
// 调用方应传入独立的短超时 ctx，避免与主查询抢时间。
func annotateResultColumns(
	ctx context.Context,
	db rowQueryer,
	dbType string,
	database string,
	query string,
	columns []ColumnMeta,
) {
	if len(columns) == 0 || isPostgresType(dbType) {
		return
	}

	refs := fromTables(query)
	if len(refs) == 0 {
		return
	}

	// schema 集合：限定名带出的库 + 裸表名回退的默认库（可能为空，跳过）
	fallback := schemaName(database, dbType)
	schemas := make([]string, 0, 2)
	seenSchema := make(map[string]bool)
	addSchema := func(name string) {
		if name == "" || seenSchema[name] {
			return
		}
		seenSchema[name] = true
		schemas = append(schemas, name)
	}
	tables := make([]string, 0, len(refs))
	seenTable := make(map[string]bool)
	for _, ref := range refs {
		addSchema(ref.schema)
		key := strings.ToLower(ref.table)
		if !seenTable[key] {
			seenTable[key] = true
			tables = append(tables, ref.table)
		}
	}
	addSchema(fallback)
	if len(schemas) == 0 {
		return
	}

	rows, err := db.QueryContext(ctx, `
		SELECT table_name, column_name, column_comment, column_type
		FROM information_schema.columns
		WHERE table_schema IN (`+placeholdersOf(schemas)+`)
		  AND table_name IN (`+placeholdersOf(tables)+`)`,
		append(toAnySlice(schemas), toAnySlice(tables)...)...)
	if err != nil {
		return
	}
	defer rows.Close()

	/*
	 * 结果列不带表名（`SELECT u.id, o.id` 两列同名），因此只能按列名匹配；
	 * 多表出现同名列时取第一个 —— 有歧义时宁可给一个接近的，
	 * 也不因为「不确定」而整列不显示。
	 */
	comments := make(map[string]string, len(columns))
	sources := make(map[string]string, len(columns))
	types := make(map[string]string, len(columns))
	for rows.Next() {
		var table, name, comment, dataType sql.NullString
		if err := rows.Scan(&table, &name, &comment, &dataType); err != nil {
			return
		}
		key := strings.ToLower(name.String)
		if _, exists := sources[key]; !exists && strings.TrimSpace(table.String) != "" {
			sources[key] = strings.TrimSpace(table.String)
		}
		if display := displayTypeOf(dataType.String); display != "" {
			if _, exists := types[key]; !exists {
				types[key] = display
			}
		}
		if strings.TrimSpace(comment.String) == "" {
			continue
		}
		if _, exists := comments[key]; !exists {
			comments[key] = strings.TrimSpace(comment.String)
		}
	}
	if err := rows.Err(); err != nil {
		return
	}

	for i := range columns {
		key := strings.ToLower(columns[i].Name)
		if comment, ok := comments[key]; ok {
			columns[i].Comment = comment
		}
		if table, ok := sources[key]; ok {
			columns[i].Table = table
		}
		// 字典里的类型是精确的（带长度 / 精度），覆盖驱动给的粗略类型名
		if dataType, ok := types[key]; ok {
			columns[i].Type = dataType
		}
	}
}

/*
 * displayTypeOf 把 information_schema.columns.column_type 整理成展示用类型名。
 *
 * 括号**外**整体大写（类型名与修饰词：`int unsigned` → `INT UNSIGNED`），
 * 括号**内**原样保留 —— `enum('a','B')` 的取值大小写是有意义的，
 * 一起大写会改掉语义。这样与驱动给的类型名（`INT` / `VARCHAR`）大小写一致，
 * 同一行表头里不会出现「有的全大写、有的全小写」。
 */
func displayTypeOf(raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return ""
	}

	var builder strings.Builder
	builder.Grow(len(text))
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] != '(' {
			continue
		}
		builder.WriteString(strings.ToUpper(text[start:i]))
		end := strings.IndexByte(text[i:], ')')
		if end < 0 {
			// 括号没闭合（理论上不会有）：剩下的整体大写，别把内容吞掉
			builder.WriteString(strings.ToUpper(text[i:]))
			return builder.String()
		}
		builder.WriteString(text[i : i+end+1])
		i += end
		start = i + 1
	}
	builder.WriteString(strings.ToUpper(text[start:]))
	return builder.String()
}

// 语句里的表来源：FROM / JOIN 之后。
var fromJoinPattern = regexp.MustCompile(`(?is)\b(?:from|join)\s+`)

// 一次解析最多关注这么多张表，避免超长 IN 列表把字典查询拖慢
const maxCommentTables = 8

// tableRef 语句里出现的一个表来源。
// schema 为空表示语句里没写限定名（由调用方回退到连接默认库）。
type tableRef struct {
	schema string
	table  string
}

/*
 * fromTables 从语句里取出表来源（去重，保留限定名里的库 / 模式）。
 *
 * 这是补全用扫描器在服务端的极简版：只认 FROM / JOIN 后面的标识符，
 * `FROM (SELECT …)` 这种子查询直接跳过（它内部的 FROM 会被另一次匹配捕获）。
 * CTE 名也会被当成表名 — 字典里查不到，自然没有注释，无副作用。
 */
func fromTables(query string) []tableRef {
	seen := make(map[string]bool)
	refs := make([]tableRef, 0, 4)

	// 先剥掉注释与单引号字符串：里面的 from / join 不是表来源
	clean := stripLiterals(query)

	for _, match := range fromJoinPattern.FindAllStringIndex(clean, -1) {
		ref := qualifiedTableRef(clean[match[1]:])
		if ref.table == "" {
			continue
		}
		key := strings.ToLower(ref.schema + "." + ref.table)
		if seen[key] {
			continue
		}
		seen[key] = true
		refs = append(refs, ref)
		if len(refs) >= maxCommentTables {
			break
		}
	}
	return refs
}

// placeholdersOf 生成 n 个 `?` 的逗号串（IN 列表用）
func placeholdersOf(values []string) string {
	return strings.TrimSuffix(strings.Repeat("?,", len(values)), ",")
}

// toAnySlice []string → []any（database/sql 的可变参数要求）
func toAnySlice(values []string) []any {
	out := make([]any, len(values))
	for i, value := range values {
		out[i] = value
	}
	return out
}

/*
 * stripLiterals 把注释与单引号字符串替换为空格。
 *
 * 保留反引号 / 双引号（MySQL 里可能是标识符，表名靠它们包着），
 * 只清理确定是「非结构文本」的部分。
 */
func stripLiterals(query string) string {
	builder := strings.Builder{}
	builder.Grow(len(query))

	for i := 0; i < len(query); {
		switch {
		case strings.HasPrefix(query[i:], "--"), query[i] == '#':
			builder.WriteByte(' ')
			if next := strings.IndexByte(query[i:], '\n'); next >= 0 {
				i += next + 1
				continue
			}
			i = len(query)

		case strings.HasPrefix(query[i:], "/*"):
			builder.WriteByte(' ')
			if next := strings.Index(query[i:], "*/"); next >= 0 {
				i += next + 2
				continue
			}
			i = len(query)

		case query[i] == '\'':
			builder.WriteByte(' ')
			i++
			for i < len(query) {
				if query[i] == '\\' {
					i += 2
					continue
				}
				if query[i] == '\'' {
					// '' 是转义的单引号，字符串还没结束
					if i+1 < len(query) && query[i+1] == '\'' {
						i += 2
						continue
					}
					i++
					break
				}
				i++
			}

		default:
			builder.WriteByte(query[i])
			i++
		}
	}
	return builder.String()
}

/*
 * qualifiedTableRef 读出一段限定名（库 / 模式 + 表名），读不到表名返回空 table。
 *
 * 支持 `db`.`t`、db.t、t 三种写法；`(` 开头（子查询）直接判为读不到。
 * 只关心首段与末段：MySQL 的限定名最多两段，多出来的段（PG 三段式那边
 * 反正不处理）按「首段是库、末段是表」近似。
 */
func qualifiedTableRef(text string) tableRef {
	index := 0
	first := ""
	last := ""
	segments := 0

	for {
		index = skipSpaceAndComments(text, index)
		segment, next := readIdentSegment(text, index)
		if segment == "" {
			break
		}
		if segments == 0 {
			first = segment
		}
		last = segment
		segments++
		index = skipSpaceAndComments(text, next)
		if index >= len(text) || text[index] != '.' {
			break
		}
		index++ // 跳过点号，继续读下一段
	}

	if segments >= 2 {
		return tableRef{schema: first, table: last}
	}
	return tableRef{table: last}
}

// readIdentSegment 读一个标识符段：反引号 / 双引号包裹，或裸标识符。
func readIdentSegment(text string, start int) (string, int) {
	if start >= len(text) {
		return "", start
	}

	switch text[start] {
	case '`', '"':
		quote := text[start]
		if end := strings.IndexByte(text[start+1:], quote); end >= 0 {
			return text[start+1 : start+1+end], start + 1 + end + 1
		}
		return "", start
	}

	end := start
	for end < len(text) && isSQLIdentChar(text[end]) {
		end++
	}
	if end == start {
		return "", start
	}
	return text[start:end], end
}

// skipSpaceAndComments 跳过空白与 `--` / `/* */` 注释。
func skipSpaceAndComments(text string, start int) int {
	index := start
	for index < len(text) {
		switch {
		case text[index] == ' ' || text[index] == '\t' || text[index] == '\n' || text[index] == '\r':
			index++
		case strings.HasPrefix(text[index:], "--"), text[index] == '#':
			if next := strings.IndexByte(text[index:], '\n'); next >= 0 {
				index += next + 1
				continue
			}
			return len(text)
		case strings.HasPrefix(text[index:], "/*"):
			if next := strings.Index(text[index:], "*/"); next >= 0 {
				index += next + 2
				continue
			}
			return len(text)
		default:
			return index
		}
	}
	return index
}
