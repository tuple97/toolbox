package plugin

import (
	"context"
	"fmt"
	"time"
)

/*
离线插件包（.zip）的安装支持。

用途：用户在浏览器/文件管理器里拿到插件包后，直接拖进插件管理页
或一次多选若干包安装，不依赖官方索引是否可达。

实现上刻意复用「从文件安装」的同一条路径
（prepareFromPayloadLocked → installPendingLocked），
因此信任关卡、权限扩张关卡、依赖求解、原子替换全部一致。
*/

// prepareFromArchiveLocked 从内存中的插件包构建待安装项。
func (m *Manager) prepareFromArchiveLocked(fileName string, content []byte) (*pendingInstall, error) {
	if len(content) == 0 {
		return nil, fmt.Errorf("插件包内容为空")
	}
	if len(content) > maxPackageBytes {
		return nil, fmt.Errorf("插件包过大（> %d 字节）", maxPackageBytes)
	}
	ref := fileName
	if ref == "" {
		ref = fmt.Sprintf("archive-%d.zip", time.Now().UnixNano())
	}
	return m.prepareFromPayloadLocked(SourceFile, ref, content, nil)
}

// PreviewArchive 预览从离线包安装：基本信息 + 依赖安装计划。
func (m *Manager) PreviewArchive(ctx context.Context, fileName string, content []byte) (*InstallPreview, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	pending, err := m.prepareFromArchiveLocked(fileName, content)
	if err != nil {
		return nil, err
	}
	preview := m.buildPreviewLocked(pending, InstallRequest{
		Source: SourceFile,
		Ref:    pending.ref,
	})
	m.attachPlanLocked(ctx, pending, preview)
	return preview, nil
}

// PreviewArchiveBasic 只读取离线包的基本信息（不求解依赖）。
func (m *Manager) PreviewArchiveBasic(fileName string, content []byte) (*InstallPreview, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	pending, err := m.prepareFromArchiveLocked(fileName, content)
	if err != nil {
		return nil, err
	}
	return m.buildPreviewLocked(pending, InstallRequest{
		Source: SourceFile,
		Ref:    pending.ref,
	}), nil
}

// InstallArchive 从离线包安装。
//
// trust / acceptPermissions 与从市场安装语义一致：
// 前者表示用户信任该来源，后者表示用户接受本次升级新增的权限。
func (m *Manager) InstallArchive(
	ctx context.Context,
	fileName string,
	content []byte,
	trust bool,
	acceptPermissions bool,
) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	pending, err := m.prepareFromArchiveLocked(fileName, content)
	if err != nil {
		return err
	}
	return m.installPendingLocked(ctx, pending, InstallRequest{
		Source:            SourceFile,
		Ref:               pending.ref,
		Trust:             trust,
		AcceptPermissions: acceptPermissions,
	})
}
