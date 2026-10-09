// Package services 承载业务逻辑，向下调用仓储与脚本引擎，向上暴露给绑定层。
package services

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"

	// 外部数据库驱动（连接与 DSN 见 db_connection.go）
	_ "github.com/lib/pq"

	"toolbox/app/internal/database"
	"toolbox/app/internal/script"
	"toolbox/app/internal/utils"
)

// 查询超时与返回行数上限，防止误操作拖垮应用。
const (
	queryTimeout = 30 * time.Second
	maxRows      = 10000
)

// DBService 负责外部数据库的连接与查询执行。
type DBService struct {
	repo   *database.Repository
	cipher *utils.Cipher
	engine *script.Engine
}

// NewDBService 创建数据库服务。
func NewDBService(repo *database.Repository, cipher *utils.Cipher, engine *script.Engine) *DBService {
	return &DBService{repo: repo, cipher: cipher, engine: engine}
}

// ColumnMeta 描述结果集的一列。
type ColumnMeta struct {
	// Name 列名
	Name string `json:"name"`
	// Type 数据库类型（含长度 / 精度，如 varchar(255) / decimal(10,2)）。
	//
	// 长度优先取数据字典（information_schema.columns.column_type，精确），
	// 取不到时退回驱动给的粗略类型名（见 columnTypeOf）；
	// 驱动不支持类型信息时为空。
	Type string `json:"type"`
	// Comment 字段注释（从数据字典反查；表达式列 / 别名列 / 非 MySQL 方言为空）
	Comment string `json:"comment"`
	// Table 来源表（注释反查时一并带出；表达式列 / 别名列 / 非 MySQL 方言为空）
	Table string `json:"table"`
}

// 分页参数的取值边界：与仓储层的落库约束保持一致。
const (
	defaultPageSize = 50
	maxPageSize     = 1000
	// maxPage 页码上限：OFFSET = (page-1)*pageSize，
	// 页码不设限的话 page=1e9 会算出天文数字的 OFFSET，退化成极慢的扫描。
	maxPage = 100000
)

// QueryResult 描述一次查询的完整结果。
type QueryResult struct {
	// Columns 列元信息（保持数据库返回顺序）
	Columns []ColumnMeta `json:"columns"`
	// Rows 结果集
	Rows []map[string]any `json:"rows"`
	// SQL 实际执行的 SQL，便于用户核对模板渲染结果
	SQL string `json:"sql"`
	// ElapsedMs 执行耗时
	ElapsedMs int64 `json:"elapsedMs"`
	// RowCount 返回行数
	RowCount int `json:"rowCount"`
	// Truncated 是否因超出上限被截断
	Truncated bool `json:"truncated"`
	// Total 满足条件的数据总量；未分页时等于 RowCount
	Total int64 `json:"total"`
	// Page 当前页码，从 1 开始；未分页时为 1
	Page int `json:"page"`
	// PageSize 每页条数；未分页时为 0
	PageSize int `json:"pageSize"`
	// PageCount 总页数；未分页时为 1
	PageCount int `json:"pageCount"`
	// Database 实际生效的库 / 模式（会话上钉住的那个），前端展示与后续操作用于核对
	Database string `json:"database"`
}

// ExecuteRequest 描述一次查询请求。
type ExecuteRequest struct {
	ConnID      int64          `json:"connId"`
	SQLTemplate string         `json:"sqlTemplate"`
	Variables   map[string]any `json:"variables"`
	PreScript   string         `json:"preScript"`
	PostScript  string         `json:"postScript"`
	// Database 本次查询使用的库 / 模式；空表示用连接配置里的默认库。
	// 与执行器的语义一致：会把它「钉」在会话上，而不是只改 DSN。
	Database string `json:"database"`
	// Page 页码，从 1 开始；小于等于 0 表示不分页
	Page int `json:"page"`
	// PageSize 每页条数；小于等于 0 时取默认值
	PageSize int `json:"pageSize"`
	// Total 调用方缓存的总数；用于翻页时跳过统计
	Total int64 `json:"total"`
	// CountTotal 是否重新统计总数；首次执行与条件变化时应置真
	CountTotal bool `json:"countTotal"`
}

