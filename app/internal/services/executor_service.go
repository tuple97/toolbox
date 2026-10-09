package services

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"
	"time"

	"toolbox/app/internal/database"
)

// 命令执行器的行数与时长约束。
const (
	// 默认返回行数上限
	defaultExecutorLimit = 1000
	// 单条语句的兜底时长：调用方取消（ctx）优先于该上限
	executorMaxDuration = 10 * time.Minute
	// 元数据查询的超时
	metaTimeout = 10 * time.Second
)

// ExecutorRequest 描述命令执行器的一次执行请求。
type ExecutorRequest struct {
	// ConnID 数据库连接 ID
	ConnID int64 `json:"connId"`
	// Database 执行时使用的库；为空表示连接配置的默认库
	Database string `json:"database"`
	// SQL 待执行的 SQL（多条语句时由前端切出当前语句）
	SQL string `json:"sql"`
	// Limit 查询返回行数上限；小于等于 0 时取默认值
	Limit int `json:"limit"`
	// Page 页码，从 1 开始；小于等于 0 表示不分页
	Page int `json:"page"`
	// PageSize 每页条数；小于等于 0 时取默认值；为 0 且 Page 大于 0 时按默认页大小
	PageSize int `json:"pageSize"`
	// Total 调用方缓存的总数；翻页时带回可跳过统计
	Total int64 `json:"total"`
	// CountTotal 是否重新统计总数；首次执行与页大小变化时应置真
	CountTotal bool `json:"countTotal"`
	// AllowProductionWrite 生产库上的写操作确认标记。
	// 前端的生产库守卫只是提示；后端必须自己兜底，否则改一个布尔就能绕过。
	AllowProductionWrite bool `json:"allowProductionWrite"`
}

// ExecutorResult 命令执行器的执行结果。
type ExecutorResult struct {
	// Kind 结果类型："query"（有结果集）或 "exec"（写操作 / DDL）
	Kind string `json:"kind"`
	// Columns 结果列元信息（仅 query）
	Columns []ColumnMeta `json:"columns"`
	// Rows 结果集（仅 query）
	Rows []map[string]any `json:"rows"`
	// SQL 实际执行的 SQL（分页时含追加的 LIMIT）
	SQL string `json:"sql"`
	// Database 实际生效的库 / 模式（后端在会话上钉住的那个），前端展示用于核对
	Database string `json:"database"`
	// ElapsedMs 执行耗时
	ElapsedMs int64 `json:"elapsedMs"`
	// RowCount 结果集行数（仅 query）
	RowCount int `json:"rowCount"`
	// Truncated 结果是否因行数上限被截断
	Truncated bool `json:"truncated"`
	// AffectedRows 写操作影响行数；查询类型恒为 0
	AffectedRows int64 `json:"affectedRows"`
	// Total 满足条件的数据总量；未分页时等于 RowCount
	Total int64 `json:"total"`
	// Page 当前页码，从 1 开始；未分页时为 1
	Page int `json:"page"`
	// PageSize 每页条数；未分页时为 0
	PageSize int `json:"pageSize"`
	// PageCount 总页数；未分页时为 1
	PageCount int `json:"pageCount"`
}

// ExecutorColumn 描述一张表的字段（智能补全与元数据用）。
type ExecutorColumn struct {
	// Name 字段名
	Name string `json:"name"`
	// DataType 字段的完整类型定义（如 varchar(32) / decimal(10,2) / bigint）
	DataType string `json:"dataType"`
	// Comment 字段注释
	Comment string `json:"comment"`
}

