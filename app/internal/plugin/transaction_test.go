package plugin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestStore 创建使用临时目录的插件仓库。
func newTestStore(t *testing.T) *Store {
	t.Helper()
	store := NewStore(t.TempDir())
	if err := store.EnsureLayout(); err != nil {
		t.Fatalf("初始化目录失败: %v", err)
	}
	return store
}

// seedInstalled 在磁盘上放置一个「已安装版本」。
func seedInstalled(t *testing.T, store *Store, id, version, marker string) {
	t.Helper()
	dir := store.VersionDir(id, version)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	mf := baseManifest(id, version)
	raw, _ := json.Marshal(mf)
	if err := os.WriteFile(filepath.Join(dir, ManifestFileName), raw, 0o644); err != nil {
		t.Fatalf("写入清单失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "marker.txt"), []byte(marker), 0o644); err != nil {
		t.Fatalf("写入标记失败: %v", err)
	}
	if err := store.WriteRecord(&InstallRecord{
		ID: id, Version: version, Source: SourceLocalDir,
		Trust: TrustUser, Enabled: true, Checksum: marker, InstalledAt: nowRFC3339(),
	}); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
}

// readMarker 读取版本目录中的标记文件。
func readMarker(t *testing.T, store *Store, id, version string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(store.VersionDir(id, version), "marker.txt"))
	if err != nil {
		t.Fatalf("读取标记失败: %v", err)
	}
	return string(raw)
}

