# Fusionne les arbitres ESPN (noms complets, incomplets) avec football-data.co.uk (complet, noms courts)
# Produit donnees\arbitres-final.json : id de match -> nom d'arbitre
$ErrorActionPreference = 'Stop'
$racine = "C:\Users\NicolasDuyck\Documents\Code\risque-carton-rouge"
$dossier = Join-Path $racine "donnees"

# --- 1. Arbitres ESPN deja collectes ---
$espn = @{}
foreach ($fa in (Get-ChildItem (Join-Path $dossier "arbitres-20*.json"))) {
    $tbl = Get-Content $fa.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $tbl.PSObject.Properties) {
        $nom = ([string]$p.Value).Trim()
        if ($nom) { $espn[$p.Name] = $nom }
    }
}
Write-Output "ESPN : $($espn.Count) matchs avec arbitre."

# --- 2. CSV football-data : cle date|equipeDomicile -> nom court ---
$mapEquipes = @{
    'Arsenal' = 'Arsenal'; 'Aston Villa' = 'Aston Villa'; 'Bournemouth' = 'AFC Bournemouth';
    'Brentford' = 'Brentford'; 'Brighton' = 'Brighton & Hove Albion'; 'Burnley' = 'Burnley';
    'Chelsea' = 'Chelsea'; 'Crystal Palace' = 'Crystal Palace'; 'Everton' = 'Everton';
    'Fulham' = 'Fulham'; 'Ipswich' = 'Ipswich Town'; 'Leeds' = 'Leeds United';
    'Leicester' = 'Leicester City'; 'Liverpool' = 'Liverpool'; 'Luton' = 'Luton Town';
    'Man City' = 'Manchester City'; 'Man United' = 'Manchester United'; 'Newcastle' = 'Newcastle United';
    'Norwich' = 'Norwich City'; "Nott'm Forest" = 'Nottingham Forest'; 'Sheffield United' = 'Sheffield United';
    'Southampton' = 'Southampton'; 'Sunderland' = 'Sunderland'; 'Tottenham' = 'Tottenham Hotspur';
    'Watford' = 'Watford'; 'West Brom' = 'West Bromwich Albion'; 'West Ham' = 'West Ham United';
    'Wolves' = 'Wolverhampton Wanderers'
}
$csvRef = @{}
$equipesInconnues = @{}
foreach ($code in @('2122', '2223', '2324', '2425', '2526')) {
    $texte = (New-Object System.Net.WebClient).DownloadString("https://www.football-data.co.uk/mmz4281/$code/E0.csv")
    $lignes = $texte | ConvertFrom-Csv
    foreach ($l in $lignes) {
        if (-not $l.Referee) { continue }
        if (-not $mapEquipes.ContainsKey($l.HomeTeam)) { $equipesInconnues[$l.HomeTeam] = $true; continue }
        $d = [datetime]::ParseExact($l.Date, 'dd/MM/yyyy', [System.Globalization.CultureInfo]::InvariantCulture)
        $cle = $d.ToString('yyyy-MM-dd') + '|' + $mapEquipes[$l.HomeTeam]
        $csvRef[$cle] = $l.Referee.Trim()
    }
    Write-Output "football-data $code : $($lignes.Count) matchs charges."
}
if ($equipesInconnues.Count -gt 0) { Write-Output "EQUIPES NON RECONNUES : $($equipesInconnues.Keys -join ', ')" }

# --- 3. Table initiale+nom -> nom complet ESPN ---
$complets = $espn.Values | Sort-Object -Unique
$parInitiale = @{}
foreach ($nc in $complets) {
    $mots = $nc -split '\s+'
    if ($mots.Count -lt 2) { continue }
    $cle = ($mots[0].Substring(0, 1) + ' ' + $mots[-1]).ToLower()
    if ($parInitiale.ContainsKey($cle) -and $parInitiale[$cle] -ne $nc) { $parInitiale[$cle] = '?' } # ambigu
    else { $parInitiale[$cle] = $nc }
}

function NomComplet([string]$court) {
    $cle = $court.ToLower()
    if ($parInitiale.ContainsKey($cle) -and $parInitiale[$cle] -ne '?') { return $parInitiale[$cle] }
    return $court
}

# --- 4. Fusion match par match ---
$final = @{}
$viaEspn = 0; $viaCsv = 0; $introuvables = 0
foreach ($f in (Get-ChildItem (Join-Path $dossier "saison-*.json") | Sort-Object Name)) {
    $saison = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($m in $saison) {
        $id = [string]$m.id
        if ($espn.ContainsKey($id)) { $final[$id] = $espn[$id]; $viaEspn++; continue }
        # date UTC -> jour + equipe a domicile (ESPN ecrit "Visiteur at Domicile")
        $jour = ([datetime]$m.date).ToUniversalTime().ToString('yyyy-MM-dd')
        $domicile = ($m.nom -split ' at ')[-1]
        $cle = "$jour|$domicile"
        if ($csvRef.ContainsKey($cle)) { $final[$id] = NomComplet $csvRef[$cle]; $viaCsv++ }
        else { $introuvables++; Write-Output "  Sans arbitre : $($m.nom) ($jour)" }
    }
}

Write-Output ""
Write-Output "=== FUSION ==="
Write-Output "Via ESPN (nom complet) : $viaEspn"
Write-Output "Via football-data      : $viaCsv"
Write-Output "Introuvables           : $introuvables"
$courtsRestants = $final.Values | Where-Object { $_ -match '^[A-Z] ' } | Sort-Object -Unique
if ($courtsRestants) { Write-Output "Noms restes en format court : $($courtsRestants -join ', ')" }
Write-Output "Arbitres distincts : $(($final.Values | Sort-Object -Unique).Count)"

$final | ConvertTo-Json | Out-File -Encoding utf8 (Join-Path $dossier "arbitres-final.json")
Write-Output "arbitres-final.json ecrit."