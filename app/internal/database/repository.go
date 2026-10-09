package database

// Repository 聚合各表 CRUD，统一持有本地连接
type Repository struct {
	db *DB
}

// NewRepository 创建仓储实例
func NewRepository(db *DB) *Repository {
	return &Repository{db: db}
}

// boolToInt 布尔值转为 SQLite 的 0/1
func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
