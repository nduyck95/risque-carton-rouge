// Calcule, championnat par championnat :
//  - l'agressivite de chaque equipe (jaunes/match sur 2023-26, avec prudence statistique)
//  - le profil moyen des equipes promues (leur premiere saison apres la montee)
//  - les coefficients logistiques P(rouge) ~ agressivite cumulee des 2 equipes
// Produit donnees/equipes.json pour le simulateur.
const fs = require('fs');
const path = require('path');

const DOSSIER = path.join(__dirname, 'donnees', 'classements');
const LIGUES = [
  { code: 'E0', nom: 'Premier League' },
  { code: 'SP1', nom: 'Liga' },
  { code: 'I1', nom: 'Serie A' }
];
const SAISONS = ['2324', '2425', '2526'];

// Noms d'affichage (football-data -> nom courant)
const JOLIS = {
  'Man City': 'Manchester City', 'Man United': 'Manchester United', "Nott'm Forest": 'Nottingham Forest',
  'Wolves': 'Wolverhampton', 'Sheffield United': 'Sheffield United', 'Leeds': 'Leeds United',
  'Leicester': 'Leicester City', 'Ipswich': 'Ipswich Town', 'Luton': 'Luton Town',
  'Alaves': 'Alavés', 'Almeria': 'Almería', 'Ath Bilbao': 'Athletic Bilbao', 'Ath Madrid': 'Atlético Madrid',
  'Betis': 'Real Betis', 'Cadiz': 'Cadix', 'Celta': 'Celta Vigo', 'Espanol': 'Espanyol',
  'Girona': 'Girona', 'Granada': 'Grenade', 'Leganes': 'Leganés', 'Mallorca': 'Majorque',
  'Oviedo': 'Real Oviedo', 'Sevilla': 'Séville', 'Sociedad': 'Real Sociedad', 'Valencia': 'Valence',
  'Vallecano': 'Rayo Vallecano',
  'Bologna': 'Bologne', 'Genoa': 'Genoa', 'Milan': 'AC Milan', 'Napoli': 'Naples',
  'Parma': 'Parme', 'Pisa': 'Pise', 'Roma': 'AS Roma', 'Venezia': 'Venise', 'Verona': 'Hellas Vérone'
};

function parseCsv(texte) {
  const lignes = texte.split(/\r?\n/).filter(l => l.trim());
  const entetes = lignes[0].split(',');
  return lignes.slice(1).map(l => {
    const vals = l.split(',');
    const o = {};
    entetes.forEach((h, i) => o[h.trim()] = (vals[i] || '').trim());
    return o;
  });
}
function dateFr(d) { const [j, m, a] = d.split('/').map(Number); return a * 10000 + m * 100 + j; }
function lit(code, saison) {
  return parseCsv(fs.readFileSync(path.join(DOSSIER, `${code}-${saison}.csv`), 'utf8'))
    .filter(m => m.HomeTeam && m.FTHG !== '' && m.HY !== '' && m.AY !== '');
}
function equipesDe(matchs) {
  const s = new Set();
  for (const m of matchs) { s.add(m.HomeTeam); s.add(m.AwayTeam); }
  return s;
}

// Regression logistique a 1 variable (Newton-Raphson) + p-value de Wald
function logistique(obs) {
  let b0 = -1.7, b1 = 0;
  for (let iter = 0; iter < 60; iter++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (const o of obs) {
      const p = 1 / (1 + Math.exp(-(b0 + b1 * o.x)));
      const e = o.y - p, w = p * (1 - p);
      g0 += e; g1 += e * o.x; h00 += w; h01 += w * o.x; h11 += w * o.x * o.x;
    }
    const det = h00 * h11 - h01 * h01;
    const d0 = (h11 * g0 - h01 * g1) / det, d1 = (h00 * g1 - h01 * g0) / det;
    b0 += d0; b1 += d1;
    if (Math.abs(d0) < 1e-10 && Math.abs(d1) < 1e-10) break;
  }
  let h00 = 0, h01 = 0, h11 = 0;
  for (const o of obs) {
    const p = 1 / (1 + Math.exp(-(b0 + b1 * o.x)));
    const w = p * (1 - p);
    h00 += w; h01 += w * o.x; h11 += w * o.x * o.x;
  }
  const se = Math.sqrt(h00 / (h00 * h11 - h01 * h01));
  const z = b1 / se;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  const pval = 2 * (d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))));
  return { b0, b1, pval };
}

