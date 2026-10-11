package plugin

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

/*
安装事务。

一次安装（单个插件或一批插件及其依赖）必须整体成功或整体失败：
多个文件系统目录无法天然组成一个原子操作，因此这里用
「事务日志 + 暂存区 + 备份目录」模拟一个适合本地桌面程序的原子提交：

  1. 先把所有内容写入 plugin-staging/<txid>/，正式目录保持不动；
  2. 写事务日志（先写日志再改正式目录，保证崩溃后可恢复）；
  3. 逐个提交：把已存在的版本目录改名为备份，再把暂存目录改名为正式目录，
     最后原子写入安装记录；
  4. 标记日志为 committed，清理备份与暂存。

崩溃后的恢复由 RecoverTransactions 完成：
未标记 committed 的事务一律回滚到事务开始前的状态。
*/

// 事务状态。
const (
	txStatePending   = "pending"
	txStateCommitted = "committed"
)

// 事务中单个插件的动作。
const (
	ActionInstall   = "install"
	ActionUpgrade   = "upgrade"
	ActionReinstall = "reinstall"
	ActionKeep      = "keep"
	ActionRollback  = "rollback"
)

// txOp 事务中单个插件的提交动作。
type txOp struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Action  string `json:"action"`

	// StagingDir 已就绪的暂存目录（提交时改名为 TargetDir）
	StagingDir string `json:"stagingDir"`
	// TargetDir 正式版本目录
	TargetDir string `json:"targetDir"`
	// BackupDir 目标已存在时，原目录先改名为它
	BackupDir string `json:"backupDir,omitempty"`
	// HadTarget 提交前目标目录是否已存在
	HadTarget bool `json:"hadTarget"`

	RecordPath string          `json:"recordPath"`
	NewRecord  json.RawMessage `json:"newRecord"`
	OldRecord  json.RawMessage `json:"oldRecord,omitempty"`
	HadRecord  bool            `json:"hadRecord"`
	// NewPlugin 本次事务之前该插件完全未安装
	NewPlugin bool `json:"newPlugin"`
}

// txJournal 事务日志。
type txJournal struct {
	ID        string `json:"id"`
	CreatedAt string `json:"createdAt"`
	State     string `json:"state"`
	Ops       []txOp `json:"ops"`
}

// Transaction 一次进行中的安装事务。
//
// 调用方先把内容写入暂存目录，再通过 AddOp 登记，最后 Commit。
type Transaction struct {
	store *Store
	id    string
	ops   []txOp
}

// NewTransaction 创建事务（会立即准备好暂存目录）。
func (s *Store) NewTransaction(id string) (*Transaction, error) {
	if id == "" {
		return nil, fmt.Errorf("事务 id 不能为空")
	}
	if err := s.EnsureLayout(); err != nil {
		return nil, err
	}
	root := s.StagingRoot(id)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("创建暂存目录失败: %w", err)
	}
	return &Transaction{store: s, id: id}, nil
}

// ID 返回事务标识。
func (t *Transaction) ID() string { return t.id }

// StagingVersionDir 返回本次事务中某插件版本的暂存目录，并确保父目录存在。
func (t *Transaction) StagingVersionDir(id, version string) (string, error) {
	dir := t.store.StagingVersionDir(t.id, id, version)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建暂存目录失败: %w", err)
	}
	return dir, nil
}

// AddOp 登记一个插件的提交动作。
//
// stagingDir 为空表示该插件无需落地文件（例如仅切换启用版本的回滚）。
func (t *Transaction) AddOp(op txOp) {
	t.ops = append(t.ops, op)
}

// Abort 放弃事务：清理暂存目录，不触碰正式目录。
func (t *Transaction) Abort() {
	_ = os.RemoveAll(t.store.StagingRoot(t.id))
	_ = os.Remove(t.store.JournalPath(t.id))
}

