# Collecte les buts (minute + equipe) des 3 ligues x 3 saisons, depuis les ids deja connus
$ErrorActionPreference = 'Stop'
$racine = "C:\Users\NicolasDuyck\Documents\Code\risque-carton-rouge\donnees"
$cible = Join-Path $racine "buts"
if (-not (Test-Path $cible)) { New-Item -ItemType Directory -Force $cible | Out-Null }

$sources = @(
    @{ ligue = 'eng.1'; etiquette = 'eng1'; fichiers = @('2023-24', '2024-25', '2025-26' | ForEach-Object { Join-Path $racine "saison-$_.json" }) },
    @{ ligue = 'esp.1'; etiquette = 'esp1'; fichiers = @(Get-ChildItem (Join-Path $racine "esp1\saison-*.json") | ForEach-Object { $_.FullName }) },
    @{ ligue = 'ita.1'; etiquette = 'ita1'; fichiers = @(Get-ChildItem (Join-Path $racine "ita1\saison-*.json") | ForEach-Object { $_.FullName }) }
)

foreach ($src in $sources) {
    foreach ($f in $src.fichiers) {
        $nomSaison = [System.IO.Path]::GetFileNameWithoutExtension($f) -replace '^saison-', ''
        $sortie = Join-Path $cible "buts-$($src.etiquette)-$nomSaison.json"
        if (Test-Path $sortie) { Write-Output "$($src.etiquette) $nomSaison : deja collectee."; continue }
        $saison = Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-Output "$($src.etiquette) $nomSaison : $($saison.Count) matchs..."
        $table = @{}
        $i = 0
        foreach ($m in $saison) {
            $i++
            $buts = @()
            foreach ($essai in 1..4) {
                try {
                    $s = Invoke-RestMethod "https://site.api.espn.com/apis/site/v2/sports/soccer/$($src.ligue)/summary?event=$($m.id)" -TimeoutSec 30
                    if ($s.keyEvents) {
                        $buts = @($s.keyEvents | Where-Object { $_.type.text -match 'Goal|Penalty' } | ForEach-Object {
                            @{ minute = $_.clock.displayValue; type = $_.type.text; equipe = $_.team.displayName }
                        })
                    }
                    break
                } catch {
                    if ($essai -eq 4) { Write-Output "  ECHEC match $($m.id)" }
                    Start-Sleep -Seconds (3 * $essai)
                }
            }
            $table[[string]$m.id] = @{ nom = $m.nom; buts = $buts }
            if ($i % 100 -eq 0) { Write-Output "  $i / $($saison.Count)..." }
            Start-Sleep -Milliseconds 100
        }
        $table | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $sortie
        Write-Output "$($src.etiquette) $nomSaison : sauvegardee."
    }
}
Write-Output "COLLECTE BUTS TERMINEE."