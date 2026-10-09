package utils

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/zalando/go-keyring"
)

// 主密钥在系统凭证里的定位（服务名 / 条目名）。
const (
	keyringService = "toolbox"
	keyringAccount = "db-cipher-key"
)

// KeySource 说明主密钥这次来自哪里：用于启动日志与文档里的「加密边界」说明。
type KeySource string

const (
	// KeySourceKeyring 存在系统凭证里：
	// Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service。
	// 这种情况下密钥与数据库不在同一个地方，拿到用户配置目录也拿不到密钥。
	KeySourceKeyring KeySource = "keyring"
	// KeySourceFile 系统凭证不可用，回退到文件。
	// 该目录必须与数据库目录分开，否则加密形同虚设。
	KeySourceFile KeySource = "file"
)

// keyFileName 回退方案里保存密钥的文件名（旧版本同名文件位于数据目录内）。
const keyFileName = ".secret.key"

// keyLength 主密钥长度（AES-256）。
const keyLength = 32

// LoadOrCreateKey 读取或生成主密钥。
//
// 优先级：
//  1. 系统凭证（首选）——密钥与数据库分离；
//  2. 旧版本遗留在数据目录里的 `.secret.key`：迁移进系统凭证后删除，
//     保证老用户已存的密码还能解开；
//  3. 系统凭证不可用（Linux 无 Secret Service、无图形会话等）时回退到
//     fallbackDir 下的文件，fallbackDir 必须与 dataDir 不同。
//
// 注意：本方案保护的是「同机其他用户 / 备份同步目录」这类场景，
// 不防御能登录本机的攻击者直接读内存，也不防跨机器拷贝。
func LoadOrCreateKey(dataDir, fallbackDir string) ([]byte, KeySource, error) {
	if secret, err := keyring.Get(keyringService, keyringAccount); err == nil {
		key, decodeErr := base64.StdEncoding.DecodeString(secret)
		if decodeErr != nil {
			// 内容异常时不覆盖：覆盖会让已存的密码全部解不开
			return nil, "", fmt.Errorf("系统凭证中的密钥格式异常: %w", decodeErr)
		}
		if len(key) != keyLength {
			return nil, "", fmt.Errorf("系统凭证中的密钥长度异常（%d 字节）", len(key))
		}
		return key, KeySourceKeyring, nil
	}

	// 迁移旧密钥：数据目录里那份与数据库同目录，安全性不够
	legacyPath := filepath.Join(dataDir, keyFileName)
	if legacy, readErr := os.ReadFile(legacyPath); readErr == nil && len(legacy) > 0 {
		if err := keyring.Set(keyringService, keyringAccount, encodeKey(legacy)); err == nil {
			_ = os.Remove(legacyPath)
			return legacy, KeySourceKeyring, nil
		}
		// 写不进系统凭证：至少挪出数据目录，别再和数据库同处一室
		if fallbackDir != "" {
			if writeErr := writeKeyFile(fallbackDir, legacy); writeErr == nil {
				_ = os.Remove(legacyPath)
				return legacy, KeySourceFile, nil
			}
		}
		// 都失败了：这次先用旧密钥，下次启动会再试
		return legacy, KeySourceKeyring, nil
	}

	generated := make([]byte, keyLength)
	if _, err := io.ReadFull(rand.Reader, generated); err != nil {
		return nil, "", fmt.Errorf("生成密钥失败: %w", err)
	}

	if err := keyring.Set(keyringService, keyringAccount, encodeKey(generated)); err == nil {
		return generated, KeySourceKeyring, nil
	}
	if fallbackDir == "" {
		return nil, "", errors.New("系统凭证不可用，且没有可用的回退目录")
	}
	if err := writeKeyFile(fallbackDir, generated); err != nil {
		return nil, "", err
	}
	return generated, KeySourceFile, nil
}

func encodeKey(key []byte) string {
	return base64.StdEncoding.EncodeToString(key)
}

// writeKeyFile 把密钥写到 dir（与数据库目录分开）。
//
// 说明：0o600 这类权限位在 Windows 上不生效，所以文件回退只是「退而求其次」，
// 真正的安全边界由系统凭证提供。
func writeKeyFile(dir string, key []byte) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("创建密钥目录失败: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, keyFileName), key, 0o600); err != nil {
		return fmt.Errorf("保存密钥失败: %w", err)
	}
	return nil
}