// Commit 提交事务。任何一步失败都会回滚到事务开始前的状态。
func (t *Transaction) Commit() error {
	if len(t.ops) == 0 {
		t.Abort()
		return nil
	}

	journal := txJournal{
		ID:        t.id,
		CreatedAt: nowRFC3339(),
		State:     txStatePending,
		Ops:       t.ops,
	}
	if err := t.writeJournal(&journal); err != nil {
		return err
	}

	for i := range journal.Ops {
		if err := t.applyOp(&journal.Ops[i]); err != nil {
			// 回滚已经完成的部分，恢复到事务开始前的状态
			return t.rollback(&journal, err)
		}
	}

	journal.State = txStateCommitted
	if err := t.writeJournal(&journal); err != nil {
		/*
		 * 提交标记写不进去（磁盘满、权限问题等）。
		 *
		 * 此时文件已经就位，但日志仍是 pending —— 如果放任不管，下次启动会
		 * 按 pending 回滚一个实际上已完成的安装。因此这里立即回滚：
		 * 「报告失败」与「磁盘回到安装前」必须一致。
		 */
		slog.Error("标记事务已提交失败，改为回滚", "tx", t.id, "error", err)
		return t.rollback(&journal, fmt.Errorf("标记事务已提交失败: %w", err))
	}

	t.cleanupAfterCommit(&journal)
	return nil
}

// rollback 回滚事务并在成功后清理暂存与日志。
//
// 回滚本身失败时保留日志，交给下次启动的恢复流程重试。
func (t *Transaction) rollback(journal *txJournal, cause error) error {
	if rollbackErr := rollbackJournal(t.store, journal); rollbackErr != nil {
		slog.Error("安装事务回滚失败", "tx", t.id, "error", rollbackErr)
		return fmt.Errorf("%w；且回滚失败：%v（请重启应用以触发自动恢复）", cause, rollbackErr)
	}
	_ = os.Remove(t.store.JournalPath(t.id))
	_ = os.RemoveAll(t.store.StagingRoot(t.id))
	return cause
}

// applyOp 执行单个提交动作。
func (t *Transaction) applyOp(op *txOp) error {
	if op.HadTarget && op.BackupDir != "" {
		if _, err := os.Stat(op.BackupDir); err == nil {
			// 备份已存在（上次中断的残留）：先清掉
			if err := os.RemoveAll(op.BackupDir); err != nil {
				return fmt.Errorf("清理旧备份失败(%s): %w", op.ID, err)
			}
		}
		if err := os.Rename(op.TargetDir, op.BackupDir); err != nil {
			// 目标目录不存在时继续（可能已被回滚流程移除）
			if !os.IsNotExist(err) {
				return fmt.Errorf("备份旧版本失败(%s@%s): %w", op.ID, op.Version, err)
			}
		}
	}

	if op.StagingDir != "" {
		if err := os.MkdirAll(filepath.Dir(op.TargetDir), 0o755); err != nil {
			return fmt.Errorf("创建插件目录失败(%s): %w", op.ID, err)
		}
		if err := os.Rename(op.StagingDir, op.TargetDir); err != nil {
			return fmt.Errorf("提交插件版本失败(%s@%s): %w", op.ID, op.Version, err)
		}
	}

	if len(op.NewRecord) > 0 {
		if err := writeFileAtomic(op.RecordPath, op.NewRecord, 0o644); err != nil {
			return fmt.Errorf("写入安装记录失败(%s): %w", op.ID, err)
		}
	}
	return nil
}

// cleanupAfterCommit 清理备份、暂存目录与事务日志。
func (t *Transaction) cleanupAfterCommit(journal *txJournal) {
	for i := range journal.Ops {
		if journal.Ops[i].BackupDir != "" {
			_ = os.RemoveAll(journal.Ops[i].BackupDir)
		}
	}
	_ = os.RemoveAll(t.store.StagingRoot(t.id))
	_ = os.Remove(t.store.JournalPath(t.id))
}

func (t *Transaction) writeJournal(journal *txJournal) error {
	raw, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化事务日志失败: %w", err)
	}
	if err := writeFileAtomic(t.store.JournalPath(t.id), raw, 0o644); err != nil {
		return fmt.Errorf("写入事务日志失败: %w", err)
	}
	return nil
}

// RecoveredTransaction 一次被恢复流程处理过的事务。
type RecoveredTransaction struct {
	ID     string
	State  string
	Rolled bool
}