// Execute 执行查询的完整链路：
// 前置脚本 → 模板渲染(text/template) → 执行 SQL → 后置脚本。
//
// ctx 由调用方（Wails 绑定注入的上下文）提供：前端点「取消」时能真正
// 中断数据库端的语句，而不是继续跑到超时为止。
func (s *DBService) Execute(ctx context.Context, req ExecuteRequest) (*QueryResult, error) {
	// 1. 前置脚本：允许修改变量并动态生成 SQL 片段
	pre, err := s.engine.RunPreScript(req.PreScript, req.Variables, req.SQLTemplate)
	if err != nil {
		return nil, fmt.Errorf("前置脚本执行失败: %w", err)
	}

	// 2. 渲染模板：text/template（用户无需写点号，预处理会自动补全）
	finalSQL, err := s.renderSQL(req.SQLTemplate, pre.Variables)
	if err != nil {
		return nil, err
	}
	finalSQL += pre.SQLFragment

	if strings.TrimSpace(finalSQL) == "" {
		return nil, fmt.Errorf("渲染后的 SQL 为空，请检查模板与变量配置")
	}

	// 3. 连接并执行
	conn, err := s.repo.GetConnection(req.ConnID)
	if err != nil {
		return nil, err
	}

	db, err := s.openConnection(*conn)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	// 超时仍要兜底：调用方 ctx 可能没有截止时间（直接调用时）
	runCtx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()

	/*
	 * 固定会话 + 钉库：前端选了库（或连接配了默认库）时，把它「钉」在会话上，
	 * 而不是指望 DSN 的 dbname —— 语义与执行器完全一致（见 ExecuteStatement）。
	 * 统计总数、取数、注释反查必须都在这条会话上，否则各自可能落在不同的库。
	 */
	session, err := db.Conn(runCtx)
	if err != nil {
		return nil, fmt.Errorf("获取数据库连接失败: %w", err)
	}
	defer session.Close()

	effectiveDB, err := pinDatabase(runCtx, session, *conn, req.Database)
	if err != nil {
		return nil, err
	}

	// 3.1 分页：先确定总量，再按页取数。
	//
	// 分页判定与改写走共用的 preparePagination（哪些语句能分页、怎么拼都由它决定），
	// 因此这里必须先留下「未加分页」的原文——统计总数要对它做，否则会被页大小截断。
	//
	// 总量的获取有两种途径：
	//   - CountTotal 为真（首次执行或查询条件变化）：真实统计一次；
	//   - 否则沿用调用方带回的上次总数（翻页场景），省掉一次全量扫描。
	// 翻页复用总数属于「最终一致」：期间数据有增删时页数可能略有偏差，
	// 用户重新执行查询（CountTotal 为真）即会刷新。
	countableSQL := finalSQL
	finalSQL, pageSize := preparePagination(countableSQL, req.Page, req.PageSize)

	total := int64(0)
	page := 1
	if pageSize > 0 {
		page = req.Page
		if req.CountTotal || req.Total <= 0 {
			total, err = queryTotal(runCtx, session, countableSQL)
			if err != nil {
				return nil, err
			}
		} else {
			total = req.Total
		}
	}
	// 未分页（用户没要求，或语句不支持分页）时 pageSize 为 0，
	// Total 保持「本次行数」由下面回填。

	start := time.Now()
	rows, columns, truncated, err := queryRows(runCtx, session, finalSQL)
	if err != nil {
		return nil, err
	}
	elapsed := time.Since(start).Milliseconds()

	/*
	 * 结果列注释 / 来源表 / 含长度的类型：查一次数据字典补上（独立短超时，失败静默跳过）。
	 * 表名取「未加分页的原文」，与结果列同源；库用**实际生效的库** ——
	 * 用连接默认库的话，没配默认库的连接会查空（模板查询曾因此没有描述）。
	 */
	commentCtx, cancelComments := context.WithTimeout(ctx, metaTimeout)
	annotateResultColumns(commentCtx, session, conn.DBType, effectiveDB, countableSQL, columns)
	cancelComments()

	// 4. 后置脚本：对结果集做加工
	post, err := s.engine.RunPostScript(req.PostScript, rows)
	if err != nil {
		return nil, fmt.Errorf("后置脚本执行失败: %w", err)
	}

	rowCount := len(post.Rows)
	result := &QueryResult{
		Columns:   columns,
		Rows:      post.Rows,
		SQL:       finalSQL,
		Database:  effectiveDB,
		ElapsedMs: elapsed,
		RowCount:  rowCount,
		Truncated: truncated,
		Total:     int64(rowCount),
		Page:      1,
		PageCount: 1,
	}

	// 分页场景回填分页信息；未分页时 Total 即本次返回的行数
	if pageSize > 0 {
		result.Total = total
		result.Page = page
		result.PageSize = pageSize
		result.PageCount = calcPageCount(total, pageSize)
	}
	return result, nil
}

