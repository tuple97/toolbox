package plugin

import (
	"crypto"
	"crypto/md5"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"strings"
)

// 插件可用的签名算法白名单。
//
// 只做「用私钥签一段数据」这一件事：插件自己拿不到随机数、拿不到私钥文件，
// 因此不需要把整块加解密能力开放出去。JRebel 激活服务这类协议需要
// RSA + SHA1/MD5 的 PKCS#1 v1.5 签名，正好落在这个范围内。
var signHashes = map[string]crypto.Hash{
	"RSA-SHA1":   crypto.SHA1,
	"RSA-SHA256": crypto.SHA256,
	"RSA-MD5":    crypto.MD5,
}

// SignWithPrivateKey 用 PEM 私钥对数据签名。
//
// algorithm 取值见 signHashes；encoding 为 "hex" 时返回十六进制，
// 其余按 base64 返回（JRebel 的两代接口分别要这两种编码）。
func SignWithPrivateKey(algorithm, privateKeyPEM, data, encoding string) (string, error) {
	hash, ok := signHashes[strings.ToUpper(strings.TrimSpace(algorithm))]
	if !ok {
		return "", fmt.Errorf("不支持的签名算法: %q", algorithm)
	}

	key, err := parseRSAPrivateKey(privateKeyPEM)
	if err != nil {
		return "", err
	}

	var digest []byte
	switch hash {
	case crypto.SHA1:
		sum := sha1.Sum([]byte(data))
		digest = sum[:]
	case crypto.SHA256:
		sum := sha256.Sum256([]byte(data))
		digest = sum[:]
	case crypto.MD5:
		sum := md5.Sum([]byte(data))
		digest = sum[:]
	default:
		return "", fmt.Errorf("不支持的签名算法: %q", algorithm)
	}

	signature, err := rsa.SignPKCS1v15(rand.Reader, key, hash, digest)
	if err != nil {
		return "", fmt.Errorf("签名失败: %w", err)
	}
	if strings.EqualFold(strings.TrimSpace(encoding), "hex") {
		return hex.EncodeToString(signature), nil
	}
	return base64.StdEncoding.EncodeToString(signature), nil
}

// EncryptWithPublicKey 用公钥加密数据（RSA PKCS#1 v1.5），返回 base64 密文。
//
// key 支持两种写法：PEM 公钥，或 SPKI DER 的 base64（浏览器端 JSEncrypt
// 的 setPublicKey 用的就是后者，PMS 的登录公钥即此格式）。
// 只提供这一种填充方式：插件目前的需求（登录密码加密）与之对应，
// OAEP 的哈希/标签组合过多，出现需求时再按需补。
func EncryptWithPublicKey(key, data string) (string, error) {
	if strings.TrimSpace(data) == "" {
		return "", fmt.Errorf("待加密内容不能为空")
	}
	publicKey, err := parseRSAPublicKey(key)
	if err != nil {
		return "", err
	}
	cipherText, err := rsa.EncryptPKCS1v15(rand.Reader, publicKey, []byte(data))
	if err != nil {
		return "", fmt.Errorf("加密失败: %w", err)
	}
	return base64.StdEncoding.EncodeToString(cipherText), nil
}

// parseRSAPublicKey 解析 PEM 公钥，或 base64 编码的 SPKI / PKCS#1 公钥。
func parseRSAPublicKey(raw string) (*rsa.PublicKey, error) {
	raw = strings.TrimSpace(raw)
	if strings.Contains(raw, "-----BEGIN") {
		block, _ := pem.Decode([]byte(raw))
		if block == nil {
			return nil, fmt.Errorf("公钥不是合法的 PEM 内容")
		}
		raw = base64.StdEncoding.EncodeToString(block.Bytes)
	}

	der, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("公钥不是合法的 base64: %w", err)
	}
	parsed, parseErr := x509.ParsePKIXPublicKey(der)
	if parseErr != nil {
		// PKCS#1 公钥（RSA PUBLIC KEY）是另一种常见写法
		if legacy, legacyErr := x509.ParsePKCS1PublicKey(der); legacyErr == nil {
			return legacy, nil
		}
		return nil, fmt.Errorf("公钥解析失败（需要 SPKI 或 PKCS#1 的 RSA 公钥）: %w", parseErr)
	}
	key, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("公钥不是 RSA 类型")
	}
	return key, nil
}

// parseRSAPrivateKey 解析 PEM 形式的 RSA 私钥（PKCS#1 或 PKCS#8）。
func parseRSAPrivateKey(raw string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(strings.TrimSpace(raw)))
	if block == nil {
		return nil, fmt.Errorf("私钥不是合法的 PEM 内容")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("私钥解析失败（需要 PKCS#1 或 PKCS#8 的 RSA 私钥）: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("私钥不是 RSA 类型")
	}
	return key, nil
}