// stageVersion 在事务暂存区里准备一个版本目录。
func stageVersion(t *testing.T, tx *Transaction, id, version, marker string) string {
	t.Helper()
	dir, err := tx.StagingVersionDir(id, version)
	if err != nil {
		t.Fatalf("创建暂存目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "marker.txt"), []byte(marker), 0o644); err != nil {
		t.Fatalf("写入标记失败: %v", err)
	}
	return dir
}

// recordJSON 序列化安装记录。
func recordJSON(t *testing.T, rec *InstallRecord) []byte {
	t.Helper()
	raw, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	return raw
}

// TestTransactionCommit 事务提交后文件与记录一起生效，且不留残留。
func TestTransactionCommit(t *testing.T) {
	store := newTestStore(t)
	seedInstalled(t, store, "com.toolbox.tx", "1.0.0", "old")

	tx, err := store.NewTransaction("tx-commit")
	if err != nil {
		t.Fatalf("创建事务失败: %v", err)
	}
	staging := stageVersion(t, tx, "com.toolbox.tx", "2.0.0", "new")

	next := &InstallRecord{
		ID: "com.toolbox.tx", Version: "2.0.0", Source: SourceLocalDir,
		Trust: TrustUser, Enabled: true, InstalledAt: nowRFC3339(), PreviousVersion: "1.0.0",
	}
	tx.AddOp(txOp{
		ID: "com.toolbox.tx", Version: "2.0.0", Action: ActionUpgrade,
		StagingDir: staging,
		TargetDir:  store.VersionDir("com.toolbox.tx", "2.0.0"),
		BackupDir:  store.VersionDir("com.toolbox.tx", "2.0.0") + ".backup",
		HadTarget:  false,
		RecordPath: store.RecordPath("com.toolbox.tx"),
		NewRecord:  recordJSON(t, next),
		OldRecord:  recordJSON(t, &InstallRecord{ID: "com.toolbox.tx", Version: "1.0.0"}),
		HadRecord:  true,
	})
	if err := tx.Commit(); err != nil {
		t.Fatalf("提交失败: %v", err)
	}

	if readMarker(t, store, "com.toolbox.tx", "2.0.0") != "new" {
		t.Fatal("新版本未落地")
	}
	rec, err := store.ReadRecord("com.toolbox.tx")
	if err != nil {
		t.Fatalf("读取记录失败: %v", err)
	}
	if rec.Version != "2.0.0" || rec.PreviousVersion != "1.0.0" {
		t.Fatalf("记录不正确: %+v", rec)
	}
	if _, err := os.Stat(store.StagingRoot("tx-commit")); !os.IsNotExist(err) {
		t.Fatal("暂存目录应被清理")
	}
	if _, err := os.Stat(store.JournalPath("tx-commit")); !os.IsNotExist(err) {
		t.Fatal("事务日志应被清理")
	}
}

// TestTransactionFailureRollsBack 提交中途失败必须恢复到事务前状态。
func TestTransactionFailureRollsBack(t *testing.T) {
	store := newTestStore(t)
	seedInstalled(t, store, "com.toolbox.tx", "1.0.0", "old")

	tx, err := store.NewTransaction("tx-fail")
	if err != nil {
		t.Fatalf("创建事务失败: %v", err)
	}
	// 第二个动作的暂存目录不存在：重命名必然失败
	first := stageVersion(t, tx, "com.toolbox.tx", "2.0.0", "new")
	tx.AddOp(txOp{
		ID: "com.toolbox.tx", Version: "2.0.0", Action: ActionUpgrade,
		StagingDir: first,
		TargetDir:  store.VersionDir("com.toolbox.tx", "2.0.0"),
		BackupDir:  store.VersionDir("com.toolbox.tx", "2.0.0") + ".backup",
		RecordPath: store.RecordPath("com.toolbox.tx"),
		NewRecord:  recordJSON(t, &InstallRecord{ID: "com.toolbox.tx", Version: "2.0.0"}),
		HadRecord:  true,
	})
	// 覆盖已有版本以验证备份/回滚
	tx.AddOp(txOp{
		ID: "com.toolbox.tx", Version: "1.0.0", Action: ActionReinstall,
		StagingDir: filepath.Join(store.StagingRoot("tx-fail"), "missing"),
		TargetDir:  store.VersionDir("com.toolbox.tx", "1.0.0"),
		BackupDir:  store.VersionDir("com.toolbox.tx", "1.0.0") + ".backup",
		HadTarget:  true,
		RecordPath: store.RecordPath("com.toolbox.tx"),
		NewRecord:  recordJSON(t, &InstallRecord{ID: "com.toolbox.tx", Version: "1.0.0"}),
		HadRecord:  true,
	})

	if err := tx.Commit(); err == nil {
		t.Fatal("预期提交失败")
	}

	// 事务前的状态必须完好
	if readMarker(t, store, "com.toolbox.tx", "1.0.0") != "old" {
		t.Fatal("回滚后旧版本内容应保持不变")
	}
	if store.HasVersion("com.toolbox.tx", "2.0.0") {
		t.Fatal("回滚后不应留下新版本")
	}
	if _, err := os.Stat(store.VersionDir("com.toolbox.tx", "1.0.0") + ".backup"); !os.IsNotExist(err) {
		t.Fatal("备份目录应被清理")
	}
	if _, err := os.Stat(store.JournalPath("tx-fail")); !os.IsNotExist(err) {
		t.Fatal("失败后事务日志应被清理")
	}
	if _, err := os.Stat(store.StagingRoot("tx-fail")); !os.IsNotExist(err) {
		t.Fatal("失败后暂存目录应被清理")
	}
}

// TestRecoverRollsBackInterruptedTransaction 进程在提交过程中崩溃后应能恢复。
func TestRecoverRollsBackInterruptedTransaction(t *testing.T) {
	store := newTestStore(t)
	seedInstalled(t, store, "com.toolbox.crash", "1.0.0", "old")

	// 手工构造「已把 2.0.0 改名到位、已写新记录、但日志仍是 pending」的现场
	target := store.VersionDir("com.toolbox.crash", "2.0.0")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(target, "marker.txt"), []byte("half"), 0o644); err != nil {
		t.Fatalf("写入标记失败: %v", err)
	}
	newRec := &InstallRecord{ID: "com.toolbox.crash", Version: "2.0.0", Trust: TrustUser, Enabled: true}
	if err := store.WriteRecord(newRec); err != nil {
		t.Fatalf("写入新记录失败: %v", err)
	}

	journal := txJournal{
		ID:        "tx-crash",
		CreatedAt: nowRFC3339(),
		State:     txStatePending,
		Ops: []txOp{{
			ID: "com.toolbox.crash", Version: "2.0.0", Action: ActionUpgrade,
			TargetDir:  target,
			BackupDir:  filepath.Join(store.Root(), "com.toolbox.crash", "2.0.0.backup"),
			HadTarget:  false,
			RecordPath: store.RecordPath("com.toolbox.crash"),
			NewRecord:  recordJSON(t, newRec),
			OldRecord: recordJSON(t, &InstallRecord{
				ID: "com.toolbox.crash", Version: "1.0.0", Trust: TrustUser, Enabled: true,
			}),
			HadRecord: true,
		}},
	}
	raw, _ := json.MarshalIndent(journal, "", "  ")
	if err := os.WriteFile(store.JournalPath("tx-crash"), raw, 0o644); err != nil {
		t.Fatalf("写入日志失败: %v", err)
	}

	recovered, err := store.RecoverTransactions()
	if err != nil {
		t.Fatalf("恢复失败: %v", err)
	}
	if len(recovered) != 1 || !recovered[0].Rolled {
		t.Fatalf("应回滚 1 个事务: %+v", recovered)
	}
	if store.HasVersion("com.toolbox.crash", "2.0.0") {
		t.Fatal("恢复后应撤销半提交的新版本")
	}
	rec, err := store.ReadRecord("com.toolbox.crash")
	if err != nil {
		t.Fatalf("读取记录失败: %v", err)
	}
	if rec.Version != "1.0.0" {
		t.Fatalf("恢复后应回到旧版本记录，实际 %s", rec.Version)
	}
	if readMarker(t, store, "com.toolbox.crash", "1.0.0") != "old" {
		t.Fatal("旧版本内容应保持完好")
	}
	if _, err := os.Stat(store.JournalPath("tx-crash")); !os.IsNotExist(err) {
		t.Fatal("恢复后应清理日志")
	}
}

