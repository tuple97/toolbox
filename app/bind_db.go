package app

import (
	"context"
	"fmt"
	"strings"

	"toolbox/app/internal/database"
	"toolbox/app/internal/services"
)

// ---------------------------------------------------------------- 数据库连接

// ListConnections 返回全部数据库连接配置（密码为密文）
func (a *App) ListConnections() ([]database.DBConnection, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.dbService.ListConnections()
}

// GetConnection 返回单个连接配置。
func (a *App) GetConnection(id int64) (*database.DBConnection, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.dbService.GetConnection(id)
}

// SaveConnection 保存连接配置，密码自动加密。
func (a *App) SaveConnection(conn database.DBConnection) (int64, error) {
	if err := a.ready(); err != nil {
		return 0, err
	}
	if strings.TrimSpace(conn.Name) == "" {
		return 0, fmt.Errorf("连接名称不能为空")
	}
	if strings.TrimSpace(conn.DBType) == "" {
		return 0, fmt.Errorf("请选择数据库类型")
	}
	return a.dbService.SaveConnection(conn)
}

// DeleteConnection 删除连接配置。
func (a *App) DeleteConnection(id int64) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.dbService.DeleteConnection(id)
}

// TestConnection 测试连接是否可用。
func (a *App) TestConnection(conn database.DBConnection) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.dbService.TestConnection(conn)
}

// RevealPassword 解密并返回明文密码
func (a *App) RevealPassword(encrypted string) (string, error) {
	if err := a.ready(); err != nil {
		return "", err
	}
	return a.dbService.DecryptPassword(encrypted)
}

// ---------------------------------------------------------------- 查询执行

// ExecuteQuery 执行查询：前置脚本 → 模板渲染 → SQL 执行 → 后置脚本。
func (a *App) ExecuteQuery(
	ctx context.Context,
	req services.ExecuteRequest,
) (*services.QueryResult, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	if req.ConnID <= 0 {
		return nil, fmt.Errorf("请先选择数据库连接")
	}
	return a.dbService.Execute(ctx, req)
}

// QueryVariableOptions 执行 SQL 取变量的动态选项。
//
// database 非空时按所选库 / 模式执行（语义与查询、命令执行器一致，见
// DBService.QueryOptionsForVariable），空表示用连接配置里的默认库。
func (a *App) QueryVariableOptions(
	ctx context.Context,
	connID int64,
	database string,
	query string,
) ([]map[string]any, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(query) == "" {
		return make([]map[string]any, 0), nil
	}
	return a.dbService.QueryOptionsForVariable(ctx, connID, database, query)
}
