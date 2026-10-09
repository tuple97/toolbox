// Package utils 提供密码加解密与 SQL 变量解析等通用能力。
package utils

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
)

// 加密前缀，便于识别密文并兼容未来算法升级。
const cipherPrefix = "enc:v1:"

// Cipher 封装 AES-GCM 加解密。
type Cipher struct {
	key []byte
	// source 记录主密钥来自系统凭证还是回退文件，用于诊断
	source KeySource
}

// NewCipher 加载或生成主密钥。
//
// 主密钥**优先存在系统凭证**里（见 LoadOrCreateKey）：
// Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service，
// 与数据库文件分开放置；只有系统凭证不可用时才回退到 fallbackDir 下的文件
// （fallbackDir 必须与 dataDir 不同，否则加密形同虚设）。
func NewCipher(dataDir, fallbackDir string) (*Cipher, error) {
	key, source, err := LoadOrCreateKey(dataDir, fallbackDir)
	if err != nil {
		return nil, err
	}
	if len(key) != keyLength {
		return nil, fmt.Errorf("密钥长度异常（%d 字节）", len(key))
	}
	return &Cipher{key: key, source: source}, nil
}

// KeySource 返回主密钥的存放位置（系统凭证 / 回退文件）。
func (c *Cipher) KeySource() KeySource {
	if c == nil {
		return ""
	}
	return c.source
}

// EncryptIfNeeded 只在值尚未加密时加密。
//
// 判断依据是「带前缀**且能解的开**」，而不是只看前缀：
// 只看前缀的话，用户密码恰好以 `enc:v1:` 开头就会被当成密文跳过加密，
// 明文直接落库，读取时又会按密文去解码。
func (c *Cipher) EncryptIfNeeded(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	if strings.HasPrefix(value, cipherPrefix) {
		if _, err := c.Decrypt(value); err == nil {
			return value, nil
		}
	}
	return c.Encrypt(value)
}

// Encrypt 加密明文，返回带前缀的 Base64 密文。
// 空字符串直接返回空，避免无意义加密。
func (c *Cipher) Encrypt(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	if c == nil || len(c.key) == 0 {
		return "", errors.New("加密器未初始化")
	}

	block, err := aes.NewCipher(c.key)
	if err != nil {
		return "", fmt.Errorf("创建 AES 失败: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("创建 GCM 失败: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("生成 nonce 失败: %w", err)
	}

	// nonce 前置到密文，解密时按长度切分
	sealed := gcm.Seal(nonce, nonce, []byte(plain), nil)
	return cipherPrefix + base64.StdEncoding.EncodeToString(sealed), nil
}

// Decrypt 解密由 Encrypt 产生的密文。
// 无前缀的输入视为历史明文，原样返回，保证兼容性。
func (c *Cipher) Decrypt(encoded string) (string, error) {
	if encoded == "" {
		return "", nil
	}
	if !strings.HasPrefix(encoded, cipherPrefix) {
		return encoded, nil
	}
	if c == nil || len(c.key) == 0 {
		return "", errors.New("加密器未初始化")
	}

	payload, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(encoded, cipherPrefix))
	if err != nil {
		return "", fmt.Errorf("密文解码失败: %w", err)
	}

	block, err := aes.NewCipher(c.key)
	if err != nil {
		return "", fmt.Errorf("创建 AES 失败: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("创建 GCM 失败: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(payload) < nonceSize {
		return "", errors.New("密文长度不足，可能已损坏")
	}

	nonce, ciphertext := payload[:nonceSize], payload[nonceSize:]
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("解密失败（密钥可能已变更）: %w", err)
	}
	return string(plain), nil
}

// MaskPassword 返回用于界面展示的掩码，避免密文直接暴露。
func MaskPassword(secret string) string {
	if secret == "" {
		return ""
	}
	return strings.Repeat("*", 8)
}
