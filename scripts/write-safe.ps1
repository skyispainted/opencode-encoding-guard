function Write-SafeFile {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Content,
        [switch]$SkipBackup
    )
    if (-not $SkipBackup -and (Test-Path -LiteralPath $Path) -and ($Path -match '\.(md|json)$')) {
        $bakPath = "$Path.bak"
        Copy-Item -LiteralPath $Path $bakPath -Force
    }
    $utf8NoBOM = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBOM)
}