// ExecuteStatement 执行用户输入的任意 SQL（命令执行器）。
//
// 与模板链路 Execute 的区别：
//   - SQL 即用户输入，不做模板渲染与脚本加工；
//   - ctx 由 Wails 绑定注入，前端「取消」会同步终止数据库端的查询；
//   - 按首关键字自动区分查询与写操作，写操作返回影响行数；
//   - Database 非空时临时切换到所选库执行。
//
// **所选库怎么生效（关键）**：打开一个固定会话后，在该会话上显式切库
// （MySQL → `USE`、PostgreSQL → `SET search_path`），而不是只改 DSN 的 dbname。
// 后者依赖「每次都是新连接 + 驱动按预期解析」，一旦连接池复用或拼装出意外，
// 语句就会悄悄落在别的库上，现象正是「明明选了库却查不到数据」。
// 实际生效的库会随结果回带（ExecutorResult.Database），前端展示便于核对。
func (s *DBService) ExecuteStatement(ctx context.Context, req ExecutorRequest) (*ExecutorResult, error) {
	sqlText := trimTrailingSemicolon(strings.TrimSpace(req.SQL))
	if sqlText == "" {
		return nil, fmt.Errorf("SQL 语句为空")
	}

	conn, err := s.repo.GetConnection(req.ConnID)
	if err != nil {
		return nil, err
	}
	/*
	 * 命令执行器允许临时切换库，但两种方言含义不同：
	 *  - MySQL：库就是库，覆盖连接配置的默认库（进 DSN 的 dbname），下面再 USE 一次钉住；
	 *  - PostgreSQL：DSN 的 database 是集群概念，不能拿 schema 去连（见 schemaName 的说明），
	 *    所以连接仍用连接自身的库，「所选库」按 schema 通过 search_path 生效。
	 */
	if req.Database != "" && !isPostgresType(conn.DBType) {
		conn.Database = req.Database
	}

	db, err := s.openConnection(*conn)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	/*
	 * 只读连接：后端兜底拒绝写操作（前端也会提示，但不能只依赖前端）。
	 * 只看首关键字不够 —— `SELECT ... INTO OUTFILE` 会写文件、
	 * `SELECT ... FOR UPDATE` 会加写锁，它们的首关键字都是 SELECT。
	 */
	if conn.ReadOnly {
		if !isQueryStatement(sqlText) {
			return nil, fmt.Errorf("连接「%s」已设为只读，已拒绝执行该写操作", conn.Name)
		}
		if reason := readOnlyForbiddenReason(sqlText); reason != "" {
			return nil, fmt.Errorf("连接「%s」已设为只读，已拒绝执行（%s）", conn.Name, reason)
		}
	}

	// 生产库：写操作必须有确认标记，后端不信任前端的守卫
	if conn.IsProduction && !isQueryStatement(sqlText) && !req.AllowProductionWrite {
		return nil, fmt.Errorf("连接「%s」已标记为生产库，写操作需要确认后才能执行", conn.Name)
	}

	/*
	 * 语句超时：连接配置优先（QueryTimeoutSecs），但不超过兜底上限，
	 * 否则一个手滑填大的值会让语句无限挂起。
	 */
	timeout := executorMaxDuration
	if seconds := conn.QueryTimeoutSecs; seconds > 0 {
		if custom := time.Duration(seconds) * time.Second; custom < timeout {
			timeout = custom
		}
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	limit := req.Limit
	if limit <= 0 {
		limit = defaultExecutorLimit
	}
	if limit > maxRows {
		limit = maxRows
	}

	// 固定会话：切库必须在同一条连接上执行，查询 / 写操作也都走它
	session, err := db.Conn(runCtx)
	if err != nil {
		return nil, fmt.Errorf("获取数据库连接失败: %w", err)
	}
	defer session.Close()

	effectiveDB, err := pinDatabase(runCtx, session, *conn, req.Database)
	if err != nil {
		return nil, err
	}

	start := time.Now()
	if isQueryStatement(sqlText) {
		/*
		 * 分页：与模板查询链路共用 preparePagination——
		 * 「哪些语句能分页、怎么拼 LIMIT」两边完全一致。
		 * 统计总数必须用未加分页的原文，否则会被页大小截断。
		 */
		countableSQL := sqlText
		pageSize := 0
		page := 1
		total := int64(0)
		sqlText, pageSize = preparePagination(countableSQL, req.Page, req.PageSize)
		if pageSize > 0 {
			page = req.Page
			if req.CountTotal || req.Total <= 0 {
				total, err = queryTotal(runCtx, session, countableSQL)
				if err != nil {
					return nil, hintDatabaseError(err)
				}
			} else {
				total = req.Total
			}
			// 页大小可能大于默认行数上限，抬高上限以免分页结果被截断
			if pageSize > limit {
				limit = pageSize
			}
		}

		rows, columns, truncated, err := queryRowsLimited(runCtx, session, sqlText, limit)
		if err != nil {
			return nil, hintDatabaseError(err)
		}

		// 结果列注释 / 来源表 / 含长度的类型：查一次数据字典补上（独立短超时，失败静默跳过）
		commentCtx, cancelComments := context.WithTimeout(ctx, metaTimeout)
		annotateResultColumns(commentCtx, session, conn.DBType, effectiveDB, countableSQL, columns)
		cancelComments()
		result := &ExecutorResult{
			Kind:      "query",
			Columns:   columns,
			Rows:      rows,
			SQL:       sqlText,
			Database:  effectiveDB,
			ElapsedMs: time.Since(start).Milliseconds(),
			RowCount:  len(rows),
			Truncated: truncated,
			Total:     int64(len(rows)),
			Page:      1,
			PageCount: 1,
		}
		if pageSize > 0 {
			result.Total = total
			result.Page = page
			result.PageSize = pageSize
			result.PageCount = calcPageCount(total, pageSize)
		}
		return result, nil
	}

	result, err := session.ExecContext(runCtx, sqlText)
	if err != nil {
		return nil, hintDatabaseError(fmt.Errorf("执行 SQL 失败: %w", err))
	}
	affected, _ := result.RowsAffected()
	return &ExecutorResult{
		Kind:         "exec",
		SQL:          sqlText,
		Database:     effectiveDB,
		ElapsedMs:    time.Since(start).Milliseconds(),
		AffectedRows: affected,
	}, nil
}

// pinDatabase 在会话上切换到目标库 / 模式，返回实际生效的名字（用于回带前端）。
//
// 目标取「本次请求指定的库」，为空时回落到连接配置里的默认库；
// 两者都为空时 MySQL 会明确报错，而不是让语句带着「没有默认库」的状态去撞 1046。
func pinDatabase(ctx context.Context, session *sql.Conn, conn database.DBConnection, requested string) (string, error) {
	target := requested
	if target == "" {
		target = conn.Database
	}

	if isPostgresType(conn.DBType) {
		if target == "" {
			// 没指定模式时用连接配置里的默认 schema（DefaultSchema）
			target = conn.DefaultSchema
		}
		if target == "" {
			// 仍然没有：清掉可能残留在池化连接上的 search_path，避免结果取决于连接复用
			if _, err := session.ExecContext(ctx, "RESET search_path"); err != nil {
				return "", fmt.Errorf("重置 search_path 失败: %w", err)
			}
			return conn.Database, nil
		}
		if _, err := session.ExecContext(ctx, "SET search_path TO "+quoteLiteralIdentifier(target, conn.DBType)); err != nil {
			return "", fmt.Errorf("切换到模式 %s 失败: %w", target, err)
		}
		return target, nil
	}

	if target == "" {
		/*
		 * 没有任何库可切：不再直接报错。
		 * 带库名的语句（`库`.`表`）并不需要默认库，直接放行；
		 * 不带库名的语句会撞上 MySQL 的 1046，由 hintDatabaseError
		 * 补上「请在上方选择库 / 加库名 / 配置默认库」的可操作提示。
		 * （此前在这里硬报错，导致「分析带库名的语句」也被拦下。）
		 */
		return "", nil
	}
	if _, err := session.ExecContext(ctx, "USE "+quoteLiteralIdentifier(target, conn.DBType)); err != nil {
		return "", fmt.Errorf("切换到数据库 %s 失败: %w", target, err)
	}
	return target, nil
}

// hintDatabaseError 把「没有默认库」这类底层报错补上可操作的提示。
func hintDatabaseError(err error) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	if strings.Contains(message, "No database selected") || strings.Contains(message, "1046") {
		return fmt.Errorf("%w（当前会话没有默认库：请在上方下拉框选择库，给表名加上 `库`.`表`，或在连接配置里设置默认库）", err)
	}
	return err
}

