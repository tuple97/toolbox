package plugin

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// testAppVersion 测试用宿主版本。
const testAppVersion = "0.2.0"

// memStorage 内存版插件配置存储。
type memStorage struct {
	mu   sync.Mutex
	data map[string]map[string]string
}

func newMemStorage() *memStorage {
	return &memStorage{data: map[string]map[string]string{}}
}

func (s *memStorage) Get(pluginID, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.data[pluginID][key]
	return value, ok, nil
}

func (s *memStorage) Set(pluginID, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data[pluginID] == nil {
		s.data[pluginID] = map[string]string{}
	}
	s.data[pluginID][key] = value
	return nil
}

func (s *memStorage) Delete(pluginID, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data[pluginID], key)
	return nil
}

func (s *memStorage) List(pluginID string) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]string{}
	for k, v := range s.data[pluginID] {
		out[k] = v
	}
	return out, nil
}

// newTestManager 创建使用临时目录的管理器。
func newTestManager(t *testing.T) *Manager {
	t.Helper()
	return newTestManagerWith(t, RegistryProvider{IndexURL: "http://127.0.0.1:1/registry.json"})
}

// newTestManagerWith 创建指定索引来源的管理器。
func newTestManagerWith(t *testing.T, provider RegistryProvider) *Manager {
	t.Helper()
	mgr := NewManager(Options{
		DataDir:    t.TempDir(),
		AppVersion: testAppVersion,
		Registry:   provider,
		Storage:    newMemStorage(),
	})
	if err := mgr.Startup(context.Background()); err != nil {
		t.Fatalf("初始化插件管理器失败: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })
	return mgr
}

// baseManifest 生成一份合法的清单骨架。
func baseManifest(id, version string) *Manifest {
	return &Manifest{
		ManifestVersion: ManifestVersion,
		ID:              id,
		Name:            id,
		Version:         version,
		Publisher:       "toolbox",
		Description:     "测试插件",
		Engines: Engines{
			Toolbox:   ">=0.1.0",
			PluginAPI: "^1.0.0",
		},
		Runtime: RuntimeSpec{Backend: string(BackendNone)},
	}
}

// withBackend 给清单加上 JS 后端。
func withBackend(mf *Manifest) *Manifest {
	mf.Runtime = RuntimeSpec{Backend: string(BackendJS), Entry: "backend/index.js"}
	return mf
}

// withFrontend 给清单加上前端入口与一个工具。
func withFrontend(mf *Manifest) *Manifest {
	mf.Runtime.Frontend = "frontend/index.js"
	mf.Contributes.Tools = []ToolContribution{{Type: mf.ID, Label: mf.Name}}
	return mf
}

// withDependency 给清单加一条依赖。
func withDependency(mf *Manifest, id, constraint string) *Manifest {
	if mf.Dependencies == nil {
		mf.Dependencies = map[string]string{}
	}
	mf.Dependencies[id] = constraint
	return mf
}

// withPermissions 覆盖权限声明。
func withPermissions(mf *Manifest, perms Permissions) *Manifest {
	mf.Permissions = perms
	return mf
}

// testBackendScript 一个最小的合法后端入口脚本（对应 toolbox.handler API）。
const testBackendScript = `toolbox.handler("ping", function (args) { return { ok: true, echo: args }; });`

// testFrontendScript 一个最小的合法前端入口脚本（ESM，由宿主 WebView 加载）。
const testFrontendScript = "export async function activate() { return { async deactivate() {} } }"

// manifestFiles 返回清单对应安装包需要的文件集合。
func manifestFiles(mf *Manifest) map[string]string {
	files := map[string]string{}
	if mf.BackendKind() == BackendJS {
		files[mf.BackendEntry()] = testBackendScript
	}
	if mf.FrontendEntry() != "" {
		files[mf.FrontendEntry()] = testFrontendScript
	}
	return files
}

// zipPackage 把清单与文件打成安装包。
func zipPackage(t *testing.T, mf *Manifest, extra map[string]string) []byte {
	t.Helper()

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	write := func(name, content string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("写入 zip 条目失败: %v", err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("写入 zip 内容失败: %v", err)
		}
	}

	files := manifestFiles(mf)
	for name, content := range extra {
		files[name] = content
	}

	raw, err := json.MarshalIndent(mf, "", "  ")
	if err != nil {
		t.Fatalf("序列化清单失败: %v", err)
	}
	write(ManifestFileName, string(raw))
	for name, content := range files {
		write(name, content)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip 失败: %v", err)
	}
	return buf.Bytes()
}

// writePackageFile 把安装包写到临时文件并返回路径。
func writePackageFile(t *testing.T, mf *Manifest, extra map[string]string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), mf.ID+"-"+mf.Version+".zip")
	if err := os.WriteFile(path, zipPackage(t, mf, extra), 0o644); err != nil {
		t.Fatalf("写入安装包失败: %v", err)
	}
	return path
}

