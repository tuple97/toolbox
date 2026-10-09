package services

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	"toolbox/app/internal/database"
)

/*
 * 数据库连接的建立与管理：增删改查、连通性测试、DSN 构造。
 *
 * 从 db_service.go 拆出来的原因：那边是「连上以后怎么查」的执行链路
 * （模板渲染、分页、结果加工），这边只回答「怎么连上」——
 * 两者合在一起时文件太长，改连接参数要在千行里翻找。
 */

// 连接参数的默认值（与 database.DBConnection 的注释保持一致）
const (
	defaultConnectTimeoutSecs = 10
	defaultQueryTimeoutSecs   = 60
	defaultKeepaliveSecs      = 30
)

// TestConnection 测试连接可用性。
func (s *DBService) TestConnection(conn database.DBConnection) error {
	// 若传入的是已保存连接（仅带 ID），先取出完整配置
	if conn.Host == "" && conn.ID > 0 {
		saved, err := s.repo.GetConnection(conn.ID)
		if err != nil {
			return err
		}
		conn = *saved
	}
	// 空配置（既没有地址也没有 ID）不必尝试连接，直接给出明确错误
	if strings.TrimSpace(conn.Host) == "" {
		return fmt.Errorf("连接地址为空，请先填写主机")
	}

	db, err := s.openConnection(conn)
	if err != nil {
		return err
	}
	defer db.Close()

	// 超时按连接配置走（ConnectTimeoutSecs，默认 10 秒）
	ctx, cancel := context.WithTimeout(
		context.Background(),
		time.Duration(secondsOrDefault(conn.ConnectTimeoutSecs, defaultConnectTimeoutSecs))*time.Second,
	)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("连接失败: %w", err)
	}
	return nil
}

// SaveConnection 加密密码后保存连接配置。
func (s *DBService) SaveConnection(conn database.DBConnection) (int64, error) {
	/*
	 * 不能只看 `enc:` 前缀判断「是否已加密」：
	 * 用户密码恰好以 enc:v1: 开头时会被当成密文跳过加密，明文直接落库，
	 * 读取时又会按密文去解码。EncryptIfNeeded 以「能解的开」为准。
	 */
	encrypted, err := s.cipher.EncryptIfNeeded(conn.Password)
	if err != nil {
		return 0, fmt.Errorf("密码加密失败: %w", err)
	}
	conn.Password = encrypted
	return s.repo.SaveConnection(conn)
}

// GetConnection 返回连接配置，密码保持密文，由前端决定是否解密展示。
func (s *DBService) GetConnection(id int64) (*database.DBConnection, error) {
	return s.repo.GetConnection(id)
}

// ListConnections 返回全部连接配置。
func (s *DBService) ListConnections() ([]database.DBConnection, error) {
	return s.repo.ListConnections()
}

// DeleteConnection 删除连接。
func (s *DBService) DeleteConnection(id int64) error {
	return s.repo.DeleteConnection(id)
}

// DecryptPassword 按需解密密码，仅用于「显示密码」等明确交互。
func (s *DBService) DecryptPassword(encrypted string) (string, error) {
	return s.cipher.Decrypt(encrypted)
}

// ---------------------------------------------------------------- DSN

// openConnection 按数据库类型构造 DSN 并建立连接。
func (s *DBService) openConnection(conn database.DBConnection) (*sql.DB, error) {
	password, err := s.cipher.Decrypt(conn.Password)
	if err != nil {
		return nil, fmt.Errorf("解密数据库密码失败: %w", err)
	}

	driver, dsn, err := buildDSN(conn, password)
	if err != nil {
		return nil, err
	}

	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}

	// 连接池参数：避免长期占用过多外部连接
	db.SetMaxOpenConns(5)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(10 * time.Minute)
	// 空闲连接回收时间可由连接配置调整（KeepaliveSecs，默认 30 秒）
	db.SetConnMaxIdleTime(time.Duration(secondsOrDefault(conn.KeepaliveSecs, defaultKeepaliveSecs)) * time.Second)

	return db, nil
}

