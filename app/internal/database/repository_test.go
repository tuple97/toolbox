package database

import (
	"testing"
)

// newTestRepo 创建指向临时目录的仓储，用于测试。
//
// 使用 OpenAt 而非 Open：后者是应用级单例，
// 多个测试共用同一个连接会因先关闭的连接而相互干扰。
func newTestRepo(t *testing.T) *Repository {
	t.Helper()
	db, err := OpenAt(t.TempDir())
	if err != nil {
		t.Fatalf("初始化数据库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return NewRepository(db)
}

// TestSaveTabs_PreservesExistingID 确保已有记录的 ID 在保存后保持不变。
//
// 这是防止「保存后所有标签 ID 变化」的重要回归测试：
// 若 ID 每次都变，前端会持续替换本地数组并重建组件，导致界面周期性闪烁。
func TestSaveTabs_PreservesExistingID(t *testing.T) {
	repo := newTestRepo(t)

	// 首次保存：负数占位 ID 由数据库分配真实 ID
	first, err := repo.SaveTabs([]Tab{
		{ID: -1, Name: "标签A", ToolType: "db-query", Payload: "{}"},
		{ID: -2, Name: "标签B", ToolType: "placeholder", Payload: "{}"},
	})
	if err != nil {
		t.Fatalf("首次保存失败: %v", err)
	}

	for i, tab := range first {
		if tab.ID <= 0 {
			t.Fatalf("第 %d 个标签应被分配正数 ID，实际 %d", i, tab.ID)
		}
	}

	// 再次保存：ID 必须保持不变
	second, err := repo.SaveTabs([]Tab{
		{ID: first[0].ID, Name: "标签A改", ToolType: "db-query", Payload: "{}"},
		{ID: first[1].ID, Name: "标签B", ToolType: "placeholder", Payload: "{}"},
	})
	if err != nil {
		t.Fatalf("二次保存失败: %v", err)
	}

	for i := range first {
		if second[i].ID != first[i].ID {
			t.Errorf("第 %d 个标签 ID 不应变化：保存前 %d，保存后 %d",
				i, first[i].ID, second[i].ID)
		}
	}

	// 名称更新应生效
	if second[0].Name != "标签A改" {
		t.Errorf("名称应被更新，实际 %s", second[0].Name)
	}

	// 从库中读回，ID 应与返回值一致
	listed, err := repo.ListTabs()
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if len(listed) != 2 {
		t.Fatalf("应有 2 条记录，实际 %d", len(listed))
	}
	for i := range listed {
		if listed[i].ID != first[i].ID {
			t.Errorf("库中第 %d 条 ID 不符：库中 %d，期望 %d",
				i, listed[i].ID, first[i].ID)
		}
	}
}

// TestSaveTabs_SortOrderFollowsSliceOrder 确保顺序即为切片顺序。
func TestSaveTabs_SortOrderFollowsSliceOrder(t *testing.T) {
	repo := newTestRepo(t)

	saved, err := repo.SaveTabs([]Tab{
		{ID: -1, Name: "A", ToolType: "t", Payload: "{}"},
		{ID: -2, Name: "B", ToolType: "t", Payload: "{}"},
		{ID: -3, Name: "C", ToolType: "t", Payload: "{}"},
	})
	if err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	// 调换顺序后保存
	reordered, err := repo.SaveTabs([]Tab{saved[2], saved[0], saved[1]})
	if err != nil {
		t.Fatalf("重排保存失败: %v", err)
	}

	wantOrder := []string{"C", "A", "B"}
	for i, tab := range reordered {
		if tab.Name != wantOrder[i] {
			t.Errorf("第 %d 位应为 %s，实际 %s", i, wantOrder[i], tab.Name)
		}
		if tab.SortOrder != i {
			t.Errorf("第 %d 位 sortOrder 应为 %d，实际 %d", i, i, tab.SortOrder)
		}
	}

	listed, err := repo.ListTabs()
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	for i, tab := range listed {
		if tab.Name != wantOrder[i] {
			t.Errorf("库中第 %d 位应为 %s，实际 %s", i, wantOrder[i], tab.Name)
		}
	}
}

// TestSaveTabs_Deletion 确保被移除的标签不再存在。
func TestSaveTabs_Deletion(t *testing.T) {
	repo := newTestRepo(t)

	saved, err := repo.SaveTabs([]Tab{
		{ID: -1, Name: "保留", ToolType: "t", Payload: "{}"},
		{ID: -2, Name: "删除", ToolType: "t", Payload: "{}"},
	})
	if err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	if _, err := repo.SaveTabs([]Tab{saved[0]}); err != nil {
		t.Fatalf("删除后保存失败: %v", err)
	}

	listed, err := repo.ListTabs()
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if len(listed) != 1 {
		t.Fatalf("应剩 1 条记录，实际 %d", len(listed))
	}
	if listed[0].Name != "保留" {
		t.Errorf("应保留「保留」，实际 %s", listed[0].Name)
	}
}

// TestSaveTabs_Empty 空列表应清空所有记录。
func TestSaveTabs_Empty(t *testing.T) {
	repo := newTestRepo(t)

	if _, err := repo.SaveTabs([]Tab{{ID: -1, Name: "A", ToolType: "t", Payload: "{}"}}); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	if _, err := repo.SaveTabs(nil); err != nil {
		t.Fatalf("清空失败: %v", err)
	}

	listed, err := repo.ListTabs()
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if len(listed) != 0 {
		t.Errorf("应为空，实际 %d 条", len(listed))
	}
}

// TestSettings_SeedAndUpsert 配置表默认值与更新。
func TestSettings_SeedAndUpsert(t *testing.T) {
	repo := newTestRepo(t)

	// 初始为空
	count, err := repo.CountSettings()
	if err != nil {
		t.Fatalf("统计失败: %v", err)
	}
	if count != 0 {
		t.Fatalf("初始应为 0，实际 %d", count)
	}

	// 写入并更新
	if err := repo.UpsertSetting(Setting{Key: "theme", Type: "string", Value: "dark"}); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := repo.UpsertSetting(Setting{Key: "theme", Type: "string", Value: "light"}); err != nil {
		t.Fatalf("更新失败: %v", err)
	}

	got, err := repo.GetSetting("theme")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if got.Value != "light" {
		t.Errorf("值应为 light，实际 %s", got.Value)
	}

	// 重复写入不应产生多条记录
	count, err = repo.CountSettings()
	if err != nil {
		t.Fatalf("统计失败: %v", err)
	}
	if count != 1 {
		t.Errorf("Upsert 后应只有 1 条，实际 %d", count)
	}
}

// TestGetTemplate 模板按 ID 读取与不存在时的报错。
func TestGetTemplate(t *testing.T) {
	repo := newTestRepo(t)

	connID, err := repo.SaveConnection(DBConnection{
		Name: "本地", DBType: "mysql", Host: "127.0.0.1", Port: 3306, Database: "test",
	})
	if err != nil {
		t.Fatalf("创建连接失败: %v", err)
	}

	id, err := repo.SaveTemplate(SQLTemplate{
		ConnID: connID, Name: "查设备", SQLText: "select * from device where no = {{ no }}",
		Variables: "[]", FieldMappings: "[]",
		PreScript: "return {}", PostScript: "",
	})
	if err != nil {
		t.Fatalf("保存模板失败: %v", err)
	}

	got, err := repo.GetTemplate(id)
	if err != nil {
		t.Fatalf("读取模板失败: %v", err)
	}
	if got.Name != "查设备" || got.ConnID != connID {
		t.Errorf("模板内容不符: %+v", got)
	}

	// 不存在的 ID 应明确报错
	if _, err := repo.GetTemplate(99999); err == nil {
		t.Error("不存在的模板应报错")
	}
}
