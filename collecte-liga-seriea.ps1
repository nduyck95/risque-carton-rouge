# Collecte cartons + arbitre pour la Liga (esp.1) et la Serie A (ita.1), 3 dernieres saisons
$ErrorActionPreference = 'Stop'
$racine = "C:\Users\NicolasDuyck\Documents\Code\risque-carton-rouge\donnees"

$ligues = @(
    @{ code = 'esp.1'; dossier = 'esp1' },
    @{ code = 'ita.1'; dossier = 'ita1' }
)
$saisons = @(
    @{ nom = '2023-24'; plage = '20230801-20240630' },
    @{ nom = '2024-25'; plage = '20240801-20250630' },
    @{ nom = '2025-26'; plage = '20250801-20260630' }
)

foreach ($ligue in $ligues) {
    $dossier = Join-Path $racine $ligue.dossier
    if (-not (Test-Path $dossier)) { New-Item -ItemType Directory -Force $dossier | Out-Null }
    foreach ($saison in $saisons) {
        $fichier = Join-Path $dossier "saison-$($saison.nom).json"
        if (Test-Path $fichier) {
            Write-Output "$($ligue.code) $($saison.nom) : deja collectee, on passe."
            continue
        }
        Write-Output "$($ligue.code) $($saison.nom) : liste des matchs..."
        $score = Invoke-RestMethod "https://site.api.espn.com/apis/site/v2/sports/soccer/$($ligue.code)/scoreboard?dates=$($saison.plage)&limit=1000"
        $matchs = @($score.events)
        Write-Output "$($ligue.code) $($saison.nom) : $($matchs.Count) matchs trouves."

        $resultats = New-Object System.Collections.ArrayList
        $i = 0
        foreach ($m in $matchs) {
            $i++
            $cartons = @()
            $arbitre = ''
            $ok = $false
            foreach ($essai in 1..4) {
                try {
                    $s = Invoke-RestMethod "https://site.api.espn.com/apis/site/v2/sports/soccer/$($ligue.code)/summary?event=$($m.id)" -TimeoutSec 30
                    if ($s.keyEvents) {
                        $cartons = @($s.keyEvents | Where-Object { $_.type.text -match 'Card' } | ForEach-Object {
                            @{ minute = $_.clock.displayValue; type = $_.type.text }
                        })
                    }
                    if ($s.gameInfo -and $s.gameInfo.officials -and @($s.gameInfo.officials).Count -gt 0) {
                        $arbitre = ([string]@($s.gameInfo.officials)[0].fullName).Trim()
                    }
                    $ok = $true
                    break
                } catch {
                    Start-Sleep -Seconds (3 * $essai)
                }
            }
            if (-not $ok) { Write-Output "  ECHEC match $($m.id) ($($m.name))" }
            [void]$resultats.Add(@{
                id      = $m.id
                nom     = $m.name
                date    = $m.date
                arbitre = $arbitre
                cartons = $cartons
                erreur  = (-not $ok)
            })
            if ($i % 50 -eq 0) { Write-Output "  $i / $($matchs.Count)..." }
            Start-Sleep -Milliseconds 120
        }
        $resultats | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $fichier
        Write-Output "$($ligue.code) $($saison.nom) : sauvegardee."
    }
}
Write-Output "COLLECTE LIGA + SERIE A TERMINEE."