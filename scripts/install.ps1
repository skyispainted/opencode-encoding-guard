#Requires -Version 5.1
<#
.SYNOPSIS
  encoding-guard 一键安装脚本

.DESCRIPTION
  从 GitHub 仓库下载 encoding-guard 插件、规则文件模板，并放置到当前项目的
  .opencode/plugins/ 目录与项目根目录。

.PARAMETER Force
  覆盖已存在的本地文件。

.EXAMPLE
  # 在项目根目录执行
  irm https://raw.githubusercontent.com/skyispainted/opencode-encoding-guard/main/scripts/install.ps1 | iex

.EXAMPLE
  # 本地执行，覆盖已有文件
  ./scripts/install.ps1 -Force
#>
[CmdletBinding()]
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$Repo   = 'skyispainted/opencode-encoding-guard'
$Branch = 'main'
$RawBase = "https://raw.githubusercontent.com/$Repo/$Branch"

# 需要拉取的文件: (远程相对路径, 本地相对路径, 是否为规则模板)
$Files = @(
  @{ Remote = 'plugin/encoding-guard.ts'; Local = '.opencode/plugins/encoding-guard.ts'; Template = $false }
  @{ Remote = '.encoding-rules';          Local = '.encoding-rules';                       Template = $true  }
)

function Write-Step  ($msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Write-Ok    ($msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn2 ($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
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

Write-Step "encoding-guard 一键安装"
Write-Host "  项目根目录: $(Get-Location)"
Write-Host ""

foreach ($f in $Files) {
  $url      = "$RawBase/$($f.Remote)"
  $localRel = $f.Local
  $localAbs = Join-Path (Get-Location) $localRel
  $dir      = Split-Path $localAbs -Parent

  Write-Step "处理 $($f.Remote)"

  # 已存在则跳过（除非 -Force）
  if ((Test-Path $localAbs) -and -not $Force) {
    if ($f.Template) {
      Write-Warn2 "已存在 $localRel，跳过（规则文件需手动维护，避免覆盖你的配置）"
    } else {
      Write-Warn2 "已存在 $localRel，跳过（使用 -Force 覆盖）"
    }
    Write-Host ""
    continue
  }

  # 创建目录
  if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Write-Ok "创建目录 $dir"
  }

  # 下载
  $content = Get-RemoteFile -Url $url
  if ($null -eq $content) {
    Write-Host ""
    continue
  }

  # 写入（UTF-8 无 BOM，保持文件原始内容）
  [System.IO.File]::WriteAllText($localAbs, $content, (New-Object System.Text.UTF8Encoding $false))
  Write-Ok "写入 $localRel"
  Write-Host ""
}

Write-Step "完成"
Write-Host ""
Write-Host "下一步:" -ForegroundColor White
Write-Host "  1. 编辑 .encoding-rules，按 glob 模式配置编码，例如:" -ForegroundColor White
Write-Host "       *.txt gbk" -ForegroundColor Gray
Write-Host "       src/**/*.cs gbk" -ForegroundColor Gray
Write-Host "  2. 重启 OpenCode 使插件生效" -ForegroundColor White
Write-Host "  3. 在 OpenCode 中用 read 读取 GBK 文件，应正常显示中文" -ForegroundColor White
Write-Host ""
Write-Host "  重新安装（覆盖）: ./scripts/install.ps1 -Force" -ForegroundColor Gray
Write-Host "  卸载: 删除 .opencode/plugins/encoding-guard.ts 与 .encoding-rules" -ForegroundColor Gray
