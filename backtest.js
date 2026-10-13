// BACKTEST du modele "carton rouge" :
//   entrainement sur 2023-24 + 2024-25, prediction a l'aveugle de 2025-26 (minute 0, 0 carton),
//   comparaison avec un bookmaker de reference qui ne connait que le taux moyen du championnat.
// Verdicts : score de Brier, log-loss, calibration, simulation de paris contre le bookmaker.
const fs = require('fs');
const path = require('path');

const DOSSIER = path.join(__dirname, 'donnees', 'classements');
const LIGUES = [
  { code: 'E0', nom: 'Premier League', dossierEspn: null },
  { code: 'SP1', nom: 'Liga', dossierEspn: 'esp1' },
  { code: 'I1', nom: 'Serie A', dossierEspn: 'ita1' }
];
const TRAIN = ['2324', '2425'];
const TEST = '2526';

// CSV football-data -> nom ESPN (pour retrouver l'arbitre des matchs espagnols/italiens)
const VERS_ESPN = {
  'Alaves': 'Alavés', 'Almeria': 'Almería', 'Ath Bilbao': 'Athletic Club', 'Ath Madrid': 'Atlético Madrid',
  'Betis': 'Real Betis', 'Cadiz': 'Cádiz', 'Celta': 'Celta Vigo', 'Espanol': 'Espanyol',
  'Leganes': 'Leganés', 'Oviedo': 'Real Oviedo', 'Sociedad': 'Real Sociedad', 'Valladolid': 'Real Valladolid',
  'Vallecano': 'Rayo Vallecano',
  'Milan': 'AC Milan', 'Roma': 'AS Roma', 'Verona': 'Hellas Verona', 'Inter': 'Internazionale'
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
function dateIso(d) { const [j, m, a] = d.split('/'); return `${a}-${m.padStart(2, '0')}-${j.padStart(2, '0')}`; }
function lit(code, saison) {
  return parseCsv(fs.readFileSync(path.join(DOSSIER, `${code}-${saison}.csv`), 'utf8'))
    .filter(m => m.HomeTeam && m.FTHG !== '' && m.HY !== '' && m.HR !== '')
    .sort((a, b) => dateIso(a.Date).localeCompare(dateIso(b.Date)));
}
function equipesDe(matchs) { const s = new Set(); for (const m of matchs) { s.add(m.HomeTeam); s.add(m.AwayTeam); } return s; }
const aRouge = (m) => (parseInt(m.HR) + parseInt(m.AR)) > 0 ? 1 : 0;

// Arbitres ESPN : cle "date|equipeDomicileESPN" -> arbitre (Liga et Serie A)
const arbitresEspn = {};
for (const { dossierEspn } of LIGUES) {
  if (!dossierEspn) continue;
  for (const f of fs.readdirSync(path.join(__dirname, 'donnees', dossierEspn))) {
    const saison = JSON.parse(fs.readFileSync(path.join(__dirname, 'donnees', dossierEspn, f), 'utf8').replace(/^﻿/, ''));
    for (const m of saison) {
      if (!m.arbitre) continue;
      const jour = m.date.slice(0, 10);
      arbitresEspn[`${jour}|${(m.nom.split(' at ').pop())}`] = m.arbitre.trim();
    }
  }
}
function arbitreDe(code, m) {
  if (code === 'E0') return m.Referee || '';
  const espn = VERS_ESPN[m.HomeTeam] || m.HomeTeam;
  return arbitresEspn[`${dateIso(m.Date)}|${espn}`] || '';
}

// Regression logistique 1 variable
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
    b0 += (h11 * g0 - h01 * g1) / det; b1 += (h00 * g1 - h01 * g0) / det;
  }
  return { b0, b1 };
}
const plog = (c, x) => 1 / (1 + Math.exp(-(c.b0 + c.b1 * x)));