const resultat = [];
for (const { code, nom } of LIGUES) {
  const parSaison = {};
  for (const s of ['2223', ...SAISONS]) parSaison[s] = lit(code, s);

  // --- Agressivite par equipe sur 2023-26 ---
  const equipes = {}; // nom -> {matchs, jaunes}
  let totalMatchs = 0, totalJaunes = 0, matchsRouge = 0;
  for (const s of SAISONS) {
    for (const m of parSaison[s]) {
      const hy = parseInt(m.HY), ay = parseInt(m.AY);
      (equipes[m.HomeTeam] = equipes[m.HomeTeam] || { matchs: 0, jaunes: 0 });
      (equipes[m.AwayTeam] = equipes[m.AwayTeam] || { matchs: 0, jaunes: 0 });
      equipes[m.HomeTeam].matchs++; equipes[m.HomeTeam].jaunes += hy;
      equipes[m.AwayTeam].matchs++; equipes[m.AwayTeam].jaunes += ay;
      totalMatchs++; totalJaunes += hy + ay;
      if (parseInt(m.HR) + parseInt(m.AR) > 0) matchsRouge++;
    }
  }
  const moyEquipe = totalJaunes / (2 * totalMatchs); // jaunes/match d'une equipe moyenne
  const PRUDENCE = 10;
  const listeEquipes = Object.entries(equipes).map(([n, e]) => ({
    nom: JOLIS[n] || n,
    agg: +((e.jaunes + PRUDENCE * moyEquipe) / (e.matchs + PRUDENCE)).toFixed(4),
    brut: +(e.jaunes / e.matchs).toFixed(4),
    matchs: e.matchs
  })).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

  // --- Profil des equipes promues (premiere saison apres la montee) ---
  let jaunesPromus = 0, matchsPromus = 0;
  const nomsPromus = [];
  const paires = [['2223', '2324'], ['2324', '2425'], ['2425', '2526']];
  for (const [avant, apres] of paires) {
    const anciennes = equipesDe(parSaison[avant]);
    const promues = [...equipesDe(parSaison[apres])].filter(e => !anciennes.has(e));
    for (const p of promues) {
      nomsPromus.push(`${JOLIS[p] || p} (${apres.slice(0, 2)}-${apres.slice(2)})`);
      for (const m of parSaison[apres]) {
        if (m.HomeTeam === p) { matchsPromus++; jaunesPromus += parseInt(m.HY); }
        if (m.AwayTeam === p) { matchsPromus++; jaunesPromus += parseInt(m.AY); }
      }
    }
  }
  const aggPromu = +(jaunesPromus / matchsPromus).toFixed(4);

  // --- Coefficients logistiques P(rouge) ~ somme des agressivites courantes des 2 equipes ---
  // (moyennes glissantes intra-saison, comme dans l'analyse exploratoire : honnete car "avant le match")
  const obs = [];
  for (const s of SAISONS) {
    const matchs = [...parSaison[s]].sort((a, b) => dateFr(a.Date) - dateFr(b.Date));
    const encours = {};
    const assure = (e) => encours[e] || (encours[e] = { matchs: 0, jaunes: 0 });
    for (const m of matchs) {
      const h = assure(m.HomeTeam), a = assure(m.AwayTeam);
      if (h.matchs >= 5 && a.matchs >= 5) {
        obs.push({ x: h.jaunes / h.matchs + a.jaunes / a.matchs, y: (parseInt(m.HR) + parseInt(m.AR)) > 0 ? 1 : 0 });
      }
      h.matchs++; h.jaunes += parseInt(m.HY);
      a.matchs++; a.jaunes += parseInt(m.AY);
    }
  }
  const reg = logistique(obs);
  const taux = obs.reduce((s, o) => s + o.y, 0) / obs.length;

  resultat.push({
    nom,
    coeffs: { c0: +reg.b0.toFixed(5), c1: +reg.b1.toFixed(5), taux: +taux.toFixed(5), pval: +reg.pval.toFixed(4) },
    moyEquipe: +moyEquipe.toFixed(4),
    promu: { agg: aggPromu, matchs: matchsPromus },
    equipes: listeEquipes
  });

  console.log(`\n=== ${nom} ===`);
  console.log(`Logistique P(rouge) ~ agressivite : pente ${reg.b1.toFixed(4)} (p=${reg.pval.toFixed(4)}), taux ${taux.toFixed(4)}, n=${obs.length}`);
  console.log(`Jaunes/match d'une equipe moyenne : ${moyEquipe.toFixed(2)}`);
  console.log(`Promus : ${nomsPromus.join(', ')}`);
  console.log(`Profil promu : ${aggPromu.toFixed(2)} jaunes/match (${matchsPromus} matchs) soit ${(100 * (aggPromu / moyEquipe - 1)).toFixed(1)} % vs moyenne`);
  const triees = [...listeEquipes].sort((a, b) => b.agg - a.agg);
  console.log(`Top 3 agressives : ${triees.slice(0, 3).map(e => `${e.nom} (${e.agg.toFixed(2)})`).join(', ')}`);
  console.log(`Top 3 calmes     : ${triees.slice(-3).map(e => `${e.nom} (${e.agg.toFixed(2)})`).join(', ')}`);
}

fs.writeFileSync(path.join(__dirname, 'donnees', 'equipes.json'), JSON.stringify(resultat, null, 1));
console.log('\ndonnees/equipes.json ecrit.');