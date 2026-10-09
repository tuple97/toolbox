package database

// Tab 对应 tabs 表（Payload 为前端序列化的 JSON 字符串）
type Tab struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	SortOrder     int    `json:"sortOrder"`
	IsActive      bool   `json:"isActive"`
	IsLocked      bool   `json:"isLocked"`
	ToolType      string `json:"toolType"`
	Payload       string `json:"payload"`
	SchemaVersion int    `json:"schemaVersion"`
}

// DBConnection 对应 db_connections 表（Password 为密文）
type DBConnection struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	DBType   string `json:"dbType"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Database string `json:"database"`
	Username string `json:"username"`
	Password string `json:"password"`
	Extra    string `json:"extra"`

	// Note 备注（连接列表悬停展示）
	Note string `json:"note"`
	// Color 颜色标记（列表与标签着色，空表示不标记）
	Color string `json:"color"`

	// Charset MySQL 字符集，空表示 utf8mb4
	Charset string `json:"charset"`
	// DefaultSchema PostgreSQL 默认 schema
	DefaultSchema string `json:"defaultSchema"`
	// ConnectTimeoutSecs 连接超时（秒），0 表示默认 10
	ConnectTimeoutSecs int `json:"connectTimeoutSecs"`
	// QueryTimeoutSecs 语句超时（秒），0 表示默认 60
	QueryTimeoutSecs int `json:"queryTimeoutSecs"`
	// KeepaliveSecs 空闲连接回收（秒），0 表示默认 30
	KeepaliveSecs int `json:"keepaliveSecs"`
	// SSLMode SSL 模式：disable / prefer / require / verify-ca / verify-full
	SSLMode string `json:"sslMode"`
	// SSLCaPath CA 证书路径（verify-ca / verify-full 时必填）
	SSLCaPath string `json:"sslCaPath"`
	// SSLCertPath 客户端证书路径
	SSLCertPath string `json:"sslCertPath"`
	// SSLKeyPath 客户端私钥路径
	SSLKeyPath string `json:"sslKeyPath"`
	// URLParams 追加到连接串的自定义参数，形如 key=value&key2=value2
	URLParams string `json:"urlParams"`
	// ReadOnly 只读连接：拒绝执行写操作
	ReadOnly bool `json:"readOnly"`
	// IsLocal 本地库标记
	IsLocal bool `json:"isLocal"`
	// IsTest 测试库标记
	IsTest bool `json:"isTest"`
	// IsProduction 生产库标记，界面高亮提示
	IsProduction bool `json:"isProduction"`
}

// SQLTemplate 对应 sql_templates 表（Variables / FieldMappings / ExportTemplates 为 JSON 字符串）
type SQLTemplate struct {
	ID      int64  `json:"id"`
	ConnID  int64  `json:"connId"`
	Name    string `json:"name"`
	SQLText string `json:"sqlText"`
	// Database 模板自带的库，空表示用连接配置里的默认库
	Database      string `json:"database"`
	Variables     string `json:"variables"`
	FieldMappings string `json:"fieldMappings"`
	// ExportTemplates 导出模板列表（JSON），content 用结果行列名作变量（{{ 列名 }}）
	ExportTemplates string `json:"exportTemplates"`
	PreScript       string `json:"preScript"`
	PostScript      string `json:"postScript"`
	// Enabled 是否启用（默认启用），停用的模板不允许执行
	Enabled bool `json:"enabled"`
	// PageSize 保留字段，实际页大小由各标签页的翻页控件决定
	PageSize int `json:"pageSize"`
}

// Dictionary 对应 dictionaries 表
type Dictionary struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// DictionaryItem 对应 dictionary_items 表
type DictionaryItem struct {
	ID           int64  `json:"id"`
	DictionaryID int64  `json:"dictionaryId"`
	Value        string `json:"value"`
	Meaning      string `json:"meaning"`
	Description  string `json:"description"`
	SortOrder    int    `json:"sortOrder"`
}

// Setting 对应 app_settings 表（Value 以字符串存储，由前端按 Type 解析）
type Setting struct {
	Key   string `json:"key"`
	Type  string `json:"type"`
	Value string `json:"value"`
}
