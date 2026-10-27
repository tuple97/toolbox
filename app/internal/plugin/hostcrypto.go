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
