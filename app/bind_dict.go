package app

import (
	"strings"

	"toolbox/app/internal/database"
)

// ---------------------------------------------------------------- 词典

// ListDictionaries 返回全部词典。
func (a *App) ListDictionaries() ([]database.Dictionary, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.dicts.ListDictionaries()
}

// SaveDictionary 新增或更新词典。
func (a *App) SaveDictionary(dict database.Dictionary) (int64, error) {
	if err := a.ready(); err != nil {
		return 0, err
	}
	dict.Name = strings.TrimSpace(dict.Name)
	if dict.Name == "" {
		return 0, errEmptyDictName
	}
	return a.dicts.SaveDictionary(dict)
}

// DeleteDictionary 删除词典。
func (a *App) DeleteDictionary(id int64) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.dicts.DeleteDictionary(id)
}

// ListDictionaryItems 返回指定词典的全部项。
func (a *App) ListDictionaryItems(dictionaryID int64) ([]database.DictionaryItem, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.dicts.ListItems(dictionaryID)
}

// SaveDictionaryItems 全量保存某词典的项目。
func (a *App) SaveDictionaryItems(dictionaryID int64, items []database.DictionaryItem) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.dicts.SaveItems(dictionaryID, items)
}

// LoadDictionaryCache 一次性加载全部词典与词典项，供前端本地翻译使用
func (a *App) LoadDictionaryCache() (map[int64][]database.DictionaryItem, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.dicts.ListAllItems()
}