// ============ ENTRAINEMENT (2023-24 + 2024-25) ============
const modeles = {};
for (const { code } of LIGUES) {
  const matchsTrain = TRAIN.flatMap(s => lit(code, s));

  // Taux de base
  const p0 = matchsTrain.reduce((s, m) => s + aRouge(m), 0) / matchsTrain.length;

  // Arbitres (comme dans l'appli : retrecissement +30 matchs fictifs au taux de base)
  const arbs = {};
  for (const m of matchsTrain) {
    const a = arbitreDe(code, m);
    if (!a) continue;
    (arbs[a] = arbs[a] || { matchs: 0, rouges: 0 });
    arbs[a].matchs++; arbs[a].rouges += aRouge(m);
  }
  const fArb = (a) => {
    if (!a || !arbs[a]) return 1;
    return ((arbs[a].rouges + 30 * p0) / (arbs[a].matchs + 30)) / p0;
  };

  // Equipes (retrecissement +10 matchs fictifs a la moyenne)
  const eqs = {};
  let totJ = 0, totM = 0;
  for (const m of matchsTrain) {
    (eqs[m.HomeTeam] = eqs[m.HomeTeam] || { matchs: 0, jaunes: 0 });
    (eqs[m.AwayTeam] = eqs[m.AwayTeam] || { matchs: 0, jaunes: 0 });
    eqs[m.HomeTeam].matchs++; eqs[m.HomeTeam].jaunes += parseInt(m.HY);
    eqs[m.AwayTeam].matchs++; eqs[m.AwayTeam].jaunes += parseInt(m.AY);
    totM++; totJ += parseInt(m.HY) + parseInt(m.AY);
  }
  const moyEq = totJ / (2 * totM);
  const aggDe = (e) => eqs[e] ? (eqs[e].jaunes + 10 * moyEq) / (eqs[e].matchs + 10) : null;

  // Profil des promus du train (premiere saison apres montee)
  const av2223 = equipesDe(lit(code, '2223')), av2324 = equipesDe(lit(code, '2324'));
  let jP = 0, mP = 0;
  for (const [avant, saison] of [[av2223, '2324'], [av2324, '2425']]) {
    const matchsS = lit(code, saison);
    for (const p of [...equipesDe(matchsS)].filter(e => !avant.has(e))) {
      for (const m of matchsS) {
        if (m.HomeTeam === p) { mP++; jP += parseInt(m.HY); }
        if (m.AwayTeam === p) { mP++; jP += parseInt(m.AY); }
      }
    }
  }
  const aggPromu = jP / mP;

  // Coefficients logistiques (classement et agressivite) sur le train uniquement
  const obsGap = [], obsAgg = [];
  for (const s of TRAIN) {
    const matchs = lit(code, s);
    const table = {};
    const assure = (e) => table[e] || (table[e] = { pts: 0, dif: 0, bp: 0, joues: 0, jaunes: 0 });
    for (const m of matchs) {
      const h = assure(m.HomeTeam), a = assure(m.AwayTeam);
      if (h.joues >= 5 && a.joues >= 5) {
        const cl = Object.entries(table).sort(([, x], [, y]) => y.pts - x.pts || y.dif - x.dif || y.bp - x.bp).map(([n]) => n);
        obsGap.push({ x: Math.abs(cl.indexOf(m.HomeTeam) - cl.indexOf(m.AwayTeam)), y: aRouge(m) });
        obsAgg.push({ x: h.jaunes / h.joues + a.jaunes / a.joues, y: aRouge(m) });
      }
      const gh = parseInt(m.FTHG), ga = parseInt(m.FTAG);
      h.joues++; a.joues++; h.bp += gh; a.bp += ga; h.dif += gh - ga; a.dif += ga - gh;
      h.jaunes += parseInt(m.HY); a.jaunes += parseInt(m.AY);
      if (gh > ga) h.pts += 3; else if (gh < ga) a.pts += 3; else { h.pts++; a.pts++; }
    }
  }
  const cGap = logistique(obsGap), cAgg = logistique(obsAgg);
  const tauxGap = obsGap.reduce((s, o) => s + o.y, 0) / obsGap.length;
  const tauxAgg = obsAgg.reduce((s, o) => s + o.y, 0) / obsAgg.length;

  modeles[code] = { p0, fArb, aggDe, aggPromu, cGap, tauxGap, cAgg, tauxAgg };
}

// ============ TEST A L'AVEUGLE (2025-26) ============
const predictions = []; // {ligue, arms: {A..E}, y}
let arbTrouves = 0, arbManquants = 0;
for (const { code, nom } of LIGUES) {
  const M = modeles[code];
  const matchs = lit(code, TEST);
  const table = {};
  const assure = (e) => table[e] || (table[e] = { pts: 0, dif: 0, bp: 0, joues: 0 });
  for (const m of matchs) {
    const h = assure(m.HomeTeam), a = assure(m.AwayTeam);

    // Facteur equipes (equipe absente du train = promue -> profil promu du train)
    const aggH = M.aggDe(m.HomeTeam) ?? M.aggPromu;
    const aggA = M.aggDe(m.AwayTeam) ?? M.aggPromu;
    const fEq = plog(M.cAgg, aggH + aggA) / M.tauxAgg;

    // Facteur classement (des que les 2 equipes ont joue 5 matchs)
    let fGap = 1;
    if (h.joues >= 5 && a.joues >= 5) {
      const cl = Object.entries(table).sort(([, x], [, y]) => y.pts - x.pts || y.dif - x.dif || y.bp - x.bp).map(([n]) => n);
      const gap = Math.abs(cl.indexOf(m.HomeTeam) - cl.indexOf(m.AwayTeam));
      if (gap > 0) fGap = plog(M.cGap, gap) / M.tauxGap;
    }

    // Facteur arbitre
    const arb = arbitreDe(code, m);
    if (arb) arbTrouves++; else arbManquants++;
    const fA = M.fArb(arb);

    const borne = (r) => Math.min(0.97, Math.max(0.005, r));
    predictions.push({
      ligue: nom,
      y: aRouge(m),
      arms: {
        'A. Taux du championnat seul': borne(M.p0),
        'B. + equipes': borne(M.p0 * fEq),
        'C. + classement': borne(M.p0 * fGap),
        'D. + arbitre': borne(M.p0 * fA),
        'E. MODELE COMPLET': borne(M.p0 * fEq * fGap * fA)
      }
    });

    // Mise a jour du classement
    const gh = parseInt(m.FTHG), ga = parseInt(m.FTAG);
    h.joues++; a.joues++; h.bp += gh; a.bp += ga; h.dif += gh - ga; a.dif += ga - gh;
    if (gh > ga) h.pts += 3; else if (gh < ga) a.pts += 3; else { h.pts++; a.pts++; }
  }
}
console.log(`Matchs testes (saison 2025-26) : ${predictions.length} | arbitre trouve : ${arbTrouves}, manquant : ${arbManquants}\n`);