// TestRecoverRestoresBackup 崩溃时已把旧版本改名为备份的场景应能恢复。
func TestRecoverRestoresBackup(t *testing.T) {
	store := newTestStore(t)
	seedInstalled(t, store, "com.toolbox.crash2", "1.0.0", "old")

	backup := store.VersionDir("com.toolbox.crash2", "1.0.0") + ".backup-abc"
	if err := os.Rename(store.VersionDir("com.toolbox.crash2", "1.0.0"), backup); err != nil {
		t.Fatalf("模拟备份失败: %v", err)
	}
	// 新内容已经就位
	if err := os.MkdirAll(store.VersionDir("com.toolbox.crash2", "1.0.0"), 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(store.VersionDir("com.toolbox.crash2", "1.0.0"), "marker.txt"), []byte("new"), 0o644); err != nil {
		t.Fatalf("写入标记失败: %v", err)
	}

	journal := txJournal{
		ID: "tx-crash2", CreatedAt: nowRFC3339(), State: txStatePending,
		Ops: []txOp{{
			ID: "com.toolbox.crash2", Version: "1.0.0", Action: ActionReinstall,
			TargetDir:  store.VersionDir("com.toolbox.crash2", "1.0.0"),
			BackupDir:  backup,
			HadTarget:  true,
			RecordPath: store.RecordPath("com.toolbox.crash2"),
			NewRecord:  recordJSON(t, &InstallRecord{ID: "com.toolbox.crash2", Version: "1.0.0", Checksum: "new"}),
			OldRecord:  recordJSON(t, &InstallRecord{ID: "com.toolbox.crash2", Version: "1.0.0", Checksum: "old"}),
			HadRecord:  true,
		}},
	}
	raw, _ := json.MarshalIndent(journal, "", "  ")
	if err := os.WriteFile(store.JournalPath("tx-crash2"), raw, 0o644); err != nil {
		t.Fatalf("写入日志失败: %v", err)
	}

	if _, err := store.RecoverTransactions(); err != nil {
		t.Fatalf("恢复失败: %v", err)
	}
	if readMarker(t, store, "com.toolbox.crash2", "1.0.0") != "old" {
		t.Fatal("应从备份恢复旧内容")
	}
	rec, _ := store.ReadRecord("com.toolbox.crash2")
	if rec.Checksum != "old" {
		t.Fatalf("应恢复旧记录，实际 %+v", rec)
	}
}

// TestRecoverCleansCommittedTransaction 已完成的事务只做清理。
func TestRecoverCleansCommittedTransaction(t *testing.T) {
	store := newTestStore(t)
	seedInstalled(t, store, "com.toolbox.done", "1.0.0", "old")

	backup := store.VersionDir("com.toolbox.done", "1.0.0") + ".backup-done"
	if err := os.MkdirAll(backup, 0o755); err != nil {
		t.Fatalf("创建备份目录失败: %v", err)
	}

	journal := txJournal{
		ID: "tx-done", CreatedAt: nowRFC3339(), State: txStateCommitted,
		Ops: []txOp{{
			ID: "com.toolbox.done", Version: "1.0.0",
			TargetDir: store.VersionDir("com.toolbox.done", "1.0.0"),
			BackupDir: backup,
		}},
	}
	raw, _ := json.MarshalIndent(journal, "", "  ")
	if err := os.WriteFile(store.JournalPath("tx-done"), raw, 0o644); err != nil {
		t.Fatalf("写入日志失败: %v", err)
	}

	recovered, err := store.RecoverTransactions()
	if err != nil {
		t.Fatalf("恢复失败: %v", err)
	}
	if len(recovered) != 1 || recovered[0].Rolled {
		t.Fatalf("已完成事务不应回滚: %+v", recovered)
	}
	if _, err := os.Stat(backup); !os.IsNotExist(err) {
		t.Fatal("已完成事务的备份应被清理")
	}
	if readMarker(t, store, "com.toolbox.done", "1.0.0") != "old" {
		t.Fatal("已完成事务不应改动正式文件")
	}
}

