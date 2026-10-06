$ErrorActionPreference = 'Continue'
$data = 'D:\ClaudeCode\deepseek-harness\plugins\dsh-tfs-requirment\.tfs-requirment-data'
$cfg = Get-Content "$data\profiles.json" -Raw | ConvertFrom-Json
$base = $cfg.url.TrimEnd('/')
$coll = $cfg.collection
$pat = $cfg.pat
$pair = "{0}:{1}" -f ':', $pat
$token = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$auth = @{ Authorization = "Basic $token" }
$full = "$base/$coll"

Write-Output "base=$base collection=$coll"

Write-Output '===== 1) connectiondata (GET, lightweight) ====='
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  $r = Invoke-WebRequest -Uri "$base/_apis/connectiondata" -Headers $auth -UseBasicParsing -TimeoutSec 30
  $sw.Stop()
  Write-Output ("connectiondata {0} in {1}ms len={2}" -f $r.StatusCode,$sw.ElapsedMilliseconds,$r.Content.Length)
} catch { $sw.Stop(); Write-Output ("connectiondata FAIL in {0}ms: {1}" -f $sw.ElapsedMilliseconds,$_.Exception.Message) }

Write-Output '===== 2) simple WIQL (POST, top 1) ====='
$wiql = @{ query = "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '@project' ORDER BY [System.ChangedDate] DESC" } | ConvertTo-Json -Compress
$wiql = @{ query = "SELECT [System.Id] FROM WorkItems ORDER BY [System.ChangedDate] DESC" } | ConvertTo-Json -Compress
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  $r = Invoke-WebRequest -Uri "$full/_apis/wit/wiql?api-version=2.0" -Method POST -Body $wiql -ContentType 'application/json' -Headers $auth -UseBasicParsing -TimeoutSec 60
  $sw.Stop()
  Write-Output ("WIQL {0} in {1}ms len={2}" -f $r.StatusCode,$sw.ElapsedMilliseconds,$r.Content.Length)
  Write-Output ($r.Content.Substring(0,[Math]::Min(300,$r.Content.Length)))
} catch { $sw.Stop(); Write-Output ("WIQL FAIL in {0}ms: {1}" -f $sw.ElapsedMilliseconds,$_.Exception.Message) }
