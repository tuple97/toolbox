package services

import (
	"toolbox/app/internal/database"
)

// TabService 负责工作台 Tab 的持久化。
type TabService struct {
	repo *database.Repository
}

// NewTabService 创建 Tab 服务。
func NewTabService(repo *database.Repository) *TabService {
	return &TabService{repo: repo}
}

// List 返回全部 Tab，按 sort_order 排序。
func (s *TabService) List() ([]database.Tab, error) {
	return s.repo.ListTabs()
}

// SaveAll 全量保存 Tab 列表，返回带数据库分配 ID 的结果。
//
// 前端采用「防抖 + 退出兜底」策略，每次提交的都是完整快照，
// 因此这里直接覆盖写入，排序即为切片顺序。
func (s *TabService) SaveAll(tabs []database.Tab) ([]database.Tab, error) {
	if tabs == nil {
		tabs = make([]database.Tab, 0)
	}
	return s.repo.SaveTabs(tabs)
}
