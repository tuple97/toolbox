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

// testAppVersion 娴嬭瘯鐢ㄥ涓荤増鏈€?
const testAppVersion = "0.2.0"

// memStorage 鍐呭瓨鐗堟彃浠堕厤缃瓨鍌ㄣ€?
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

// unreachableRegistryURL 鎸囧悜涓€涓繀鐒惰繛涓嶄笂鐨勫湴鍧€锛岀敤浣滄祴璇曢噷鐨勩€屽唴缃畼鏂规簮銆嶃€?
const unreachableRegistryURL = "http://127.0.0.1:1/registry.json"

// newTestManager 鍒涘缓浣跨敤涓存椂鐩綍鐨勭鐞嗗櫒锛堝畼鏂规簮涓嶅彲杈撅級銆?
func newTestManager(t *testing.T) *Manager {
	t.Helper()
	return newTestManagerWith(t, RegistryProvider{IndexURL: unreachableRegistryURL})
}

// newTestManagerWith 鍒涘缓鎸囧畾绱㈠紩鏉ユ簮鐨勭鐞嗗櫒锛堣鏉ユ簮鍗冲唴缃畼鏂规簮锛夈€?
func newTestManagerWith(t *testing.T, provider RegistryProvider) *Manager {
	t.Helper()
	mgr := NewManager(Options{
		DataDir:    t.TempDir(),
		AppVersion: testAppVersion,
		Registry:   provider,
		Storage:    newMemStorage(),
	})
	if err := mgr.Startup(context.Background()); err != nil {
		t.Fatalf("鍒濆鍖栨彃浠剁鐞嗗櫒澶辫触: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })
	return mgr
}

// newTestManagerWithSources 鍒涘缓甯︽寚瀹氭彃浠舵簮鍒楄〃鐨勭鐞嗗櫒銆?
//
// 鍐呯疆瀹樻柟婧愬浐瀹氭寚鍚戜笉鍙揪鍦板潃锛屽洜姝ゅ垪琛ㄩ噷鐨勫叾瀹冩潵婧愰兘浼氳褰撲綔绗笁鏂规潵婧愩€?
func newTestManagerWithSources(t *testing.T, sources ...RegistrySource) *Manager {
	t.Helper()
	mgr := NewManager(Options{
		DataDir:    t.TempDir(),
		AppVersion: testAppVersion,
		Registry:   RegistryProvider{IndexURL: unreachableRegistryURL},
		Sources:    sources,
		Storage:    newMemStorage(),
	})
	if err := mgr.Startup(context.Background()); err != nil {
		t.Fatalf("鍒濆鍖栨彃浠剁鐞嗗櫒澶辫触: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })
	return mgr
}

// thirdPartySources 缁勪竴涓€岀鐢ㄥ畼鏂规簮 + 鍚敤璇ユ祴璇曟簮銆嶇殑鏉ユ簮鍒楄〃銆?
func thirdPartySources(reg *testRegistry) []RegistrySource {
	return []RegistrySource{
		{URL: unreachableRegistryURL, Name: OfficialSourceName, Enabled: false},
		{URL: reg.provider().IndexURL, Name: "绗笁鏂规簮", Enabled: true},
	}
}

// sourceVerifiedOf 杩斿洖鏌愭潵婧愬湪蹇収閲岀殑楠岀鐘舵€併€?
func sourceVerifiedOf(snapshot MarketplaceSnapshot, url string) bool {
	for _, src := range snapshot.Sources {
		if src.URL == url {
			return src.Verified
		}
	}
	return false
}

// baseManifest 鐢熸垚涓€浠藉悎娉曠殑娓呭崟楠ㄦ灦銆?
func baseManifest(id, version string) *Manifest {
	return &Manifest{
		ManifestVersion: ManifestVersion,
		ID:              id,
		Name:            id,
		Version:         version,
		Publisher:       "toolbox",
		Description:     "娴嬭瘯鎻掍欢",
		Engines: Engines{
			Toolbox:   ">=0.1.0",
			PluginAPI: "^1.0.0",
		},
		Runtime: RuntimeSpec{Backend: string(BackendNone)},
	}
}

// withBackend 缁欐竻鍗曞姞涓?JS 鍚庣銆?
func withBackend(mf *Manifest) *Manifest {
	mf.Runtime = RuntimeSpec{Backend: string(BackendJS), Entry: "backend/index.js"}
	return mf
}

// withFrontend 缁欐竻鍗曞姞涓婂墠绔叆鍙ｄ笌涓€涓伐鍏枫€?
func withFrontend(mf *Manifest) *Manifest {
	mf.Runtime.Frontend = "frontend/index.js"
	mf.Contributes.Tools = []ToolContribution{{Type: mf.ID, Label: mf.Name}}
	return mf
}

// withDependency 缁欐竻鍗曞姞涓€鏉′緷璧栥€?
func withDependency(mf *Manifest, id, constraint string) *Manifest {
	if mf.Dependencies == nil {
		mf.Dependencies = map[string]string{}
	}
	mf.Dependencies[id] = constraint
	return mf
}

// withPermissions 瑕嗙洊鏉冮檺澹版槑銆?
func withPermissions(mf *Manifest, perms Permissions) *Manifest {
	mf.Permissions = perms
	return mf
}

// testBackendScript 涓€涓渶灏忕殑鍚堟硶鍚庣鍏ュ彛鑴氭湰锛堝搴?toolbox.handler API锛夈€?
const testBackendScript = `toolbox.handler("ping", function (args) { return { ok: true, echo: args }; });`

// testFrontendScript 涓€涓渶灏忕殑鍚堟硶鍓嶇鍏ュ彛鑴氭湰锛圗SM锛岀敱瀹夸富 WebView 鍔犺浇锛夈€?
const testFrontendScript = "export async function activate() { return { async deactivate() {} } }"

// manifestFiles 杩斿洖娓呭崟瀵瑰簲瀹夎鍖呴渶瑕佺殑鏂囦欢闆嗗悎銆?
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

// zipPackage 鎶婃竻鍗曚笌鏂囦欢鎵撴垚瀹夎鍖呫€?
func zipPackage(t *testing.T, mf *Manifest, extra map[string]string) []byte {
	t.Helper()

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	write := func(name, content string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("鍐欏叆 zip 鏉＄洰澶辫触: %v", err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("鍐欏叆 zip 鍐呭澶辫触: %v", err)
		}
	}

	files := manifestFiles(mf)
	for name, content := range extra {
		files[name] = content
	}

	raw, err := json.MarshalIndent(mf, "", "  ")
	if err != nil {
		t.Fatalf("搴忓垪鍖栨竻鍗曞け璐? %v", err)
	}
	write(ManifestFileName, string(raw))
	for name, content := range files {
		write(name, content)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("鍏抽棴 zip 澶辫触: %v", err)
	}
	return buf.Bytes()
}

// writePackageFile 鎶婂畨瑁呭寘鍐欏埌涓存椂鏂囦欢骞惰繑鍥炶矾寰勩€?
func writePackageFile(t *testing.T, mf *Manifest, extra map[string]string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), mf.ID+"-"+mf.Version+".zip")
	if err := os.WriteFile(path, zipPackage(t, mf, extra), 0o644); err != nil {
		t.Fatalf("鍐欏叆瀹夎鍖呭け璐? %v", err)
	}
	return path
}

// writePluginDir 鎶婃彃浠跺啓鎴愪竴涓湰鍦扮洰褰曪紙寮€鍙戣€呮ā寮忥級銆?
func writePluginDir(t *testing.T, mf *Manifest, extra map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	raw, err := json.MarshalIndent(mf, "", "  ")
	if err != nil {
		t.Fatalf("搴忓垪鍖栨竻鍗曞け璐? %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ManifestFileName), raw, 0o644); err != nil {
		t.Fatalf("鍐欏叆娓呭崟澶辫触: %v", err)
	}
	for name, content := range manifestFiles(mf) {
		target := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatalf("鍒涘缓鐩綍澶辫触: %v", err)
		}
		if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
			t.Fatalf("鍐欏叆鏂囦欢澶辫触: %v", err)
		}
	}
	for name, content := range extra {
		target := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatalf("鍒涘缓鐩綍澶辫触: %v", err)
		}
		if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
			t.Fatalf("鍐欏叆鏂囦欢澶辫触: %v", err)
		}
	}
	return dir
}