// ============ SCORES ============
const noms = Object.keys(predictions[0].arms);
console.log('SCORE DE BRIER (plus petit = meilleur) et LOG-LOSS, saison test :');
console.log('  ' + 'Variante'.padEnd(30) + 'Brier x100'.padStart(11) + 'Log-loss'.padStart(10) + '   (vs A)');
for (const nomArm of noms) {
  let brier = 0, ll = 0, brierA = 0;
  for (const p of predictions) {
    const q = p.arms[nomArm], qa = p.arms[noms[0]];
    brier += (q - p.y) ** 2;
    brierA += (qa - p.y) ** 2;
    ll += -(p.y * Math.log(q) + (1 - p.y) * Math.log(1 - q));
  }
  brier /= predictions.length; ll /= predictions.length; brierA /= predictions.length;
  const gain = 100 * (brierA - brier) / brierA;
  console.log('  ' + nomArm.padEnd(30) + (100 * brier).toFixed(3).padStart(11) + ll.toFixed(4).padStart(10)
    + (nomArm === noms[0] ? '   (reference)' : `   ${gain >= 0 ? '+' : ''}${gain.toFixed(2)} %`));
}

// Par ligue, modele complet vs constante
console.log('\nPar championnat (Brier x100, complet vs taux seul) :');
for (const { nom } of LIGUES) {
  const sel = predictions.filter(p => p.ligue === nom);
  const b = (arm) => sel.reduce((s, p) => s + (p.arms[arm] - p.y) ** 2, 0) / sel.length;
  const bA = b(noms[0]), bE = b(noms[4]);
  console.log(`  ${nom.padEnd(16)} : ${(100 * bA).toFixed(3)} -> ${(100 * bE).toFixed(3)}  (${bE < bA ? 'MIEUX' : 'MOINS BON'}, ${(100 * (bA - bE) / bA).toFixed(2)} %)`);
}

// ============ CALIBRATION du modele complet ============
console.log('\nCALIBRATION (modele complet, saison test) :');
const triees = [...predictions].sort((a, b) => a.arms[noms[4]] - b.arms[noms[4]]);
const NB = 5, taille = Math.floor(triees.length / NB);
for (let i = 0; i < NB; i++) {
  const bloc = triees.slice(i * taille, i === NB - 1 ? triees.length : (i + 1) * taille);
  const predit = bloc.reduce((s, p) => s + p.arms[noms[4]], 0) / bloc.length;
  const observe = bloc.reduce((s, p) => s + p.y, 0) / bloc.length;
  console.log(`  quintile ${i + 1} : predit ${(100 * predit).toFixed(1)} % de rouges, observe ${(100 * observe).toFixed(1)} %  (n=${bloc.length})`);
}

// ============ SIMULATION DE PARIS contre le bookmaker de reference ============
// Le bookmaker cote le taux du championnat avec sa marge ; on parie quand le modele voit un ecart.
console.log('\nSIMULATION DE PARIS (bookmaker = taux du championnat + marge, mise 1 unite par pari) :');
for (const marge of [0.04, 0.08]) {
  let mises = 0, gains = 0, parisSans = 0, parisRouge = 0;
  for (const p of predictions) {
    const pR = p.arms[noms[4]], pRBook = p.arms[noms[0]];
    const impliedSans = (1 - pRBook) * (1 + marge / 2); // prob implicite cote "sans rouge"
    const impliedRouge = pRBook * (1 + marge / 2);
    if ((1 - pR) > impliedSans) {           // valeur sur "sans carton rouge"
      const cote = 1 / impliedSans;
      mises++; parisSans++;
      gains += p.y === 0 ? cote - 1 : -1;
    } else if (pR > impliedRouge) {         // valeur sur "carton rouge"
      const cote = 1 / impliedRouge;
      mises++; parisRouge++;
      gains += p.y === 1 ? cote - 1 : -1;
    }
  }
  console.log(`  marge bookmaker ${(100 * marge).toFixed(0)} % : ${mises} paris (${parisSans} sans rouge, ${parisRouge} rouge) -> resultat ${gains >= 0 ? '+' : ''}${gains.toFixed(1)} unites (ROI ${(100 * gains / Math.max(1, mises)).toFixed(1)} %)`);
}