// calcPageCount 由总条数与页大小计算总页数，空结果也记 1 页。
func calcPageCount(total int64, pageSize int) int {
	if pageSize <= 0 {
		return 1
	}
	count := int((total + int64(pageSize) - 1) / int64(pageSize))
	if count < 1 {
		return 1
	}
	return count
}

// renderSQL 渲染 SQL 模板。
//
// 关键点：执行前会把模板中检测到的变量补全为空字符串。
// 原因是 text/template 配合 missingkey=error 时，访问不存在的 key 会直接报错，
// 而「变量留空即跳过该条件」（{{if device_no}}）是本工具的核心用法。
// 补全后仍缺失的 key 才是真正的拼写错误，此时报错才有意义。
func (s *DBService) renderSQL(tplText string, variables map[string]any) (string, error) {
	if variables == nil {
		variables = map[string]any{}
	}

	// 补齐模板中引用但调用方未提供的变量
	for _, name := range utils.ExtractTemplateVariables(tplText) {
		if _, exists := variables[name]; !exists {
			variables[name] = ""
		}
	}

	rendered, err := utils.RenderSQL(tplText, variables)
	if err != nil {
		return "", fmt.Errorf("SQL 模板渲染失败: %w", err)
	}
	return rendered, nil
}

// 连接的增删改查、连通性测试与 DSN 构造见 db_connection.go。

// QueryOptionsForVariable 执行一条 SQL 以获取下拉框选项。
// 供变量配置中「动态选项来源」使用。
//
// database 非空时按所选库 / 模式执行，与查询（Execute）、命令执行器同一套语义：
// 固定会话后用 pinDatabase 钉住（MySQL → `USE`、PostgreSQL → `SET search_path`），
// 而不是只改 DSN 的 dbname —— 池化复用下后者会让语句悄悄落到别的库上。
// 两者都没指定时不切库（pinDatabase 直接放行），`库`.`表` 全限定名的写法继续可用。
func (s *DBService) QueryOptionsForVariable(
	ctx context.Context,
	connID int64,
	database string,
	query string,
) ([]map[string]any, error) {
	conn, err := s.repo.GetConnection(connID)
	if err != nil {
		return nil, err
	}

	db, err := s.openConnection(*conn)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	runCtx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()

	session, err := db.Conn(runCtx)
	if err != nil {
		return nil, fmt.Errorf("获取数据库连接失败: %w", err)
	}
	defer session.Close()

	if _, err := pinDatabase(runCtx, session, *conn, database); err != nil {
		return nil, err
	}

	rows, _, _, err := queryRows(runCtx, session, query)
	if err != nil {
		return nil, hintDatabaseError(err)
	}
	return rows, nil
}

// ---------------------------------------------------------------- 模板执行

// TemplateExecuteRequest 描述一次「按模板执行」的请求。
type TemplateExecuteRequest struct {
	TemplateID int64          `json:"templateId"`
	ConnID     int64          `json:"connId"`
	Variables  map[string]any `json:"variables"`
	// Database 本次查询使用的库 / 模式；空表示用连接配置里的默认库
	Database string `json:"database"`
	// Page 请求的页码，从 1 开始；小于等于 0 表示本次不分页
	Page int `json:"page"`
	// PageSize 每页条数；小于等于 0 时取默认值
	PageSize int `json:"pageSize"`
	// Total 上一次返回的总数；翻页时带回可避免重复统计
	Total int64 `json:"total"`
	// CountTotal 是否重新统计总数；翻页时为 false
	CountTotal bool `json:"countTotal"`
}

