$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:3101'
$token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY'

Write-Output '===== ROOT HTML (token query), capture headers + cookies ====='
$req = [System.Net.HttpWebRequest]::Create("$base/?token=$token")
$req.Method = 'GET'
$req.AllowAutoRedirect = $false
try {
  $resp = $req.GetResponse()
  Write-Output ("ROOT status={0}" -f [int]$resp.StatusCode)
  Write-Output '--- response headers ---'
  $resp.Headers | ForEach-Object { Write-Output ("{0}: {1}" -f $_, $resp.Headers[$_]) }
  $resp.Close()
} catch {
  $r = $_.Exception.Response
  Write-Output ("ROOT ERR status={0}" -f [int]$r.StatusCode)
  $r.Headers | ForEach-Object { Write-Output ("{0}: {1}" -f $_, $r.Headers[$_]) }
}