// RecoverTransactions 启动时恢复上次运行遗留的事务。
//
// 返回被处理的事务列表；单个事务恢复失败不会中断其它事务的处理，
// 但错误会被汇总返回，界面上应提示用户。
func (s *Store) RecoverTransactions() ([]RecoveredTransaction, error) {
	entries, err := os.ReadDir(s.txDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("读取事务目录失败: %w", err)
	}

	var recovered []RecoveredTransaction
	var firstErr error

	for _, entry := range entries {
		if entry.IsDir() || !hasJSONSuffix(entry.Name()) {
			continue
		}
		path := filepath.Join(s.txDir, entry.Name())
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("读取事务日志失败(%s): %w", entry.Name(), readErr)
			}
			continue
		}

		var journal txJournal
		if jsonErr := json.Unmarshal(raw, &journal); jsonErr != nil {
			// 事务日志是原子写入的，出现非法内容说明它不属于本实现；
			// 由于正式目录只在日志写完之后才被修改，这里安全地丢弃它。
			slog.Warn("丢弃无法解析的事务日志", "file", entry.Name(), "error", jsonErr)
			_ = os.Remove(path)
			if journal.ID != "" {
				_ = os.RemoveAll(s.StagingRoot(journal.ID))
			}
			continue
		}
		if journal.ID == "" {
			journal.ID = trimJSONSuffix(entry.Name())
		}

		result := RecoveredTransaction{ID: journal.ID, State: journal.State}
		if journal.State == txStateCommitted {
			err := cleanupCommitted(s, &journal)
			if err != nil && firstErr == nil {
				firstErr = err
			}
		} else {
			if err := rollbackJournal(s, &journal); err != nil {
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			result.Rolled = true
		}
		_ = os.Remove(path)
		_ = os.RemoveAll(s.StagingRoot(journal.ID))
		recovered = append(recovered, result)
	}
	return recovered, firstErr
}

// rollbackJournal 回滚一个事务，把状态恢复到事务开始前。
func rollbackJournal(s *Store, journal *txJournal) error {
	var firstErr error
	// 逆序回滚：后提交的先撤销
	for i := len(journal.Ops) - 1; i >= 0; i-- {
		op := &journal.Ops[i]

		if op.BackupDir != "" {
			if _, err := os.Stat(op.BackupDir); err == nil {
				_ = os.RemoveAll(op.TargetDir)
				if err := os.Rename(op.BackupDir, op.TargetDir); err != nil {
					firstErr = firstErrOr(firstErr, fmt.Errorf("恢复旧版本失败(%s@%s): %w", op.ID, op.Version, err))
				}
			} else if !op.HadTarget {
				// 目标原本不存在：撤销本次新建的版本目录
				if err := os.RemoveAll(op.TargetDir); err != nil {
					firstErr = firstErrOr(firstErr, fmt.Errorf("撤销新版本失败(%s@%s): %w", op.ID, op.Version, err))
				}
			}
		} else if !op.HadTarget && op.StagingDir != "" {
			// 无备份且目标原本不存在：若目标已出现说明本事务已改过名
			if s.HasVersion(op.ID, op.Version) {
				if err := os.RemoveAll(op.TargetDir); err != nil {
					firstErr = firstErrOr(firstErr, fmt.Errorf("撤销新版本失败(%s@%s): %w", op.ID, op.Version, err))
				}
			}
		}

		// 恢复安装记录
		if op.HadRecord && len(op.OldRecord) > 0 {
			if err := writeFileAtomic(op.RecordPath, op.OldRecord, 0o644); err != nil {
				firstErr = firstErrOr(firstErr, fmt.Errorf("恢复安装记录失败(%s): %w", op.ID, err))
			}
		} else if !op.HadRecord {
			if err := os.Remove(op.RecordPath); err != nil && !os.IsNotExist(err) {
				firstErr = firstErrOr(firstErr, fmt.Errorf("清理安装记录失败(%s): %w", op.ID, err))
			}
		}

		// 清理插件目录：新建的插件回滚后目录应为空，避免留下空壳
		if op.NewPlugin {
			dir := s.PluginDir(op.ID)
			if isEmptyDir(dir) {
				_ = os.Remove(dir)
			}
		}
	}
	return firstErr
}

// cleanupCommitted 清理已提交事务的残留备份。
func cleanupCommitted(s *Store, journal *txJournal) error {
	var firstErr error
	for i := range journal.Ops {
		if journal.Ops[i].BackupDir == "" {
			continue
		}
		if err := os.RemoveAll(journal.Ops[i].BackupDir); err != nil {
			firstErr = firstErrOr(firstErr, err)
		}
	}
	return firstErr
}

func firstErrOr(current, next error) error {
	if current != nil {
		return current
	}
	return next
}

func isEmptyDir(path string) bool {
	entries, err := os.ReadDir(path)
	return err == nil && len(entries) == 0
}

func hasJSONSuffix(name string) bool {
	return len(name) > 5 && name[len(name)-5:] == ".json"
}

func trimJSONSuffix(name string) string {
	if hasJSONSuffix(name) {
		return name[:len(name)-5]
	}
	return name
}
