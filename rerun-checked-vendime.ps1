$names = @("Berat","Bulqizë","Fier","Kamëz","Kavajë","Korçë","Kukës","Lezhë","Sarandë","Skrapar","Tiranë")

$base = "http://localhost:5050"
$limit = 50
$year  = 2026

function Invoke-ScrapeWithCooldown([string]$name) {
  $u = "$base/api/scrape/run?municipality=$([uri]::EscapeDataString($name))&category=Vendime&year=$year&limit=$limit"

  $maxAttempts = 8
  for ($attempt=1; $attempt -le $maxAttempts; $attempt++) {
    try {
      return (irm -Method POST $u -TimeoutSec 180 -ErrorAction Stop)
    } catch {
      $body = $null
      try { $body = $_.ErrorDetails.Message | ConvertFrom-Json } catch {}

      if ($body -and $body.error -eq "cooldown" -and $body.cooldown_until_utc) {
        $until = [DateTime]::Parse($body.cooldown_until_utc).ToUniversalTime()
        $now   = (Get-Date).ToUniversalTime()
        $wait  = [Math]::Max(5, [int]([TimeSpan]($until - $now)).TotalSeconds + 2)
        Write-Host "Cooldown for $name until $($body.cooldown_until_utc) -> waiting ${wait}s (attempt $attempt/$maxAttempts)" -ForegroundColor Yellow
        Start-Sleep -Seconds $wait
        continue
      }

      Write-Host "FAILED for $name (attempt $attempt/$maxAttempts): $($_.Exception.Message)" -ForegroundColor Red
      if ($body) { $body | Format-List * }
      return $null
    }
  }
  return $null
}

foreach ($n in $names) {
  Write-Host "`n====================`n== $n ==" -ForegroundColor Cyan
  $r = Invoke-ScrapeWithCooldown $n
  if ($r) { $r | Format-List * }
}
