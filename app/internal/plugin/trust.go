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
// 这是宿主的**内置信任根**：用户可以在设置里更换索引地址（镜像），
// 但无法通过更换地址改变这个公钥，因此镜像同样要提供能通过验签的索引。
//
// 通过编译期注入（推荐，发布流水线使用）：
//
//	go build -ldflags "-X toolbox/app/internal/plugin.RegistryPublicKey=<base64>"
//
// 为空时表示索引签名校验未启用。此时：
//   - 索引仍然可以使用（本地开发、自建索引）；
//   - **索引里的 official 字段不再被当作可信证明**，相关插件与普通第三方
//     来源一样需要用户显式确认信任。
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
// message 为被签名的原始字节（这里是 registry.json 的原始内容），
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

// SignatureEnabled 报告是否配置了官方索引签名公钥。
func SignatureEnabled() bool {
	return strings.TrimSpace(RegistryPublicKey) != ""
}

// TrustDecision 一次安装请求的信任判定结果。
type TrustDecision struct {
	// Level 最终采用的信任等级
	Level TrustLevel
	// NeedPrompt 是否需要用户显式确认信任
	NeedPrompt bool
	// Reason 判定依据，用于界面展示
	Reason string
}

// DecideTrust 依据来源与索引签名状态判定信任等级。
//
// 规则（与界面提示保持一致）：
//   - 只有「官方索引条目」且「索引签名校验通过」才视为官方可信；
//   - 已经以相同摘要信任过的插件，重复安装无需再次确认；
//   - 其余来源（任意 URL、本地包、本地目录、未验签索引）都属于
//     用户显式选择信任的代码，必须提示来源并要求确认。
func DecideTrust(official bool, indexVerified bool, alreadyTrusted bool) TrustDecision {
	switch {
	case official && indexVerified:
		return TrustDecision{Level: TrustOfficial, NeedPrompt: false, Reason: "官方索引条目，索引签名校验通过"}
	case alreadyTrusted:
		return TrustDecision{Level: TrustUser, NeedPrompt: false, Reason: "该来源已被你信任"}
	case official && !indexVerified:
		return TrustDecision{Level: TrustUser, NeedPrompt: true,
			Reason: "官方索引条目，但当前未启用索引签名校验，无法验证来源真实性"}
	default:
		return TrustDecision{Level: TrustUser, NeedPrompt: true,
			Reason: "来源未经官方验证，安装的是你选择信任的代码"}
	}
}