// installFromDir 瀹夎涓€涓湰鍦扮洰褰曟彃浠讹紙寮€鍙戞ā寮忥級锛屼究浜庣敓鍛藉懆鏈熸祴璇曘€?
func installFromDir(t *testing.T, mgr *Manager, mf *Manifest) {
	t.Helper()
	// 源码目录安装受开发者模式约束，这个辅助函数本身就是开发场景的入口
	mgr.SetDeveloperMode(true)
	dir := writePluginDir(t, mf, nil)
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceLocalDir, Ref: dir}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("棰勮鏈湴鎻掍欢 %s 澶辫触: %v", mf.ID, err)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("瀹夎鏈湴鎻掍欢 %s 澶辫触: %v", mf.ID, err)
	}
}

// findInfo 鍦ㄥ凡瀹夎鍒楄〃涓煡鎵炬彃浠躲€?
func findInfo(t *testing.T, mgr *Manager, id string) InstalledInfo {
	t.Helper()
	for _, info := range mgr.ListInstalled() {
		if info.ID == id {
			return info
		}
	}
	t.Fatalf("鏈壘鍒版彃浠?%s", id)
	return InstalledInfo{}
}

// ---------------------------------------------------------------- 娴嬭瘯鐢ㄧ储寮曟湇鍔?

// testRegistry 涓€涓湰鍦?HTTP 绱㈠紩 + 瀹夎鍖呮湇鍔★紝鐢ㄤ簬楠岃瘉鍦ㄧ嚎瀹夎閾捐矾銆?
type testRegistry struct {
	server     *httptest.Server
	entries    []RegistryEntry
	packages   map[string][]byte
	indexRaw   []byte
	signature  string
	signingKey ed25519.PrivateKey
}

// newTestRegistry 鍚姩鏈湴绱㈠紩鏈嶅姟銆?
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

// provider 杩斿洖绱㈠紩鏉ユ簮閰嶇疆銆?
func (r *testRegistry) provider() RegistryProvider {
	return RegistryProvider{IndexURL: r.server.URL + "/registry.json"}
}

// publish 鎶婁竴涓彃浠跺彂甯冨埌娴嬭瘯绱㈠紩銆?
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

// enableSigning 寮€鍚储寮曠鍚嶏紝骞舵妸鍏挜閰嶇疆涓哄涓诲唴缃叕閽ャ€?
func (r *testRegistry) enableSigning(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("鐢熸垚瀵嗛挜澶辫触: %v", err)
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

// rebuild 閲嶆柊娓叉煋绱㈠紩鍐呭锛堝繀瑕佹椂閲嶆柊绛惧悕锛夈€?
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
