package services

import (
	"toolbox/app/internal/database"
)

// DictService 负责词典与词典项的持久化。
type DictService struct {
	repo *database.Repository
}

// NewDictService 创建词典服务。
func NewDictService(repo *database.Repository) *DictService {
	return &DictService{repo: repo}
}

// ListDictionaries 返回全部词典。
func (s *DictService) ListDictionaries() ([]database.Dictionary, error) {
	return s.repo.ListDictionaries()
}

// SaveDictionary 新增或更新词典。
func (s *DictService) SaveDictionary(dict database.Dictionary) (int64, error) {
	return s.repo.SaveDictionary(dict)
}

// DeleteDictionary 删除词典，其下项目级联删除。
func (s *DictService) DeleteDictionary(id int64) error {
	return s.repo.DeleteDictionary(id)
}

// ListItems 返回指定词典的全部项。
func (s *DictService) ListItems(dictionaryID int64) ([]database.DictionaryItem, error) {
	return s.repo.ListDictionaryItems(dictionaryID)
}

// SaveItems 全量保存某词典的项目。
func (s *DictService) SaveItems(dictionaryID int64, items []database.DictionaryItem) error {
	if items == nil {
		items = make([]database.DictionaryItem, 0)
	}
	return s.repo.SaveDictionaryItems(dictionaryID, items)
}

// ListAllItems 返回全部词典项，按词典分组。
// 前端缓存词典后可在渲染层直接完成翻译，减少往返调用。
func (s *DictService) ListAllItems() (map[int64][]database.DictionaryItem, error) {
	dicts, err := s.repo.ListDictionaries()
	if err != nil {
		return nil, err
	}

	result := make(map[int64][]database.DictionaryItem, len(dicts))
	for _, dict := range dicts {
		items, err := s.repo.ListDictionaryItems(dict.ID)
		if err != nil {
			return nil, err
		}
		result[dict.ID] = items
	}
	return result, nil
}