// ExecuteTemplateQuery 按模板执行查询。
//
// 与 Execute 的区别：SQL、脚本等均从模板表读取，前端只传模板 ID 与变量值。
// 这样模板更新后，引用它的 Tab 无需同步即可在下次执行时生效。
//
// 分页不再有开关：前端传页码即分页（页大小缺省取 defaultPageSize），
// 传 Page <= 0 表示本次不分页（对应界面上把页大小设为 0）。
func (s *DBService) ExecuteTemplateQuery(
	ctx context.Context,
	req TemplateExecuteRequest,
) (*QueryResult, error) {
	tpl, err := s.repo.GetTemplate(req.TemplateID)
	if err != nil {
		return nil, err
	}

	/*
	 * 停用的模板不允许执行。
	 *
	 * 拦截放在这里而不是只放前端：模板可能被其它标签页 / 旧状态引用，
	 * 「停用」的语义必须在真正跑 SQL 的这一层成立，否则停用形同虚设。
	 */
	if !tpl.Enabled {
		return nil, fmt.Errorf("模板「%s」已停用，请先在 SQL 模板管理中启用", tpl.Name)
	}

	// 连接优先使用入参，未指定时回退到模板上配置的连接
	connID := req.ConnID
	if connID <= 0 {
		connID = tpl.ConnID
	}
	if connID <= 0 {
		return nil, fmt.Errorf("模板未关联数据库连接，请先选择连接")
	}

	page := req.Page
	if page < 0 {
		page = 0
	}
	// 页码也要有上限：page=1e9 会算出天文数字的 OFFSET，
	// 在数据库端退化成一次极慢的全表扫描。
	if page > maxPage {
		page = maxPage
	}
	pageSize := req.PageSize
	if page > 0 && pageSize <= 0 {
		pageSize = defaultPageSize
	}
	if pageSize > maxPageSize {
		pageSize = maxPageSize
	}

	return s.Execute(ctx, ExecuteRequest{
		ConnID:      connID,
		SQLTemplate: tpl.SQLText,
		Variables:   req.Variables,
		PreScript:   tpl.PreScript,
		PostScript:  tpl.PostScript,
		Database:    req.Database,
		Page:        page,
		PageSize:    pageSize,
		Total:       req.Total,
		CountTotal:  req.CountTotal,
	})
}

// ---------------------------------------------------------------- 内部实现

// rowQueryer 只依赖 QueryContext：让查询既能跑在连接池（*sql.DB）上，
// 也能跑在固定会话（*sql.Conn）上——后者是「切库能生效」的前提。
type rowQueryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// queryRows 执行查询并返回列元信息与结果集（行数上限取全局默认）。
func queryRows(ctx context.Context, db rowQueryer, query string) ([]map[string]any, []ColumnMeta, bool, error) {
	return queryRowsLimited(ctx, db, query, maxRows)
}

// queryRowsLimited 执行查询并返回列元信息与结果集，行数超过 limit 时截断。
func queryRowsLimited(ctx context.Context, db rowQueryer, query string, limit int) ([]map[string]any, []ColumnMeta, bool, error) {
	if limit <= 0 {
		limit = maxRows
	}

	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, false, fmt.Errorf("执行 SQL 失败: %w", err)
	}
	defer rows.Close()

	rawColumns, err := rows.Columns()
	if err != nil {
		return nil, nil, false, fmt.Errorf("读取列信息失败: %w", err)
	}

	// 尝试读取数据库类型信息；部分驱动不支持时降级为空类型
	columnTypes, _ := rows.ColumnTypes()
	columns := make([]ColumnMeta, len(rawColumns))
	for i, name := range rawColumns {
		columns[i] = ColumnMeta{Name: name}
		if columnTypes != nil && i < len(columnTypes) && columnTypes[i] != nil {
			columns[i].Type = columnTypeOf(columnTypes[i])
		}
	}

	result := make([]map[string]any, 0)
	truncated := false

	for rows.Next() {
		if len(result) >= limit {
			truncated = true
			break
		}

		// 用 RawBytes 承接任意类型，再按列转换
		values := make([]any, len(rawColumns))
		pointers := make([]any, len(rawColumns))
		for i := range values {
			pointers[i] = &values[i]
		}

		if err := rows.Scan(pointers...); err != nil {
			return nil, nil, false, fmt.Errorf("读取结果行失败: %w", err)
		}

		item := make(map[string]any, len(rawColumns))
		for i, col := range rawColumns {
			item[col] = normalizeValue(values[i])
		}
		result = append(result, item)
	}

	if err := rows.Err(); err != nil {
		return nil, nil, false, fmt.Errorf("遍历结果集失败: %w", err)
	}
	return result, columns, truncated, nil
}

