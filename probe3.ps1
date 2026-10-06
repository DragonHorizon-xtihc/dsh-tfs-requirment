$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:3101'
$token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY'
$null = Invoke-WebRequest -Uri "$base/?token=$token" -UseBasicParsing -SessionVariable session -TimeoutSec 20

function Post($path, $obj) {
  $json = if ($null -eq $obj) { '{}' } else { $obj | ConvertTo-Json -Depth 12 -Compress }
  try {
    $r = Invoke-WebRequest -Uri "$base$path" -Method POST -Body $json -ContentType 'application/json' -WebSession $session -UseBasicParsing -TimeoutSec 30
    $preview = $r.Content
    if ($preview.Length -gt 300) { $preview = $preview.Substring(0,300) }
    "[{0}] {1} len={2} :: {3}" -f $path,$r.StatusCode,$r.Content.Length,($preview -replace '\s+',' ')
  } catch {
    $code = 0; $body=''
    if ($_.Exception.Response) {
      $code = [int]$_.Exception.Response.StatusCode
      try { $s = $_.Exception.Response.GetResponseStream(); $sr = New-Object IO.StreamReader($s); $body = $sr.ReadToEnd() } catch {}
    }
    "[{0}] ERR {1} {2} :: {3}" -f $path,$code,$_.Exception.Message.Split("`n")[0],$body
  }
}

Write-Output '===== requirements POST (empty filter) ====='
Post '/tfs-requirment/requirements' @{}
Write-Output '===== requirements POST (top=5) ====='
Post '/tfs-requirment/requirements' @{ top = 5; skip = 0 }
Write-Output '===== requirements POST (bad top -> fallback) ====='
Post '/tfs-requirment/requirements' @{ top = 'abc' }
Write-Output '===== confirm-write invalid target (validation) ====='
Post '/tfs-requirment/confirm-write' @{ targetWorkItem = 'notanumber'; collection='WN_HIS'; ops = @() }
Write-Output '===== dispatch missing role (validation) ====='
Post '/tfs-requirment/dispatch' @{ targetWorkItem=''; collection='WN_HIS'; draft = @{ roleName='NoSuchRole' } }
