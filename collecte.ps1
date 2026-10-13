# Collecte des cartons (minute + type) pour les 5 dernieres saisons de Premier League
# Source : API publique ESPN
$ErrorActionPreference = 'Stop'
$dossier = "C:\Users\NicolasDuyck\Documents\Code\risque-carton-rouge\donnees"
if (-not (Test-Path $dossier)) { New-Item -ItemType Directory -Force $dossier | Out-Null }

$saisons = @(
    @{ nom = '2021-22'; plage = '20210801-20220601' },
    @{ nom = '2022-23'; plage = '20220801-20230615' },
    @{ nom = '2023-24'; plage = '20230801-20240601' },
    @{ nom = '2024-25'; plage = '20240801-20250601' },
    @{ nom = '2025-26'; plage = '20250801-20260601' }
)

foreach ($saison in $saisons) {
    $fichier = Join-Path $dossier "saison-$($saison.nom).json"
    if (Test-Path $fichier) {
        Write-Output "Saison $($saison.nom) : deja collectee, on passe."
        continue
    }

    Write-Output "Saison $($saison.nom) : recuperation de la liste des matchs..."
    $score = Invoke-RestMethod "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=$($saison.plage)&limit=1000"
    $matchs = @($score.events)
    Write-Output "Saison $($saison.nom) : $($matchs.Count) matchs trouves."

    $resultats = New-Object System.Collections.ArrayList
    $i = 0
    foreach ($m in $matchs) {
        $i++
        $cartons = @()
        $ok = $false
        foreach ($essai in 1..4) {
            try {
                $s = Invoke-RestMethod "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=$($m.id)" -TimeoutSec 30
                if ($s.keyEvents) {
                    $cartons = @($s.keyEvents | Where-Object { $_.type.text -match 'Card' } | ForEach-Object {
                        @{ minute = $_.clock.displayValue; type = $_.type.text }
                    })
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
            cartons = $cartons
            erreur  = (-not $ok)
        })
        if ($i % 50 -eq 0) { Write-Output "  $i / $($matchs.Count) matchs traites..." }
        Start-Sleep -Milliseconds 120
    }

    $resultats | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $fichier
    Write-Output "Saison $($saison.nom) : terminee et sauvegardee."
}
Write-Output "COLLECTE TERMINEE."