/*
 * columnTypeOf 把驱动的列类型整理成展示用的类型名。
 *
 * 只补 DECIMAL 这类精度（precision, scale）—— 它是驱动明确给出的语义。
 *
 * 刻意**不用** Length()：MySQL 下它给的是字节长度（utf8mb4 的 varchar(255)
 * 会报 1020），直接展示会误导；字符串 / 时间的声明长度由数据字典反查补上
 * （见 annotateResultColumns），那是精确的。
 */
func columnTypeOf(columnType *sql.ColumnType) string {
	name := columnType.DatabaseTypeName()
	if name == "" {
		return ""
	}
	if precision, scale, ok := columnType.DecimalSize(); ok {
		return fmt.Sprintf("%s(%d,%d)", name, precision, scale)
	}
	return name
}

// trimTrailingSemicolon 去掉 SQL 结尾的分号与空白。
// 包装成子查询时末尾分号会破坏语法，必须先清理。
func trimTrailingSemicolon(query string) string {
	return strings.TrimSpace(strings.TrimRight(strings.TrimSpace(query), ";"))
}

// queryTotal 统计查询的总数据量。
// 先用 buildCountSQL 尽量把原 SQL 改写成 COUNT(*)（能去掉无用的 ORDER BY、
// 避免派生表物化），改写不安全时再退回「包一层子查询」的通用做法。
//
// 参数用 rowQueryer 而非 *sql.DB：执行器的分页跑在固定会话（*sql.Conn）上，
// 统计总数也必须走同一条连接，否则切库 / search_path 不生效。
func queryTotal(ctx context.Context, db rowQueryer, query string) (int64, error) {
	rows, err := db.QueryContext(ctx, buildCountSQL(query))
	if err != nil {
		return 0, fmt.Errorf("统计总数据量失败: %w", err)
	}
	defer rows.Close()

	var total int64
	if !rows.Next() {
		return 0, fmt.Errorf("统计总数据量失败: 未返回结果")
	}
	if err := rows.Scan(&total); err != nil {
		return 0, fmt.Errorf("统计总数据量失败: %w", err)
	}
	return total, nil
}

// buildCountSQL 生成统计总数的 SQL。
//
// 优先级：
//  1. 简单查询（无 distinct / group by / having / union / CTE）→
//     直接把 SELECT 列表替换成 COUNT(*)，并去掉末尾 ORDER BY；
//  2. 其余情况 → SELECT COUNT(*) FROM (原SQL) AS __toolbox_total。
//
// 第 1 种能显著减少开销：数据库无需物化整个结果集，也无需做无意义的排序。
func buildCountSQL(query string) string {
	base := trimTrailingSemicolon(query)
	if simple, ok := rewriteAsCount(base); ok {
		return simple
	}
	return fmt.Sprintf(
		"SELECT COUNT(*) FROM (%s) AS __toolbox_total",
		stripTrailingOrderBy(base),
	)
}

// rewriteAsCount 把「SELECT 列表 … FROM …」改写为「SELECT COUNT(*) FROM …」。
// 仅在不改变语义的前提下改写，否则返回 ok=false 交由调用方兜底。
func rewriteAsCount(query string) (string, bool) {
	// 含这些子句时行数与 SELECT 列表相关，改写会改变计数结果
	for _, keyword := range []string{"distinct", "group by", "having", "union"} {
		if indexOfTopLevelKeyword(query, keyword) >= 0 {
			return "", false
		}
	}

	// CTE（WITH …）无法简单替换 SELECT 列表，交给通用兜底
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(query)), "select") {
		return "", false
	}

	fromIdx := indexOfTopLevelKeyword(query, "from")
	if fromIdx <= 0 {
		return "", false
	}

	countSQL := "SELECT COUNT(*) " + query[fromIdx:]
	return stripTrailingOrderBy(countSQL), true
}

