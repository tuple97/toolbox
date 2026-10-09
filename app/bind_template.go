package app

import (
	"context"
	"fmt"
	"strings"

	"toolbox/app/internal/database"
	"toolbox/app/internal/services"
	"toolbox/app/internal/utils"
)

// ---------------------------------------------------------------- SQL 模板

// ListSqlTemplates 返回模板列表（含截断的 SQL 预览）
func (a *App) ListSqlTemplates() ([]services.TemplateListItem, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.templates.ListWithPreview(100)
}

// ListTemplates 返回全部模板（含完整字段，兼容旧接口）
func (a *App) ListTemplates() ([]database.SQLTemplate, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.templates.List()
}

// GetSqlTemplate 按 ID 返回完整模板。
func (a *App) GetSqlTemplate(id int64) (*database.SQLTemplate, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	if id <= 0 {
		return nil, fmt.Errorf("模板 ID 非法")
	}
	return a.templates.Get(id)
}

// SaveSqlTemplate 新增或更新模板（id 为 0 时插入）
func (a *App) SaveSqlTemplate(tpl database.SQLTemplate) (int64, error) {
	if err := a.ready(); err != nil {
		return 0, err
	}
	if strings.TrimSpace(tpl.Name) == "" {
		return 0, fmt.Errorf("模板名称不能为空")
	}
	if tpl.ConnID <= 0 {
		return 0, fmt.Errorf("请先选择数据库连接")
	}
	return a.templates.Save(tpl)
}

// SaveTemplate 兼容旧接口
func (a *App) SaveTemplate(tpl database.SQLTemplate) (int64, error) {
	return a.SaveSqlTemplate(tpl)
}

// DeleteSqlTemplate 删除模板。
func (a *App) DeleteSqlTemplate(id int64) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.templates.Delete(id)
}

// DeleteTemplate 兼容旧接口。
func (a *App) DeleteTemplate(id int64) error {
	return a.DeleteSqlTemplate(id)
}

// ExtractTemplateVariables 解析 SQL 模板中的变量名。
func (a *App) ExtractTemplateVariables(sqlText string) ([]string, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.templates.ExtractVariables(sqlText)
}

// ValidateTemplate 校验模板语法，返回错误位置供编辑器标注
func (a *App) ValidateTemplate(sqlText string) utils.TemplateCheck {
	return utils.CheckTemplate(sqlText)
}

// PreviewTemplate 渲染模板，返回最终 SQL。
func (a *App) PreviewTemplate(sqlText string, variables map[string]any) (string, error) {
	if err := a.ready(); err != nil {
		return "", err
	}
	return a.templates.Preview(sqlText, variables)
}

// RenderExportTemplate 按导出模板渲染选中的结果行，返回逐行文本
func (a *App) RenderExportTemplate(tplText string, rows []map[string]any) ([]string, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []string{}, nil
	}
	return a.templates.RenderExport(tplText, rows)
}

// ValidateScript 校验前置/后置脚本语法。
func (a *App) ValidateScript(source string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := a.templates.ValidateScript(source); err != nil {
		return fmt.Errorf("脚本语法错误: %w", err)
	}
	return nil
}

// ExecuteTemplateQuery 按模板执行查询
func (a *App) ExecuteTemplateQuery(
	ctx context.Context,
	req services.TemplateExecuteRequest,
) (*services.QueryResult, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	if req.TemplateID <= 0 {
		return nil, fmt.Errorf("请先选择 SQL 模板")
	}

	return a.dbService.ExecuteTemplateQuery(ctx, req)
}