// quoteLiteralIdentifier 按方言给标识符加引号（MySQL 反引号 / 其他双引号）。
func quoteLiteralIdentifier(name string, dbType string) string {
	if isPostgresType(dbType) {
		return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	}
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

// isQueryStatement 判断语句是否返回结果集。
//
// 关键字取自共用的 mainStatementKeyword：WITH 开头会穿透 CTE 看主语句，
// 因此 `WITH x AS (…) INSERT …` 会被正确判为写操作（以前一律当查询）。
// 判断失误时最坏情况是写操作返回 0 行结果集，不影响数据正确性。
func isQueryStatement(sqlText string) bool {
	switch mainStatementKeyword(sqlText) {
	case "select", "show", "describe", "desc", "explain", "table", "values":
		return true
	}
	return false
}

/*
 * 只读连接下仍可能藏着的写操作。
 *
 * 这些写法的首关键字都是 SELECT，`isQueryStatement` 会放行，
 * 因此需要在只读连接上额外拦一道。
 */
var readOnlyForbidden = []struct {
	pattern *regexp.Regexp
	reason  string
}{
	{regexp.MustCompile(`(?i)\binto\s+(outfile|dumpfile)\b`), "SELECT ... INTO OUTFILE 会把结果写到服务器文件"},
	{regexp.MustCompile(`(?i)\bfor\s+update\b`), "SELECT ... FOR UPDATE 会加排他写锁"},
	{regexp.MustCompile(`(?i)\block\s+in\s+share\s+mode\b`), "LOCK IN SHARE MODE 会加共享锁"},
}

// readOnlyForbiddenReason 命中上面的写法时返回原因，否则返回空串。
func readOnlyForbiddenReason(sqlText string) string {
	for _, item := range readOnlyForbidden {
		if item.pattern.MatchString(sqlText) {
			return item.reason
		}
	}
	return ""
}

// ListDatabases 返回连接可见的所有数据库（库选择下拉）。
//
// 每一项带「是否系统库」标记：这个判断由**后端按方言**给出（MySQL 与 PostgreSQL
// 的自带对象完全不同），前端只按设置过滤，不再自己维护一份方言表。
func (s *DBService) ListDatabases(ctx context.Context, connID int64) ([]DatabaseInfo, error) {
	conn, err := s.repo.GetConnection(connID)
	if err != nil {
		return nil, err
	}

	db, err := s.openConnection(*conn)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	queryCtx, cancel := context.WithTimeout(ctx, metaTimeout)
	defer cancel()

	rows, err := db.QueryContext(queryCtx, "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name")
	if err != nil {
		return nil, fmt.Errorf("读取数据库列表失败: %w", err)
	}
	names, err := scanStringRows(rows)
	if err != nil {
		return nil, err
	}

	infos := make([]DatabaseInfo, 0, len(names))
	for _, name := range names {
		infos = append(infos, DatabaseInfo{Name: name, IsSystem: isSystemDatabase(conn.DBType, name)})
	}
	return infos, nil
}

// ListTables 返回指定库（PostgreSQL 下为 schema）下的表与视图名。
func (s *DBService) ListTables(ctx context.Context, connID int64, database string) ([]string, error) {
	// 元数据查询是按 schema 过滤的，连接本身仍用连接配置的库：
	// PostgreSQL 下把 schema 当库名传给驱动会连到不存在的库。
	conn, db, closeDB, err := s.openExecutorConn(connID, "")
	if err != nil {
		return nil, err
	}
	defer closeDB()

	queryCtx, cancel := context.WithTimeout(ctx, metaTimeout)
	defer cancel()

	query := "SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name"
	rows, err := db.QueryContext(queryCtx, query, schemaName(database, conn.DBType))
	if err != nil {
		return nil, fmt.Errorf("读取表列表失败: %w", err)
	}
	return scanStringRows(rows)
}

// ListTableColumns 返回指定表的字段信息（名称 / 类型 / 注释）。
// database 在 MySQL 下是库名、PostgreSQL 下是 schema（见 schemaName）。
func (s *DBService) ListTableColumns(ctx context.Context, connID int64, database string, table string) ([]ExecutorColumn, error) {
	// 同 ListTables：连接用连接自身的库，库/schema 只作为查询条件
	conn, db, closeDB, err := s.openExecutorConn(connID, "")
	if err != nil {
		return nil, err
	}
	defer closeDB()

	queryCtx, cancel := context.WithTimeout(ctx, metaTimeout)
	defer cancel()

	// 只有 MySQL 的 information_schema.columns 带注释列
	var query string
	if isPostgresType(conn.DBType) {
		/*
		 * PostgreSQL 的 data_type 不带长度（`character varying`），
		 * 这里用 udt_name + 长度 / 精度拼出展示用类型（varchar(32) / numeric(10,2)）：
		 *  - character_maximum_length 只对字符类型有值，其它类型为 NULL；
		 *  - numeric_precision / numeric_scale 对整数类型同样有值，必须限定在 numeric / decimal 上；
		 *  - 数组类型的 udt_name 是 `_int4` 这种内部名，直接用 data_type（ARRAY）。
		 */
		query = `SELECT column_name,
		                CASE
		                  WHEN data_type = 'ARRAY' THEN data_type
		                  WHEN data_type = 'character' AND character_maximum_length IS NOT NULL
		                    THEN 'char(' || character_maximum_length || ')'
		                  WHEN character_maximum_length IS NOT NULL
		                    THEN udt_name || '(' || character_maximum_length || ')'
		                  WHEN data_type IN ('numeric', 'decimal') AND numeric_precision IS NOT NULL
		                    THEN udt_name || '(' || numeric_precision || ',' || COALESCE(numeric_scale, 0) || ')'
		                  ELSE udt_name
		                END,
		                ''
		         FROM information_schema.columns
		         WHERE table_schema = ? AND table_name = ?
		         ORDER BY ordinal_position`
	} else {
		// MySQL / MariaDB 的 column_type 本身就是完整定义（varchar(32) / decimal(10,2) / enum('a','b')）
		query = `SELECT column_name, column_type, column_comment
		         FROM information_schema.columns
		         WHERE table_schema = ? AND table_name = ?
		         ORDER BY ordinal_position`
	}

	rows, err := db.QueryContext(queryCtx, query, schemaName(database, conn.DBType), table)
	if err != nil {
		return nil, fmt.Errorf("读取字段信息失败: %w", err)
	}
	defer rows.Close()

	columns := make([]ExecutorColumn, 0, 32)
	for rows.Next() {
		var col ExecutorColumn
		if err := rows.Scan(&col.Name, &col.DataType, &col.Comment); err != nil {
			return nil, fmt.Errorf("读取字段信息失败: %w", err)
		}
		columns = append(columns, col)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历字段信息失败: %w", err)
	}
	return columns, nil
}

// ForeignKey 表间外键约束（智能补全用它生成 `ON a.x = b.y` 形式的关联条件）。
type ForeignKey struct {
	// Column 本表的列名
	Column string `json:"column"`
	// ReferencedTable 被引用的表
	ReferencedTable string `json:"referencedTable"`
	// ReferencedColumn 被引用的列名（通常是 id）
	ReferencedColumn string `json:"referencedColumn"`
}

// ListForeignKeys 返回指定表的外键约束。
//
// database 在 MySQL 下是库名、PostgreSQL 下是 schema（见 schemaName）。
// 取不到（无 information_schema 权限 / 表没有外键）时前端会退化为命名启发式，
// 因此这里如实返回错误即可 —— 补全的可用性不依赖它。
func (s *DBService) ListForeignKeys(ctx context.Context, connID int64, database string, table string) ([]ForeignKey, error) {
	// 同 ListTables：连接用连接自身的库，库/schema 只作为查询条件
	conn, db, closeDB, err := s.openExecutorConn(connID, "")
	if err != nil {
		return nil, err
	}
	defer closeDB()

	queryCtx, cancel := context.WithTimeout(ctx, metaTimeout)
	defer cancel()

	/*
		方言差异：MySQL 的 key_column_usage 直接带 referenced_* 三列；
		PostgreSQL（标准 information_schema）没有这几列，得按约束名绕到
		constraint_column_usage 才能拿到被引用的表 / 列。
	*/
	var query string
	if isPostgresType(conn.DBType) {
		query = `SELECT kcu.column_name, ccu.table_name, ccu.column_name
		         FROM information_schema.table_constraints tc
		         JOIN information_schema.key_column_usage kcu
		           ON kcu.constraint_name = tc.constraint_name
		          AND kcu.constraint_schema = tc.constraint_schema
		         JOIN information_schema.constraint_column_usage ccu
		           ON ccu.constraint_name = tc.constraint_name
		          AND ccu.constraint_schema = tc.constraint_schema
		         WHERE tc.constraint_type = 'FOREIGN KEY'
		           AND tc.table_schema = ? AND tc.table_name = ?
		         ORDER BY tc.constraint_name, kcu.ordinal_position`
	} else {
		query = `SELECT column_name, referenced_table_name, referenced_column_name
		         FROM information_schema.key_column_usage
		         WHERE table_schema = ? AND table_name = ?
		           AND referenced_table_name IS NOT NULL
		         ORDER BY constraint_name, ordinal_position`
	}

	rows, err := db.QueryContext(queryCtx, query, schemaName(database, conn.DBType), table)
	if err != nil {
		return nil, fmt.Errorf("读取外键信息失败: %w", err)
	}
	defer rows.Close()

	keys := make([]ForeignKey, 0, 8)
	for rows.Next() {
		var item ForeignKey
		if err := rows.Scan(&item.Column, &item.ReferencedTable, &item.ReferencedColumn); err != nil {
			return nil, fmt.Errorf("读取外键信息失败: %w", err)
		}
		keys = append(keys, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历外键信息失败: %w", err)
	}
	return keys, nil
}

// CreateTableSQL 返回**数据库自己给出的**建表语句（目前仅 MySQL / MariaDB 支持）。
//
// 为什么值得优先用它：`SHOW CREATE TABLE` 是数据库的权威定义 —— 索引、主键、
// 自增、引擎、字符集、默认值、注释全在里面；前端按 information_schema 拼出来的
// DDL 只能覆盖列定义，索引这些拿不到。
//
// 拿不到时返回**空字符串 + nil 错误**：方言不支持（PostgreSQL 没有对应语句，
// 需要 pg_dump 级别的重建）、表不存在、权限不足都是常态，不是故障 ——
// 由前端回退到自己的生成器，用户照样能复制到一份可用的 DDL。
func (s *DBService) CreateTableSQL(
	ctx context.Context,
	connID int64,
	database string,
	table string,
) (string, error) {
	if strings.TrimSpace(table) == "" {
		return "", nil
	}

	// 同 ListTables：连接用连接自身的库，库 / schema 只作为查询条件
	conn, db, closeDB, err := s.openExecutorConn(connID, "")
	if err != nil {
		return "", err
	}
	defer closeDB()

	if isPostgresType(conn.DBType) {
		return "", nil
	}

	queryCtx, cancel := context.WithTimeout(ctx, metaTimeout)
	defer cancel()

	target := quoteMySQLIdent(table)
	if schema := schemaName(database, conn.DBType); schema != "" {
		target = quoteMySQLIdent(schema) + "." + target
	}

	rows, err := db.QueryContext(queryCtx, "SHOW CREATE TABLE "+target)
	if err != nil {
		return "", nil
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil || len(columns) < 2 {
		return "", nil
	}
	if !rows.Next() {
		return "", nil
	}

	values := make([]sql.NullString, len(columns))
	scans := make([]any, len(columns))
	for i := range values {
		scans[i] = &values[i]
	}
	if err := rows.Scan(scans...); err != nil {
		return "", nil
	}
	/*
		第二列始终是 DDL：表是 (Table, Create Table)，视图是
		(View, Create View, character_set_client, collation_connection)。
	*/
	return strings.TrimSpace(values[1].String), nil
}

// quoteMySQLIdent 用反引号包裹标识符（内部反引号双写转义）。
func quoteMySQLIdent(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

// openExecutorConn 打开命令执行器元数据查询用的连接，并按所选库覆盖默认库。
func (s *DBService) openExecutorConn(connID int64, dbName string) (*database.DBConnection, *sql.DB, func(), error) {
	conn, err := s.repo.GetConnection(connID)
	if err != nil {
		return nil, nil, nil, err
	}
	if dbName != "" && dbName != conn.Database {
		conn.Database = dbName
	}

	db, err := s.openConnection(*conn)
	if err != nil {
		return nil, nil, nil, err
	}
	return conn, db, func() { _ = db.Close() }, nil
}

// scanStringRows 把单列结果集扫描为字符串列表。
func scanStringRows(rows *sql.Rows) ([]string, error) {
	defer rows.Close()

	names := make([]string, 0, 16)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("读取结果失败: %w", err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历结果失败: %w", err)
	}
	return names, nil
}

// DatabaseInfo 库列表项：名字 + 是否系统库。
//
// 「什么算系统库」是**驱动 / 服务端的事实**而不是界面偏好，所以在后端算：
// 前端只按标记过滤（见 frontend/src/utils/sql/sqlVisibility.ts），
// 那边保留的方言表退化为兜底（旧绑定 / 标记缺失时使用）。
type DatabaseInfo struct {
	Name     string `json:"name"`
	IsSystem bool   `json:"isSystem"`
}

// 各方言自带的系统库 / 系统 schema（小写）
var systemDatabaseNames = map[string]map[string]struct{}{
	"mysql": {
		"information_schema": {},
		"mysql":              {},
		"performance_schema": {},
		"sys":                {},
	},
	"postgres": {
		"pg_catalog":         {},
		"information_schema": {},
		"pg_toast":           {},
	},
}

var (
	// PostgreSQL 的临时 schema（pg_temp_3）与 toast 分片（pg_toast_16385）
	pgTempSchemaPattern = regexp.MustCompile(`^pg_temp_?\d*$`)
	pgToastPattern      = regexp.MustCompile(`^pg_toast_\d+$`)
)

// isSystemDatabase 该库（PostgreSQL 下是 schema）是不是系统对象。
//
// 精确比对 + 两条前缀规则，**不做 startsWith("sys") 这类猜测**：
// 用户的 sys_logs、mysql_backup 是业务库，藏掉就是 bug。
func isSystemDatabase(dbType string, name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	if lower == "" {
		return false
	}
	if isPostgresType(dbType) {
		if _, ok := systemDatabaseNames["postgres"][lower]; ok {
			return true
		}
		return pgTempSchemaPattern.MatchString(lower) || pgToastPattern.MatchString(lower)
	}
	_, ok := systemDatabaseNames["mysql"][lower]
	return ok
}

// isPostgresType 判断连接类型是否为 PostgreSQL 系。
func isPostgresType(dbType string) bool {
	switch strings.ToLower(dbType) {
	case "postgres", "postgresql":
		return true
	default:
		return false
	}
}

// schemaName 把元数据接口的「库」参数按方言解释：
// MySQL 直接是库名；PostgreSQL 的 database 是集群概念，这里当 schema 用
// （为空时回落到 public），前端补全的「库名.」因此能覆盖不同 schema。
func schemaName(database string, dbType string) string {
	if database == "" && isPostgresType(dbType) {
		return "public"
	}
	return database
}
