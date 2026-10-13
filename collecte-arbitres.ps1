# Recupere le nom de l'arbitre pour chaque match deja collecte
$ErrorActionPreference = 'Stop'
$dossier = "C:\Users\NicolasDuyck\Documents\Code\risque-carton-rouge\donnees"

foreach ($f in (Get-ChildItem (Join-Path $dossier "saison-*.json") | Sort-Object Name)) {
    $nomSaison = $f.BaseName -replace '^saison-', ''
    $cible = Join-Path $dossier "arbitres-$nomSaison.json"
    if (Test-Path $cible) {
        Write-Output "Arbitres $nomSaison : deja collectes, on passe."
        continue
    }
    $saison = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Output "Arbitres $nomSaison : $($saison.Count) matchs..."
    $table = @{}
    $i = 0
    foreach ($m in $saison) {
        $i++
        $nom = ''
        foreach ($essai in 1..4) {
            try {
                $s = Invoke-RestMethod "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=$($m.id)" -TimeoutSec 30
                if ($s.gameInfo -and $s.gameInfo.officials -and @($s.gameInfo.officials).Count -gt 0) {
                    $nom = @($s.gameInfo.officials)[0].fullName
                }
                break
            } catch {
                if ($essai -eq 4) { Write-Output "  ECHEC match $($m.id)" }
                Start-Sleep -Seconds (3 * $essai)
            }
        }
        $table[[string]$m.id] = $nom
        if ($i % 50 -eq 0) { Write-Output "  $i / $($saison.Count)..." }
        Start-Sleep -Milliseconds 120
    }
    $table | ConvertTo-Json | Out-File -Encoding utf8 $cible
    Write-Output "Arbitres $nomSaison : sauvegardes."
}
Write-Output "COLLECTE ARBITRES TERMINEE."