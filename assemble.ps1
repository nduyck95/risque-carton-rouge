# Assemble les donnees des 3 championnats (3 dernieres saisons) + la maquette => index.html final
$ErrorActionPreference = 'Stop'
$racine = "C:\Users\NicolasDuyck\Documents\Code\risque-carton-rouge"
$donnees = Join-Path $racine "donnees"
$saisonsRetenues = @('2023-24', '2024-25', '2025-26')
$culture = [System.Globalization.CultureInfo]::InvariantCulture

# Arbitres Premier League : fichier fusionne id -> nom (ESPN + football-data)
$arbitresPL = @{}
$tbl = Get-Content (Join-Path $donnees "arbitres-final.json") -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($p in $tbl.PSObject.Properties) {
    $nom = ([string]$p.Value).Trim()
    if ($nom) { $arbitresPL[$p.Name] = $nom }
}

function ConstruisLigue([string]$nomLigue, [string]$sousDossier, [bool]$arbitreInterne) {
    $dossier = if ($sousDossier) { Join-Path $donnees $sousDossier } else { $donnees }
    $matchs = @()
    foreach ($s in $saisonsRetenues) {
        $fichier = Join-Path $dossier "saison-$s.json"
        $saison = Get-Content $fichier -Raw -Encoding UTF8 | ConvertFrom-Json
        $matchs += @($saison)
    }

    # Index des arbitres de cette ligue
    $noms = @{}
    foreach ($m in $matchs) {
        if ($m.erreur) { continue }
        $a = if ($arbitreInterne) { [string]$m.arbitre } else { $arbitresPL[[string]$m.id] }
        if ($a) { $noms[$a.Trim()] = $true }
    }
    $listeNoms = @($noms.Keys | Sort-Object)
    $indexNom = @{}
    for ($i = 0; $i -lt $listeNoms.Count; $i++) { $indexNom[$listeNoms[$i]] = $i }

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('[')
    $premier = $true
    $stats = @{ matchs = 0; rouges = 0; jaunes = 0; matchsRouge = 0; sansArbitre = 0; erreurs = 0 }
    foreach ($m in $matchs) {
        if ($m.erreur) { $stats.erreurs++; continue }
        $stats.matchs++
        $evts = @()
        $aRouge = $false
        foreach ($c in @($m.cartons)) {
            if ($null -eq $c) { continue }
            if ($c.minute -match "^(\d+)'(?:\+(\d+)')?") {
                $base = [int]$Matches[1]
                $extra = 0
                if ($Matches[2]) { $extra = [int]$Matches[2] }
                $t = $base + $extra / 100.0
                $rouge = 0
                if ($c.type -match 'Red') { $rouge = 1; $aRouge = $true; $stats.rouges++ } else { $stats.jaunes++ }
                $evts += ('[' + $t.ToString($culture) + ',' + $rouge + ']')
            } else {
                Write-Host "  [$nomLigue] Minute non reconnue : '$($c.minute)' (match $($m.id))"
            }
        }
        if ($aRouge) { $stats.matchsRouge++ }
        $a = if ($arbitreInterne) { ([string]$m.arbitre).Trim() } else { $arbitresPL[[string]$m.id] }
        $ia = -1
        if ($a -and $indexNom.ContainsKey($a)) { $ia = $indexNom[$a] } else { $stats.sansArbitre++ }
        if (-not $premier) { [void]$sb.Append(',') }
        $premier = $false
        [void]$sb.Append('[' + $ia + ',[' + ($evts -join ',') + ']]')
    }
    [void]$sb.Append(']')

    $jsNoms = '[' + (($listeNoms | ForEach-Object { '"' + ($_ -replace '\\', '\\\\' -replace '"', '\"') + '"' }) -join ',') + ']'
    Write-Host ("[$nomLigue] $($stats.matchs) matchs | $($stats.jaunes) jaunes | $($stats.rouges) rouges | " +
        "$($stats.matchsRouge) matchs avec rouge ($([math]::Round(100.0 * $stats.matchsRouge / $stats.matchs, 1)) %) | " +
        "$($listeNoms.Count) arbitres | $($stats.sansArbitre) matchs sans arbitre | $($stats.erreurs) erreurs")
    return '{"nom":"' + $nomLigue + '","arbitres":' + $jsNoms + ',"matchs":' + $sb.ToString() + '}'
}

$ligues = @(
    (ConstruisLigue 'Premier League' '' $false),
    (ConstruisLigue 'Liga' 'esp1' $true),
    (ConstruisLigue 'Serie A' 'ita1' $true)
)
$jsLigues = '[' + ($ligues -join ',') + ']'

$coeffs = (Get-Content (Join-Path $donnees "classement-coeffs.json") -Raw -Encoding UTF8 | ConvertFrom-Json) | ForEach-Object {
    '{"b0":' + $_.b0.ToString($culture) + ',"b1":' + $_.b1.ToString($culture) + ',"taux":' + $_.taux.ToString($culture) + ',"pval":' + $_.pval.ToString($culture) + '}'
}
$jsCoeffs = '[' + ($coeffs -join ',') + ']'
Write-Host "Coefficients classement injectes : $jsCoeffs"

$jsEquipes = Get-Content (Join-Path $donnees "equipes.json") -Raw -Encoding UTF8
Write-Host "Donnees equipes injectees ($($jsEquipes.Length) caracteres)."

$jsReglages = Get-Content (Join-Path $donnees "reglages-ligues.json") -Raw -Encoding UTF8
Write-Host "Reglages par ligue injectes : $($jsReglages -replace '\s+', ' ')"

$jsScore = Get-Content (Join-Path $donnees "score-facteurs.json") -Raw -Encoding UTF8
Write-Host "Facteurs score injectes : $($jsScore -replace '\s+', ' ')"

$maquette = Get-Content (Join-Path $racine "modele-page.html") -Raw -Encoding UTF8
$final = $maquette.Replace('__LIGUES__', $jsLigues).Replace('__CLASSEMENT__', $jsCoeffs).Replace('__EQUIPES__', $jsEquipes).Replace('__REGLAGES__', $jsReglages).Replace('__SCORE__', $jsScore)
[System.IO.File]::WriteAllText((Join-Path $racine "index.html"), $final, (New-Object System.Text.UTF8Encoding $false))
Write-Output ""
Write-Output "index.html genere."