// TestRecoverDiscardsCorruptJournal 无法解析的日志应被丢弃且不影响正式目录。
func TestRecoverDiscardsCorruptJournal(t *testing.T) {
	store := newTestStore(t)
	seedInstalled(t, store, "com.toolbox.ok", "1.0.0", "old")
	if err := os.WriteFile(store.JournalPath("tx-bad"), []byte("{not json"), 0o644); err != nil {
		t.Fatalf("写入日志失败: %v", err)
	}

	if _, err := store.RecoverTransactions(); err != nil {
		t.Fatalf("恢复失败: %v", err)
	}
	if _, err := os.Stat(store.JournalPath("tx-bad")); !os.IsNotExist(err) {
		t.Fatal("损坏的日志应被丢弃")
	}
	if readMarker(t, store, "com.toolbox.ok", "1.0.0") != "old" {
		t.Fatal("丢弃损坏日志不应影响正式目录")
	}
}

// TestLegacyRecordMigration 旧格式安装记录应被幂等迁移。
func TestLegacyRecordMigration(t *testing.T) {
	store := newTestStore(t)
	id := "com.toolbox.legacy"
	if err := os.MkdirAll(store.VersionDir(id, "1.0.0"), 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}

	legacy := map[string]any{
		"id": id, "version": "1.0.0", "source": "registry",
		"trusted": true, "official": true, "enabled": true,
		"installedAt": "2025-01-01T00:00:00Z",
	}
	raw, _ := json.Marshal(legacy)
	if err := os.WriteFile(store.legacyRecordPath(id), raw, 0o644); err != nil {
		t.Fatalf("写入旧记录失败: %v", err)
	}

	rec, err := store.ReadRecord(id)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if rec.Trust != TrustOfficial || !rec.Enabled {
		t.Fatalf("迁移结果不正确: %+v", rec)
	}
	if _, err := os.Stat(store.RecordPath(id)); err != nil {
		t.Fatalf("迁移后应写出新格式记录: %v", err)
	}

	// 再读一次应走新格式，结果保持一致（幂等）
	again, err := store.ReadRecord(id)
	if err != nil {
		t.Fatalf("二次读取失败: %v", err)
	}
	if again.Trust != rec.Trust || again.Version != rec.Version {
		t.Fatalf("迁移不幂等: %+v vs %+v", rec, again)
	}
}

// TestCleanupOldVersionsProtectsCurrent 清理旧版本不能删掉当前与回滚版本。
func TestCleanupOldVersionsProtectsCurrent(t *testing.T) {
	store := newTestStore(t)
	id := "com.toolbox.clean"
	for _, version := range []string{"1.0.0", "1.1.0", "1.2.0", "1.3.0"} {
		if err := os.MkdirAll(store.VersionDir(id, version), 0o755); err != nil {
			t.Fatalf("创建目录失败: %v", err)
		}
	}

	removed, err := store.CleanupOldVersions(id, 0, "1.3.0", "1.2.0")
	if err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	if len(removed) != 2 {
		t.Fatalf("应删除 2 个旧版本，实际 %v", removed)
	}
	if !store.HasVersion(id, "1.3.0") || !store.HasVersion(id, "1.2.0") {
		t.Fatal("受保护的版本不得删除")
	}
	if store.HasVersion(id, "1.0.0") {
		t.Fatal("旧版本应被删除")
	}
}