// buildDSN 根据数据库类型生成驱动名与连接串。
//
// 连接参数（见 database.DBConnection）落到各方言：
//   - 通用：连接/查询超时、URLParams 追加的自定义参数（同名时用户填的优先）；
//   - MySQL：charset（默认 utf8mb4）、tls（由 SSLMode 映射）；
//   - PostgreSQL：sslmode + 证书路径、connect_timeout、client_encoding。
func buildDSN(conn database.DBConnection, password string) (string, string, error) {
	port := conn.Port

	switch strings.ToLower(conn.DBType) {
	case "mysql":
		if port == 0 {
			port = 3306
		}
		charset := conn.Charset
		if charset == "" {
			charset = "utf8mb4"
		}
		params := url.Values{}
		// parseTime 让时间类型正确映射；loc=Local 保证时区与本地一致
		params.Set("charset", charset)
		params.Set("parseTime", "true")
		params.Set("loc", "Local")
		params.Set("timeout", fmt.Sprintf("%ds", secondsOrDefault(conn.ConnectTimeoutSecs, defaultConnectTimeoutSecs)))
		params.Set("readTimeout", fmt.Sprintf("%ds", secondsOrDefault(conn.QueryTimeoutSecs, defaultQueryTimeoutSecs)))
		params.Set("writeTimeout", fmt.Sprintf("%ds", secondsOrDefault(conn.QueryTimeoutSecs, defaultQueryTimeoutSecs)))
		if tlsMode := mysqlTLSMode(conn.SSLMode); tlsMode != "" {
			params.Set("tls", tlsMode)
		}
		applyExtraParams(params, conn.URLParams)
		/*
		 * 用驱动自己的 Config 拼 DSN，而不是字符串格式化：
		 * 密码里出现 @ : / ? 这类字符（很常见）时，拼接的 DSN 会被解析成
		 * 错误的 host 或直接解析失败，FormatDSN 会做正确的转义。
		 */
		cfg := mysql.NewConfig()
		cfg.User = conn.Username
		cfg.Passwd = password
		cfg.Net = "tcp"
		cfg.Addr = net.JoinHostPort(conn.Host, strconv.Itoa(port))
		cfg.DBName = conn.Database
		cfg.Params = make(map[string]string, len(params))
		for key, values := range params {
			if len(values) == 0 {
				continue
			}
			cfg.Params[key] = values[0]
		}
		return "mysql", cfg.FormatDSN(), nil

	case "postgres", "postgresql":
		if port == 0 {
			port = 5432
		}
		params := url.Values{}
		params.Set("connect_timeout", fmt.Sprintf("%d", secondsOrDefault(conn.ConnectTimeoutSecs, defaultConnectTimeoutSecs)))
		params.Set("sslmode", pgSSLMode(conn.SSLMode))
		params.Set("application_name", "toolbox")
		if conn.Charset != "" {
			params.Set("client_encoding", conn.Charset)
		}
		if conn.SSLCaPath != "" {
			params.Set("sslrootcert", conn.SSLCaPath)
		}
		if conn.SSLCertPath != "" {
			params.Set("sslcert", conn.SSLCertPath)
		}
		if conn.SSLKeyPath != "" {
			params.Set("sslkey", conn.SSLKeyPath)
		}
		applyExtraParams(params, conn.URLParams)
		// 使用 URL 形式并对账号密码做转义，避免特殊字符破坏连接串
		dsn := fmt.Sprintf(
			"postgres://%s:%s@%s:%d/%s?%s",
			url.QueryEscape(conn.Username),
			url.QueryEscape(password),
			conn.Host, port, conn.Database, params.Encode(),
		)
		return "postgres", dsn, nil

	default:
		return "", "", fmt.Errorf("暂不支持的数据库类型: %s", conn.DBType)
	}
}

// secondsOrDefault 取配置的秒数，未配置（<=0）时用默认值
func secondsOrDefault(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

// mysqlTLSMode 把统一的 SSLMode 映射到 go-sql-driver/mysql 的 tls 取值。
// 返回空串表示不带该参数（不加密）。
func mysqlTLSMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "prefer", "preferred":
		return "preferred"
	case "require", "skip-verify":
		return "skip-verify"
	case "verify", "verify-ca", "verify-full":
		return "true"
	default:
		return ""
	}
}

// pgSSLMode 把统一的 SSLMode 映射到 PostgreSQL 的 sslmode，未知值按 disable 处理。
func pgSSLMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "allow", "prefer", "require", "verify-ca", "verify-full":
		return strings.ToLower(strings.TrimSpace(mode))
	case "verify":
		return "verify-full"
	default:
		return "disable"
	}
}

// applyExtraParams 合并用户填写的附加连接参数（形如 `key=value&key2=value2`）。
// 同名参数以用户填的为准；解析失败时忽略，避免整条 DSN 因一个笔误而不可用。
func applyExtraParams(params url.Values, raw string) {
	raw = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "?"))
	if raw == "" {
		return
	}
	parsed, err := url.ParseQuery(raw)
	if err != nil {
		return
	}
	for key, values := range parsed {
		params.Del(key)
		for _, value := range values {
			params.Add(key, value)
		}
	}
}
