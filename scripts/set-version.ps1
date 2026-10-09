<#
.SYNOPSIS
    把版本号同步到各个清单文件。

.DESCRIPTION
    需要保持一致的四处：wails.json（应用信息）、build/windows/info.json（exe 的 VERSIONINFO 资源）、
    根 package.json 与 frontend/package.json。发布流程（.github/workflows/release.yml）用它把 tag
    写进产物，本地构建也可以手动调。

.EXAMPLE
    pwsh scripts/set-version.ps1 -Version v0.2.0
    pwsh scripts/set-version.ps1 -Version 0.2.0
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

# tag 习惯带 v 前缀，清单里统一写 x.y.z
$version = $Version.TrimStart('v')
$parsed = $null
if (-not [version]::TryParse($version, [ref]$parsed)) {
    throw "版本号格式应为 x.y.z（或 vx.y.z），收到：$Version"
}

$root = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding $false

function Update-Manifest {
    param([string]$RelativePath, [string]$Pattern)

    $path = Join-Path $root $RelativePath
    if (-not (Test-Path $path)) {
        throw "找不到文件：$RelativePath"
    }

    $text = [System.IO.File]::ReadAllText($path)
    if (-not [regex]::IsMatch($text, $Pattern)) {
        throw "未在 $RelativePath 中匹配到版本号"
    }

    # 只替换第一处匹配（package.json 里的依赖项也可能带 version 字样）
    $next = [regex]::Replace($text, $Pattern, {
            param($match)
            $match.Groups[1].Value + $version + $match.Groups[2].Value
        }, 1)

    [System.IO.File]::WriteAllText($path, $next, $utf8)
    Write-Host "已更新 $RelativePath -> $version"
}

Update-Manifest 'wails.json' '("version": ")[^"]*(")'
Update-Manifest 'package.json' '("version": ")[^"]*(")'
Update-Manifest 'frontend/package.json' '("version": ")[^"]*(")'
Update-Manifest 'build/windows/info.json' '("file_version": ")[^"]*(")'
Update-Manifest 'build/windows/info.json' '("ProductVersion": ")[^"]*(")'

Write-Host "版本号已同步为 $version"
