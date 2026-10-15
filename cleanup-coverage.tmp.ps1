$ErrorActionPreference = 'Stop'

# 1) theme-soc-dark.css: remove proposal-coverage blocks/selector lines by content match
$themePath = 'c:\Users\22722\Desktop\投好标\OpenBidKit-Yibiao-Web-main\client\src\styles\theme-soc-dark.css'
$src = [IO.File]::ReadAllLines($themePath)
$del = New-Object 'System.Collections.Generic.HashSet[int]'
$i = 0
while ($i -lt $src.Count) {
    $line = $src[$i]
    if ($line -match "html\[data-theme='soc-dark'\] :where\(\s*$") {
        $j = $i + 1
        $allCov = $true
        $selectorCount = 0
        while ($j -lt $src.Count -and $src[$j].Trim() -ne ') {') {
            if ($src[$j] -notmatch 'coverage') { $allCov = $false }
            $selectorCount++
            $j++
        }
        if ($allCov -and $selectorCount -gt 0) {
            $k = $j
            while ($k -lt $src.Count -and $src[$k].Trim() -ne '}') { $k++ }
            $start = $i
            if ($i -gt 0 -and $src[$i - 1].Trim() -eq '') { $start = $i - 1 }
            for ($n = $start; $n -le $k; $n++) { [void]$del.Add($n) }
            $i = $k + 1
            continue
        }
    }
    if ($line -match '\.outline-tree-coverage-badge\.is-partial \{\s*$') {
        $k = $i
        while ($k -lt $src.Count -and $src[$k].Trim() -ne '}') { $k++ }
        $start = $i
        if ($i -gt 0 -and $src[$i - 1].Trim() -eq '') { $start = $i - 1 }
        for ($n = $start; $n -le $k; $n++) { [void]$del.Add($n) }
        $i = $k + 1
        continue
    }
    $i++
}
$singlePatterns = @(
    '\.outline-coverage-table-wrap,\s*$',
    '\.outline-coverage-summary-card,\s*$',
    '\.outline-coverage-dialog,\s*$',
    '\.outline-coverage-source-card,\s*$',
    '\.outline-detail-coverage-card,\s*$',
    '\.outline-detail-coverage-row,\s*$',
    '\.outline-coverage-table th,\s*$',
    "html\[data-theme='soc-dark'\] \.outline-coverage-status-pill\.is-partial,\s*$",
    "html\[data-theme='soc-dark'\] \.outline-detail-coverage-row\.is-partial span \{\s*$"
)
$out = New-Object 'System.Collections.Generic.List[string]'
$singleDropped = 0
for ($n = 0; $n -lt $src.Count; $n++) {
    if ($del.Contains($n)) { continue }
    $line = $src[$n]
    $drop = $false
    foreach ($p in $singlePatterns) {
        if ($line -match $p) { $drop = $true; break }
    }
    if ($drop) { $singleDropped++; continue }
    $out.Add($line)
}
[IO.File]::WriteAllLines($themePath, $out, (New-Object System.Text.UTF8Encoding($false)))
"theme css: $($src.Count) -> $($out.Count) lines, single lines dropped: $singleDropped"

# 2) docs: remove coverage-matrix section (lines 36-45, verified boundaries)
$docPath = 'c:\Users\22722\Desktop\投好标\OpenBidKit-Yibiao-Web-main\client\public\docs\使用\01-生成技术方案.md'
$docLines = [IO.File]::ReadAllLines($docPath)
if ($docLines[35] -match '目录生成时' -and $docLines[44] -match '导出明细或关闭') {
    $keep = @()
    if ($docLines.Count -gt 46) { $keep = $docLines[0..34] + $docLines[45..($docLines.Count - 1)] } else { $keep = $docLines[0..34] }
    [IO.File]::WriteAllLines($docPath, $keep, (New-Object System.Text.UTF8Encoding($false)))
    "docs: $($docLines.Count) -> $($keep.Count) lines"
} else {
    "docs boundary mismatch, skipped"
}

# 3) remove unused doc image
$imgPath = 'c:\Users\22722\Desktop\投好标\OpenBidKit-Yibiao-Web-main\client\public\docs\images\标注\17-响应方案覆盖矩阵.png'
if (Test-Path -LiteralPath $imgPath) { Remove-Item -LiteralPath $imgPath; 'image removed' } else { 'image not found' }
