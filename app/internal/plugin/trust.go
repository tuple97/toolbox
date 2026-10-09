package plugin

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
)

// RegistryPublicKey 官方插件索引的签名公钥（Ed25519，base64 编码的 32 字节）。
//
// 由官方仓库 tuple97/toolbox-plugins 的发布流程持有对应私钥；
// 应用内硬编码公钥，因此索引一旦被篡改，验签必然失败。
//
// 为空时表示「尚未启用签名校验」：此时索引仍可使用，
// 但会标记 Verified=false，并在插件列表上提示来源未经签名保护。
var RegistryPublicKey = ""

// SignatureAlgorithm 当前使用的签名算法标识。
const SignatureAlgorithm = "ed25519"

// HashBytes 计算内容的 SHA-256 摘要，返回 "sha256:hex" 形式。
func HashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// NormalizeChecksum 归一化摘要表示，兼容 "sha256:xxx"、"sha256-xxx" 与裸 hex。
func NormalizeChecksum(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	switch {
	case s == "":
		return ""
	case strings.HasPrefix(s, "sha256:"):
		return "sha256:" + strings.TrimPrefix(s, "sha256:")
	case strings.HasPrefix(s, "sha256-"):
		return "sha256:" + strings.TrimPrefix(s, "sha256-")
	default:
		return "sha256:" + s
	}
}

// VerifyChecksum 校验内容摘要是否与期望一致。
func VerifyChecksum(data []byte, expected string) error {
	want := NormalizeChecksum(expected)
	if want == "" {
		return fmt.Errorf("%w: 缺少期望摘要", ErrChecksumMismatch)
	}
	got := HashBytes(data)
	if !strings.EqualFold(got, want) {
		return fmt.Errorf("%w: 期望 %s，实际 %s", ErrChecksumMismatch, want, got)
	}
	return nil
}

// VerifySignature 校验 Ed25519 签名。
//
// message 为被签名的原始字节（索引文件内容或安装包摘要文本），
// signature 与 publicKey 均为 base64 编码。
func VerifySignature(message []byte, signatureB64, publicKeyB64 string) error {
	if strings.TrimSpace(publicKeyB64) == "" {
		return fmt.Errorf("缺少验签公钥")
	}
	if strings.TrimSpace(signatureB64) == "" {
		return fmt.Errorf("缺少签名")
	}

	pub, err := base64.StdEncoding.DecodeString(strings.TrimSpace(publicKeyB64))
	if err != nil {
		return fmt.Errorf("公钥解码失败: %w", err)
	}
	if len(pub) != ed25519.PublicKeySize {
		return fmt.Errorf("公钥长度非法（期望 %d 字节，实际 %d）", ed25519.PublicKeySize, len(pub))
	}

	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signatureB64))
	if err != nil {
		return fmt.Errorf("签名解码失败: %w", err)
	}
	if len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("签名长度非法（期望 %d 字节，实际 %d）", ed25519.SignatureSize, len(sig))
	}

	if !ed25519.Verify(ed25519.PublicKey(pub), message, sig) {
		return fmt.Errorf("签名校验未通过：内容可能已被篡改")
	}
	return nil
}

// SignatureEnabled 报告是否启用了签名校验。
func SignatureEnabled() bool {
	return strings.TrimSpace(RegistryPublicKey) != ""
}

// NeedTrustPrompt 判断来源是否需要用户显式点击「信任并安装」。
//
// 规则：
//   - 官方审核条目（official）无需提示；
//   - 已被本地信任的插件（同校验和）无需重复提示；
//   - 其余（含官方索引收录但未审核的条目）一律需要用户确认。
func NeedTrustPrompt(official, alreadyTrusted bool) bool {
	return !official && !alreadyTrusted
}
