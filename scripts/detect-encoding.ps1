function Get-FileEncoding {
    param([string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Count -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        return "UTF8-BOM"
    }
    try {
        [System.Text.Encoding]::UTF8.GetString($bytes) | Out-Null
        return "UTF8"
    } catch {
        return "GBK"
    }
}

function Read-FileSafe {
    param([string]$Path)
    $encoding = Get-FileEncoding -Path $Path
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    switch ($encoding) {
        "UTF8-BOM" { return [System.Text.UTF8Encoding]::new($true).GetString($bytes) }
        "UTF8"     { return [System.Text.Encoding]::UTF8.GetString($bytes) }
        "GBK"      { return [System.Text.Encoding]::GetEncoding("GBK").GetString($bytes) }
    }
}
