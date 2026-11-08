# Run on the Windows computer with the selected company open in licensed Tally.
# Example: .\tally-bridge.ps1 -Company "Sample Traders" -From 2025-04-01 -To 2026-03-31
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$Company,
    [Parameter(Mandatory=$true)][string]$From,
    [Parameter(Mandatory=$true)][string]$To,
    [ValidateRange(1,65535)][int]$Port = 9000,
    [string]$OutputDirectory = (Get-Location).Path
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$invariant = [Globalization.CultureInfo]::InvariantCulture
$startDate = [datetime]::ParseExact($From, 'yyyy-MM-dd', $invariant)
$endDate = [datetime]::ParseExact($To, 'yyyy-MM-dd', $invariant)
if ($endDate -lt $startDate) { throw 'To must be on or after From.' }
$directory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$runId = [Guid]::NewGuid().ToString('N').Substring(0,8)
$stage = Join-Path $directory ('.financer-export-' + $runId)
$destination = Join-Path $directory ("Ledgercraft-Tally-" + $From + "-" + $To + "-" + $runId)
[void][IO.Directory]::CreateDirectory($stage)
$companyXML = [Security.SecurityElement]::Escape($Company)
$encoding = New-Object Text.UTF8Encoding($false)
function Export-TallyFile([string]$Report, [string]$Options, [string]$FileName) {
    $variables = '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>' + $companyXML + '</SVCURRENTCOMPANY>'
    $variables += '<SVFROMDATE TYPE="Date">' + $startDate.ToString('yyyyMMdd') + '</SVFROMDATE>'
    $variables += '<SVTODATE TYPE="Date">' + $endDate.ToString('yyyyMMdd') + '</SVTODATE><EXPLODEFLAG>Yes</EXPLODEFLAG>' + $Options
    $xml = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>' + $Report + '</ID></HEADER><BODY><DESC><STATICVARIABLES>' + $variables + '</STATICVARIABLES></DESC></BODY></ENVELOPE>'
    $req = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/")
    $req.Method = 'POST'
    $req.ContentType = 'text/xml; charset=utf-8'
    $req.AllowAutoRedirect = $false
    $req.Proxy = $null
    $req.Timeout = 300000
    $req.ReadWriteTimeout = 300000
    $bytes = $encoding.GetBytes($xml)
    $req.ContentLength = $bytes.Length
    $outStream = $req.GetRequestStream()
    try { $outStream.Write($bytes, 0, $bytes.Length) } finally { $outStream.Dispose() }
    $response = $req.GetResponse()
    $filePath = Join-Path $stage $FileName
    try {
        if ([int]$response.StatusCode -ne 200) { throw "Tally did not return $Report." }
        $outFile = [IO.File]::Create($filePath)
        try { $response.GetResponseStream().CopyTo($outFile) } finally { $outFile.Dispose() }
    } finally { $response.Dispose() }
    $inputFile = [IO.File]::OpenRead($filePath)
    try {
        # Tally may send UTF-16LE without a BOM. Preserve the actual bytes on disk.
        $header = New-Object byte[] 4
        $n = $inputFile.Read($header,0,4)
        if ($n -lt 4) { throw "Tally returned an empty $Report response." }
        $inputFile.Position = 0
        $codec = $encoding
        if ($header[1] -eq 0 -and $header[3] -eq 0) { $codec = [Text.Encoding]::Unicode }
        if ($header[0] -eq 0 -and $header[2] -eq 0) { $codec = [Text.Encoding]::BigEndianUnicode }
        $reader = New-Object IO.StreamReader($inputFile,$codec,$true)
        try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $inputFile.Dispose() }
    if ($content -notmatch '(?is)<ENVELOPE\b' -or $content -match '(?is)<LINEERROR\b|<STATUS>\s*0\s*</STATUS>|<!DOCTYPE') {
        throw "Tally rejected $Report. Check the open company, dates and Tally HTTP port."
    }
    if ($FileName -eq 'Masters.xml' -and $content -notmatch '(?is)<(?:GROUP|LEDGER)\b') {
        throw 'The masters response has no groups or ledgers. Export All Masters using XML (Data Interchange) in Tally.'
    }
    if ($FileName -eq 'DayBook.xml' -and $content -notmatch '(?is)<VOUCHER\b' -and $content -match '(?is)<(?:DSP|VOUCHERNAME|LINEERROR)') {
        throw 'The Day Book response is a display report. Export All Vouchers using XML (Data Interchange) in Tally.'
    }
    return [ordered]@{file=$FileName;bytes=(Get-Item -LiteralPath $filePath).Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $filePath).Hash.ToLowerInvariant()}
}
try {
    $files = @(Export-TallyFile 'List of Accounts' '<ACCOUNTTYPE>All Masters</ACCOUNTTYPE>' 'Masters.xml')
    $files += Export-TallyFile 'Day Book' '' 'DayBook.xml'
    $files += Export-TallyFile 'Trial Balance' '' 'TrialBalance.xml'
    $receipt = [ordered]@{company=$Company;from=$From;to=$To;exportedUtc=[datetime]::UtcNow.ToString('o');files=$files}
    [IO.File]::WriteAllText((Join-Path $stage 'Export-receipt.json'), ($receipt | ConvertTo-Json -Depth 4), $encoding)
    [IO.Directory]::Move($stage,$destination)
    Write-Output "Export saved in $destination"
    Write-Output 'Select Masters.xml and DayBook.xml in Ledgercraft. Compare the preview with TrialBalance.xml and Tally Statistics.'
} finally {
    if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage,$true) }
}