// stripTrailingOrderBy 去掉 SQL 末尾最外层的 ORDER BY 及其之后的内容。
// 计数不需要排序，留着它只会让数据库多一次排序（PostgreSQL 尤其明显）。
func stripTrailingOrderBy(query string) string {
	idx := indexOfTopLevelKeyword(query, "order by")
	if idx <= 0 {
		return query
	}
	return strings.TrimSpace(query[:idx])
}

// indexOfTopLevelKeyword 在最外层（不在子查询、引号、注释内）查找关键字。
// 返回字节下标，未找到返回 -1。
//
// 关键字两侧必须是非标识符字符，避免把 ordering 之类字段名误判为 order by。
func indexOfTopLevelKeyword(query, keyword string) int {
	// 逐字节做 ASCII 大小写无关比较，避免 ToLower 改变字节长度导致下标错位
	target := strings.ToLower(keyword)
	depth := 0
	inSingle, inDouble, inBacktick := false, false, false
	inLineComment, inBlockComment := false, false

	quoted := func() bool { return inSingle || inDouble || inBacktick }

	for i := 0; i < len(query); i++ {
		c := query[i]

		if inLineComment {
			if c == '\n' {
				inLineComment = false
			}
			continue
		}
		if inBlockComment {
			if c == '*' && i+1 < len(query) && query[i+1] == '/' {
				inBlockComment = false
				i++
			}
			continue
		}

		switch c {
		case '\'':
			if !quoted() || inSingle {
				inSingle = !inSingle
			}
		case '"':
			if !quoted() || inDouble {
				inDouble = !inDouble
			}
		case '`':
			if !quoted() || inBacktick {
				inBacktick = !inBacktick
			}
		case '-':
			if !quoted() && i+1 < len(query) && query[i+1] == '-' {
				inLineComment = true
				i++
			}
		case '/':
			if !quoted() && i+1 < len(query) && query[i+1] == '*' {
				inBlockComment = true
				i++
			}
		case '(':
			if !quoted() {
				depth++
			}
		case ')':
			if !quoted() {
				depth--
			}
		}

		if quoted() || inLineComment || inBlockComment || depth != 0 {
			continue
		}

		if i+len(target) <= len(query) && strings.EqualFold(query[i:i+len(target)], target) {
			prevOK := i == 0 || !isSQLIdentChar(query[i-1])
			next := i + len(target)
			nextOK := next >= len(query) || !isSQLIdentChar(query[next])
			if prevOK && nextOK {
				return i
			}
		}
	}
	return -1
}

// isSQLIdentChar 判断字符是否可作为 SQL 标识符的一部分。
func isSQLIdentChar(c byte) bool {
	return c == '_' || c == '$' ||
		(c >= 'a' && c <= 'z') ||
		(c >= 'A' && c <= 'Z') ||
		(c >= '0' && c <= '9')
}

// applyPagination 为查询追加 LIMIT / OFFSET。
//
// 绝大多数情况直接在原 SQL 末尾追加即可（MySQL 与 PostgreSQL 写法一致），
// 这样数据库无需物化派生表，SQL 也更容易阅读。
// 只有原 SQL 自带 limit / offset 时才包一层派生表——
// 否则追加的 LIMIT 会改变原有语义（例如模板里已写死 LIMIT 10）。
//
// 末尾若存在行注释（-- ...），换行后追加的 LIMIT 落在新行，不会被注释掉。
//
// 调用前必须先用 canPaginateStatement 判断语句是否支持分页（见 preparePagination）。
func applyPagination(query string, pageSize, offset int) string {
	if offset < 0 {
		offset = 0
	}

	base := trimTrailingSemicolon(query)
	hasOwnLimit := indexOfTopLevelKeyword(base, "limit") >= 0 ||
		indexOfTopLevelKeyword(base, "offset") >= 0

	if hasOwnLimit {
		return fmt.Sprintf(
			"SELECT * FROM (%s) AS __toolbox_page LIMIT %d OFFSET %d",
			base, pageSize, offset,
		)
	}

	if offset == 0 {
		return fmt.Sprintf("%s\nLIMIT %d", base, pageSize)
	}
	return fmt.Sprintf("%s\nLIMIT %d OFFSET %d", base, pageSize, offset)
}

