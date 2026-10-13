// Analyse : l'ecart de classement entre les deux equipes influence-t-il le risque de carton rouge ?
// Donnees : football-data.co.uk (resultats + cartons), 3 ligues x 3 saisons.
const fs = require('fs');
const path = require('path');

const DOSSIER = path.join(__dirname, 'donnees', 'classements');
const FICHIERS = [];
for (const ligue of ['E0', 'SP1', 'I1']) {
  for (const code of ['2324', '2425', '2526']) FICHIERS.push({ ligue, code, fichier: `${ligue}-${code}.csv` });
}

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

function dateFr(d) { // dd/mm/yyyy -> tri chronologique
  const [j, m, a] = d.split('/').map(Number);
  return a * 10000 + m * 100 + j;
}

// --- Reconstitution des classements et collecte des observations ---
const MIN_JOUEES = 5;
const observations = []; // {ligue, gap, rouge, jaunes}
for (const { ligue, fichier } of FICHIERS) {
  const matchs = parseCsv(fs.readFileSync(path.join(DOSSIER, fichier), 'utf8'))
    .filter(m => m.HomeTeam && m.FTHG !== '' && m.HR !== '' && m.AR !== '')
    .sort((a, b) => dateFr(a.Date) - dateFr(b.Date));

  const table = {}; // equipe -> {pts, dif, bp, joues}
  const assure = (e) => table[e] || (table[e] = { pts: 0, dif: 0, bp: 0, joues: 0 });

  for (const m of matchs) {
    const h = assure(m.HomeTeam), a = assure(m.AwayTeam);
    if (h.joues >= MIN_JOUEES && a.joues >= MIN_JOUEES) {
      const classement = Object.entries(table)
        .sort(([, x], [, y]) => y.pts - x.pts || y.dif - x.dif || y.bp - x.bp)
        .map(([nom]) => nom);
      const gap = Math.abs(classement.indexOf(m.HomeTeam) - classement.indexOf(m.AwayTeam));
      observations.push({
        ligue,
        gap,
        rouge: (parseInt(m.HR) + parseInt(m.AR)) > 0 ? 1 : 0,
        jaunes: parseInt(m.HY || 0) + parseInt(m.AY || 0)
      });
    }
    // Mise a jour de la table apres le match
    const gh = parseInt(m.FTHG), ga = parseInt(m.FTAG);
    h.joues++; a.joues++; h.bp += gh; a.bp += ga; h.dif += gh - ga; a.dif += ga - gh;
    if (gh > ga) h.pts += 3; else if (gh < ga) a.pts += 3; else { h.pts++; a.pts++; }
  }
}

console.log(`Observations utilisables (les 2 equipes ont joue >= ${MIN_JOUEES} matchs) : ${observations.length}\n`);

// --- 1. Taux de rouge par tranche d'ecart ---
function wilson(k, n) {
  const z = 1.96, p = k / n;
  const centre = (p + z * z / (2 * n)) / (1 + z * z / n);
  const marge = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n);
  return [centre - marge, centre + marge];
}
const TRANCHES = [[1, 3], [4, 7], [8, 12], [13, 19]];
const fmt = (x, d = 1) => (100 * x).toFixed(d);
console.log('Taux de matchs avec carton rouge, par ecart de classement (toutes ligues) :');
for (const [lo, hi] of TRANCHES) {
  const sel = observations.filter(o => o.gap >= lo && o.gap <= hi);
  const k = sel.reduce((s, o) => s + o.rouge, 0);
  const [bas, haut] = wilson(k, sel.length);
  const jaunes = sel.reduce((s, o) => s + o.jaunes, 0) / sel.length;
  console.log(`  ecart ${String(lo).padStart(2)}-${String(hi).padEnd(2)} : ${fmt(k / sel.length)} % de matchs avec rouge  [IC95 : ${fmt(bas)}-${fmt(haut)} %]  (n=${sel.length}, jaunes/match=${jaunes.toFixed(2)})`);
}

// --- 2. Regression logistique rouge ~ gap (Newton-Raphson) ---
function logistique(obs, cle) {
  let b0 = Math.log(0.15 / 0.85), b1 = 0;
  for (let iter = 0; iter < 50; iter++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (const o of obs) {
      const x = o[cle], p = 1 / (1 + Math.exp(-(b0 + b1 * x)));
      const e = o.rouge - p, w = p * (1 - p);
      g0 += e; g1 += e * x;
      h00 += w; h01 += w * x; h11 += w * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    const d0 = (h11 * g0 - h01 * g1) / det, d1 = (h00 * g1 - h01 * g0) / det;
    b0 += d0; b1 += d1;
    if (Math.abs(d0) < 1e-10 && Math.abs(d1) < 1e-10) break;
  }
  // Erreur type de b1 via l'inverse de la hessienne
  let h00 = 0, h01 = 0, h11 = 0;
  for (const o of obs) {
    const x = o[cle], p = 1 / (1 + Math.exp(-(b0 + b1 * x)));
    const w = p * (1 - p);
    h00 += w; h01 += w * x; h11 += w * x * x;
  }
  const varB1 = h00 / (h00 * h11 - h01 * h01);
  const se = Math.sqrt(varB1), z = b1 / se;
  const pval = 2 * (1 - phi(Math.abs(z)));
  return { b0, b1, se, z, pval };
}
function phi(x) { // fonction de repartition normale standard (approx. Abramowitz-Stegun)
  const t = 1 / (1 + 0.2316419 * x);
  const d = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  return 1 - d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
}

console.log('\nRegression logistique  P(rouge) ~ ecart de classement :');
const reg = logistique(observations, 'gap');
console.log(`  pente b1 = ${reg.b1.toFixed(4)}  (erreur type ${reg.se.toFixed(4)}, z = ${reg.z.toFixed(2)}, p = ${reg.pval.toFixed(4)})`);
console.log(`  rapport de cotes par point d'ecart : ${Math.exp(reg.b1).toFixed(4)}`);
const pA = 1 / (1 + Math.exp(-(reg.b0 + reg.b1 * 2)));
const pB = 1 / (1 + Math.exp(-(reg.b0 + reg.b1 * 15)));
console.log(`  P(rouge) predite : ecart 2 -> ${fmt(pA)} %  |  ecart 15 -> ${fmt(pB)} %`);

// --- 3. Par ligue (coherence) ---
console.log('\nPar championnat :');
for (const ligue of ['E0', 'SP1', 'I1']) {
  const obs = observations.filter(o => o.ligue === ligue);
  const r = logistique(obs, 'gap');
  const petits = obs.filter(o => o.gap <= 5), grands = obs.filter(o => o.gap >= 10);
  const tp = petits.reduce((s, o) => s + o.rouge, 0) / petits.length;
  const tg = grands.reduce((s, o) => s + o.rouge, 0) / grands.length;
  console.log(`  ${ligue} : pente ${r.b1.toFixed(4)} (p=${r.pval.toFixed(3)}) | ecart<=5 : ${fmt(tp)} % rouge (n=${petits.length}) | ecart>=10 : ${fmt(tg)} % (n=${grands.length})`);
}

// --- 4. Taux global par reference ---
const kTot = observations.reduce((s, o) => s + o.rouge, 0);
console.log(`\nTaux global (3 ligues, 3 saisons) : ${fmt(kTot / observations.length)} % de matchs avec rouge (${kTot}/${observations.length})`);