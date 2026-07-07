#Requires -Version 5.1
<#
.SYNOPSIS
  encoding-guard 一键安装脚本

.DESCRIPTION
  1. 全局安装 iconv-lite 到 OpenCode 依赖目录
  2. 下载插件到全局 OpenCode 插件目录
  3. 在当前项目放置 .encoding-rules 模板

.PARAMETER Force
  覆盖已存在的本地文件。

.EXAMPLE
  irm https://raw.githubusercontent.com/skyispainted/opencode-encoding-guard/main/scripts/install.ps1 | iex
#>
[CmdletBinding()]
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$Repo   = 'skyispainted/opencode-encoding-guard'
$Branch = 'main'
$RawBase = "https://raw.githubusercontent.com/$Repo/$Branch"

# OpenCode 全局配置目录
$OpenCodeDir = Join-Path $env:USERPROFILE '.config\opencode'
$PluginDir   = Join-Path $OpenCodeDir 'plugins'
$NodeModules = Join-Path $OpenCodeDir 'node_modules'

function Write-Step  ($msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Write-Ok    ($msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn  ($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Err   ($msg) { Write-Host "  ✗ $msg" -ForegroundColor Red }

function Get-RemoteFile {
  param([string]$Url)
  try {
    $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -ErrorAction Stop
    return $resp.Content
  } catch {
    Write-Err "下载失败: $Url"
    Write-Err $_.Exception.Message
    return $null
  }
}

function DownloadFile {
  param([string]$RemotePath, [string]$LocalPath, [string]$Name)
  $url = "$RawBase/$RemotePath"
  $dir = Split-Path $LocalPath -Parent

  if ((Test-Path $LocalPath) -and -not $Force) {
    Write-Warn "已存在 $Name，跳过（使用 -Force 覆盖）"
    return $false
  }

  if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }

  $content = Get-RemoteFile -Url $url
  if ($null -eq $content) { return $false }

  [System.IO.File]::WriteAllText($LocalPath, $content, (New-Object System.Text.UTF8Encoding $false))
  Write-Ok "写入 $Name"
  return $true
}

Write-Step "encoding-guard 一键安装"
Write-Host "  OpenCode 目录: $OpenCodeDir"
Write-Host "  项目根目录:   $(Get-Location)"
Write-Host ""

# 1. 全局安装 iconv-lite
Write-Step "安装 iconv-lite（全局）"
if (-not (Test-Path (Join-Path $NodeModules 'iconv-lite'))) {
  if (Test-Path (Join-Path $NodeModules 'package.json')) {
    Push-Location $OpenCodeDir
    & npm install iconv-lite --no-audit --no-fund 2>&1 | Out-Null
    Pop-Location
    if ($LASTEXITCODE -eq 0) {
      Write-Ok "iconv-lite 安装成功"
    } else {
      Write-Warn "npm install 失败，请手动运行: npm i -g iconv-lite"
    }
  } else {
    # 创建 package.json 并安装
    if (-not (Test-Path $OpenCodeDir)) {
      New-Item -ItemType Directory -Path $OpenCodeDir -Force | Out-Null
    }
    '{ "dependencies": { "@opencode-ai/plugin": "1.17.14" } }' | Out-File -FilePath (Join-Path $OpenCodeDir 'package.json') -Encoding utf8
    Push-Location $OpenCodeDir
    & npm install iconv-lite --no-audit --no-fund 2>&1 | Out-Null
    Pop-Location
    if ($LASTEXITCODE -eq 0) {
      Write-Ok "iconv-lite 安装成功"
    } else {
      Write-Warn "npm install 失败，请手动运行: npm i -g iconv-lite"
    }
  }
} else {
  Write-Ok "iconv-lite 已存在"
}
Write-Host ""

# 2. 下载插件到全局插件目录
Write-Step "安装插件（全局）"
$pluginPath = Join-Path $PluginDir 'encoding-guard.ts'
DownloadFile -RemotePath 'plugin/encoding-guard.ts' -LocalPath $pluginPath -Name 'encoding-guard.ts'
Write-Host ""

# 3. 项目规则模板
Write-Step "放置 .encoding-rules 模板"
$rulesPath = Join-Path (Get-Location) '.encoding-rules'
DownloadFile -RemotePath '.encoding-rules' -LocalPath $rulesPath -Name '.encoding-rules（模板）'
Write-Host ""

Write-Step "完成"
Write-Host ""
Write-Host "下一步:" -ForegroundColor White
Write-Host "  1. 编辑 .encoding-rules，配置编码规则，例如:" -ForegroundColor White
Write-Host "       *.cpp gbk" -ForegroundColor Gray
Write-Host "       *.txt gbk" -ForegroundColor Gray
Write-Host "  2. 重启 OpenCode 使插件生效" -ForegroundColor White
Write-Host "  3. 在 OpenCode 中用 read 读取 GBK 文件，应正常显示中文" -ForegroundColor White
Write-Host ""
Write-Host "  重新安装（覆盖）: ./scripts/install.ps1 -Force" -ForegroundColor Gray
Write-Host "  卸载: 删除 ~/.config/opencode/plugins/encoding-guard.ts 与 node_modules/iconv-lite" -ForegroundColor Gray