// writePluginDir 把插件写成一个本地目录（开发者模式）。
func writePluginDir(t *testing.T, mf *Manifest, extra map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	raw, err := json.MarshalIndent(mf, "", "  ")
	if err != nil {
		t.Fatalf("序列化清单失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ManifestFileName), raw, 0o644); err != nil {
		t.Fatalf("写入清单失败: %v", err)
	}
	for name, content := range manifestFiles(mf) {
		target := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatalf("创建目录失败: %v", err)
		}
		if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
			t.Fatalf("写入文件失败: %v", err)
		}
	}
	for name, content := range extra {
		target := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatalf("创建目录失败: %v", err)
		}
		if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
			t.Fatalf("写入文件失败: %v", err)
		}
	}
	return dir
}

// installFromDir 安装一个本地目录插件（开发模式），便于生命周期测试。
func installFromDir(t *testing.T, mgr *Manager, mf *Manifest) {
	t.Helper()
	dir := writePluginDir(t, mf, nil)
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceLocalDir, Ref: dir}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览本地插件 %s 失败: %v", mf.ID, err)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装本地插件 %s 失败: %v", mf.ID, err)
	}
}

// findInfo 在已安装列表中查找插件。
func findInfo(t *testing.T, mgr *Manager, id string) InstalledInfo {
	t.Helper()
	for _, info := range mgr.ListInstalled() {
		if info.ID == id {
			return info
		}
	}
	t.Fatalf("未找到插件 %s", id)
	return InstalledInfo{}
}

// ---------------------------------------------------------------- 测试用索引服务

// testRegistry 一个本地 HTTP 索引 + 安装包服务，用于验证在线安装链路。
type testRegistry struct {
	server     *httptest.Server
	entries    []RegistryEntry
	packages   map[string][]byte
	indexRaw   []byte
	signature  string
	signingKey ed25519.PrivateKey
}

// newTestRegistry 启动本地索引服务。
func newTestRegistry(t *testing.T) *testRegistry {
	t.Helper()
	reg := &testRegistry{packages: map[string][]byte{}}

	mux := http.NewServeMux()
	mux.HandleFunc("/registry.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(reg.indexRaw)
	})
	mux.HandleFunc("/registry.json.sig", func(w http.ResponseWriter, _ *http.Request) {
		if reg.signature == "" {
			http.NotFound(w, nil)
			return
		}
		_, _ = w.Write([]byte(reg.signature))
	})
	mux.HandleFunc("/pkg/", func(w http.ResponseWriter, r *http.Request) {
		name := filepath.Base(r.URL.Path)
		payload, ok := reg.packages[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(payload)
	})
	reg.server = httptest.NewServer(mux)
	t.Cleanup(reg.server.Close)
	reg.rebuild()
	return reg
}

// provider 返回索引来源配置。
func (r *testRegistry) provider() RegistryProvider {
	return RegistryProvider{IndexURL: r.server.URL + "/registry.json"}
}

// publish 把一个插件发布到测试索引。
func (r *testRegistry) publish(t *testing.T, mf *Manifest, extra map[string]string, official bool) {
	t.Helper()
	payload := zipPackage(t, mf, extra)
	name := mf.ID + "-" + mf.Version + ".zip"
	r.packages[name] = payload

	r.entries = append(r.entries, RegistryEntry{
		ID:           mf.ID,
		Name:         mf.Name,
		Version:      mf.Version,
		Publisher:    mf.Publisher,
		Description:  mf.Description,
		Official:     official,
		SourceDir:    mf.ID,
		Download:     r.server.URL + "/pkg/" + name,
		Checksum:     HashBytes(payload),
		Engines:      mf.Engines,
		Dependencies: mf.Dependencies,
		Permissions:  mf.Permissions,
		Runtime:      mf.Runtime,
		Contributes:  mf.Contributes,
	})
	r.rebuild()
}

// enableSigning 开启索引签名，并把公钥配置为宿主内置公钥。
func (r *testRegistry) enableSigning(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("生成密钥失败: %v", err)
	}
	pub := priv.Public().(ed25519.PublicKey)
	previous := RegistryPublicKey
	RegistryPublicKey = base64.StdEncoding.EncodeToString(pub)
	t.Cleanup(func() { RegistryPublicKey = previous })

	r.signature = ""
	r.signingKey = priv
	r.rebuild()
	return priv
}

// rebuild 重新渲染索引内容（必要时重新签名）。
func (r *testRegistry) rebuild() {
	index := RegistryIndex{
		SchemaVersion: RegistrySchemaVersion,
		UpdatedAt:     "2026-01-01T00:00:00Z",
		Plugins:       r.entries,
	}
	raw, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		panic(err)
	}
	r.indexRaw = raw
	if r.signingKey != nil {
		r.signature = base64.StdEncoding.EncodeToString(ed25519.Sign(r.signingKey, raw))
	}
}