// TestCacheRoundTrip 包缓存的读写与清理。
func TestCacheRoundTrip(t *testing.T) {
	store := newTestStore(t)
	mf := baseManifest("com.toolbox.cache", "1.0.0")
	payload := zipPackage(t, mf, nil)
	digest := HashBytes(payload)

	if err := store.PutCache(digest, payload, mf); err != nil {
		t.Fatalf("写入缓存失败: %v", err)
	}
	got, ok, err := store.ReadCache(digest)
	if err != nil || !ok {
		t.Fatalf("读取缓存失败: ok=%v err=%v", ok, err)
	}
	if HashBytes(got) != digest {
		t.Fatal("缓存内容不一致")
	}

	cached := store.CachedPackages()
	if len(cached) != 1 || cached[0].Manifest.ID != mf.ID {
		t.Fatalf("缓存清单索引不正确: %+v", cached)
	}

	removed, err := store.CleanupCache(map[string]struct{}{})
	if err != nil {
		t.Fatalf("清理缓存失败: %v", err)
	}
	if removed != 1 {
		t.Fatalf("应清理 1 个缓存包，实际 %d", removed)
	}
	if _, ok, _ := store.ReadCache(digest); ok {
		t.Fatal("清理后缓存应失效")
	}
	if len(store.CachedPackages()) != 0 {
		t.Fatal("清理后不应残留清单副本")
	}
}

// TestCacheRejectsCorruptedContent 缓存内容损坏时视为未命中。
func TestCacheRejectsCorruptedContent(t *testing.T) {
	store := newTestStore(t)
	mf := baseManifest("com.toolbox.cache2", "1.0.0")
	payload := zipPackage(t, mf, nil)
	digest := HashBytes(payload)
	if err := store.PutCache(digest, payload, mf); err != nil {
		t.Fatalf("写入缓存失败: %v", err)
	}
	path, ok := store.CacheFile(digest)
	if !ok {
		t.Fatal("应有缓存文件")
	}
	if err := os.WriteFile(path, []byte("corrupted"), 0o644); err != nil {
		t.Fatalf("篡改缓存失败: %v", err)
	}
	if _, hit, _ := store.ReadCache(digest); hit {
		t.Fatal("损坏的缓存不应命中")
	}
}

// TestAssetPathRejectsEscape 资源路径不能越出插件版本目录。
func TestAssetPathRejectsEscape(t *testing.T) {
	store := newTestStore(t)
	if _, err := store.AssetPath("com.toolbox.a", "1.0.0", "../../secret.txt"); err == nil {
		t.Fatal("穿越路径必须被拒绝")
	}
	if _, err := store.AssetPath("../a", "1.0.0", "x.js"); err == nil {
		t.Fatal("非法插件 id 必须被拒绝")
	}
	if _, err := store.AssetPath("com.toolbox.a", "not-a-version", "x.js"); err == nil {
		t.Fatal("非法版本必须被拒绝")
	}
}

// TestRecordMissingVersionDirectoryIsDisabled 记录指向不存在的版本时不应被启用。
func TestRecordMissingVersionDirectoryIsDisabled(t *testing.T) {
	mgr := newTestManager(t)
	id := "com.toolbox.lost"
	if err := mgr.Store().WriteRecord(&InstallRecord{
		ID: id, Version: "9.9.9", Source: SourceLocalDir,
		Trust: TrustUser, Enabled: true, InstalledAt: nowRFC3339(),
	}); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
	if err := mgr.Reload(t.Context()); err != nil {
		t.Fatalf("重载失败: %v", err)
	}

	info := findInfo(t, mgr, id)
	if info.Enabled || info.Active {
		t.Fatalf("版本目录缺失时不应视为启用/运行: %+v", info)
	}
}

// TestBrokenManifestMarksPluginUnavailable 清单损坏的插件不能被当作正常运行。
func TestBrokenManifestMarksPluginUnavailable(t *testing.T) {
	mgr := newTestManager(t)
	id := "com.toolbox.broken"
	dir := mgr.Store().VersionDir(id, "1.0.0")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ManifestFileName), []byte("{"), 0o644); err != nil {
		t.Fatalf("写入清单失败: %v", err)
	}
	if err := mgr.Store().WriteRecord(&InstallRecord{
		ID: id, Version: "1.0.0", Source: SourceLocalDir,
		Trust: TrustUser, Enabled: true, InstalledAt: nowRFC3339(),
	}); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
	if err := mgr.Reload(t.Context()); err != nil {
		t.Fatalf("重载失败: %v", err)
	}

	info := findInfo(t, mgr, id)
	if info.Active {
		t.Fatal("清单损坏的插件不应处于运行状态")
	}
	if !strings.Contains(info.LoadError, "清单") {
		t.Fatalf("应提示清单问题: %q", info.LoadError)
	}
}
