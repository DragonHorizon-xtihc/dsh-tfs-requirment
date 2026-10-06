$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:3101'
$token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY'

# Establish session: hit /?token= (303 + Set-Cookie), WebRequest follows redirect and stores cookie
$null = Invoke-WebRequest -Uri "$base/?token=$token" -UseBasicParsing -SessionVariable session -TimeoutSec 20
Write-Output 'session established'

function Probe($path) {
  try {
    $r = Invoke-WebRequest -Uri "$base$path" -WebSession $session -UseBasicParsing -TimeoutSec 25
    $preview = $r.Content
    if ($preview.Length -gt 120) { $preview = $preview.Substring(0,120) }
    "{0,-42} {1} len={2} :: {3}" -f $path,$r.StatusCode,$r.Content.Length,($preview -replace '\s+',' ')
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    "{0,-42} ERR {1} {2}" -f $path,$code,$_.Exception.Message.Split("`n")[0]
  }
}

$gets = @(
  '/tfs-requirment/panel-data',
  '/tfs-requirment/board',
  '/tfs-requirment/roles',
  '/tfs-requirment/health',
  '/tfs-requirment/audit',
  '/tfs-requirment/profiles',
  '/tfs-requirment/requirements',
  '/tfs-requirment/tfs-tools',
  '/tfs-requirment/query-options',
  '/tfs-requirment/query-options-load',
  '/tfs-requirment/ui-state',
  '/tfs-requirment/mcp-instance'
)
Write-Output '===== GET endpoints with session cookie ====='
foreach ($g in $gets) { Probe $g }