// paginableKeywords 可以安全追加 LIMIT / OFFSET 的语句首关键字。
//
// 判定依据是两点同时成立：语句返回结果集，且语法接受 LIMIT / OFFSET。
//   - SELECT / TABLE / VALUES：均可；
//   - WITH … SELECT：由主语句关键字决定（见 mainStatementKeyword）。
//
// 不在表内的语句一律不分页：
//   - SHOW / DESCRIBE / DESC / EXPLAIN：MySQL 的 SHOW 只接受 LIMIT 不支持 OFFSET
//     （第 2 页必然语法错误），EXPLAIN 也不接受外层 LIMIT，
//     且这类语句无法包成派生表统计总数；
//   - INSERT / UPDATE / DELETE / DDL：不返回结果集，也没有分页概念。
var paginableKeywords = map[string]bool{
	"select": true,
	"table":  true,
	"values": true,
}

// canPaginateStatement 判断语句能否安全地追加分页。
//
// 模板查询与命令执行器共用这一判定，避免两边规则不一致
// （分页写法则由 applyPagination 统一负责）。
func canPaginateStatement(query string) bool {
	return paginableKeywords[mainStatementKeyword(query)]
}

// preparePagination 按分页参数改写语句。
//
// 返回改写后的 SQL 与实际页大小：页大小 0 表示本次不分页
// （用户没要求分页，或该语句不支持分页，两种情况下 SQL 原样返回）。
// 页大小上限统一收敛到 maxPageSize，与界面上限保持一致。
func preparePagination(query string, page, pageSize int) (string, int) {
	if page <= 0 {
		return query, 0
	}
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	if pageSize > maxPageSize {
		pageSize = maxPageSize
	}
	if !canPaginateStatement(query) {
		return query, 0
	}
	return applyPagination(query, pageSize, (page-1)*pageSize), pageSize
}

// mainStatementKeyword 取语句的主关键字（小写）。
//
// WITH 开头的语句要穿过 CTE 定义再看主语句：
// `WITH x AS (…) SELECT …` → select（可分页）；
// `WITH x AS (…) UPDATE/INSERT/DELETE …` → 写操作（不分页）。
// 取不到关键字时返回空串。
func mainStatementKeyword(query string) string {
	text := trimLeadingComments(query)
	head := leadingWord(text)
	if head != "with" {
		return head
	}

	// CTE 主体在括号内（深度 > 0），所以最外层出现的关键字就是主语句
	best := -1
	keyword := ""
	for _, candidate := range []string{"select", "insert", "update", "delete", "merge", "table", "values"} {
		index := indexOfTopLevelKeyword(text, candidate)
		if index >= 0 && (best < 0 || index < best) {
			best = index
			keyword = candidate
		}
	}
	return keyword
}

// trimLeadingComments 去掉 SQL 开头的空白与注释（-- / # / 块注释）。
func trimLeadingComments(query string) string {
	text := strings.TrimSpace(query)
	for {
		switch {
		case strings.HasPrefix(text, "--"), strings.HasPrefix(text, "#"):
			next := strings.IndexByte(text, '\n')
			if next < 0 {
				return ""
			}
			text = strings.TrimSpace(text[next+1:])
		case strings.HasPrefix(text, "/*"):
			end := strings.Index(text, "*/")
			if end < 0 {
				return ""
			}
			text = strings.TrimSpace(text[end+2:])
		default:
			return text
		}
	}
}

// leadingWord 取行首的标识符词（小写），如 "select"、"show"；取不到返回空串。
func leadingWord(text string) string {
	end := 0
	for end < len(text) && isSQLIdentChar(text[end]) {
		end++
	}
	return strings.ToLower(text[:end])
}

// normalizeValue 把驱动返回的原始值转为 JSON 友好的类型。
// 数据库驱动常返回 []byte，直接序列化会变成 Base64，这里统一转字符串。
func normalizeValue(value any) any {
	switch v := value.(type) {
	case nil:
		return nil
	case []byte:
		// 尝试识别为数字，保持前端排序与比较正确
		text := string(v)
		if num, err := strconv.ParseFloat(text, 64); err == nil {
			return num
		}
		return text
	case time.Time:
		return v.Format("2006-01-02 15:04:05")
	default:
		return v
	}
}
