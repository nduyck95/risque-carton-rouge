// RETRAVAIL du modele apres le premier backtest :
//  - choix des reglages sur une saison de VALIDATION (fit 2023-24 -> validation 2024-25)
//  - evaluation finale, une seule fois, sur la saison TEST jamais vue (2025-26)
// Variantes testees pour l'arbitre : aucun facteur / taux de rouges retreci (3 forces) /
// severite estimee par les JAUNES de l'arbitre (signal 25x plus frequent donc plus stable).
// Plus un amortissement global du cumul des facteurs (alpha).
const fs = require('fs');
const path = require('path');

const DOSSIER = path.join(__dirname, 'donnees', 'classements');
const LIGUES = [
  { code: 'E0', nom: 'Premier League', dossierEspn: null },
  { code: 'SP1', nom: 'Liga', dossierEspn: 'esp1' },
  { code: 'I1', nom: 'Serie A', dossierEspn: 'ita1' }
];
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
const cacheCsv = {};
function lit(code, saison) {
  const cle = code + saison;
  if (!cacheCsv[cle]) {
    cacheCsv[cle] = parseCsv(fs.readFileSync(path.join(DOSSIER, `${code}-${saison}.csv`), 'utf8'))
      .filter(m => m.HomeTeam && m.FTHG !== '' && m.HY !== '' && m.HR !== '')
      .sort((a, b) => dateIso(a.Date).localeCompare(dateIso(b.Date)));
  }
  return cacheCsv[cle];
}
function equipesDe(matchs) { const s = new Set(); for (const m of matchs) { s.add(m.HomeTeam); s.add(m.AwayTeam); } return s; }
const aRouge = (m) => (parseInt(m.HR) + parseInt(m.AR)) > 0 ? 1 : 0;

const arbitresEspn = {};
for (const { dossierEspn } of LIGUES) {
  if (!dossierEspn) continue;
  for (const f of fs.readdirSync(path.join(__dirname, 'donnees', dossierEspn))) {
    const saison = JSON.parse(fs.readFileSync(path.join(__dirname, 'donnees', dossierEspn, f), 'utf8').replace(/^﻿/, ''));
    for (const m of saison) {
      if (!m.arbitre) continue;
      arbitresEspn[`${m.date.slice(0, 10)}|${m.nom.split(' at ').pop()}`] = m.arbitre.trim();
    }
  }
}
function arbitreDe(code, m) {
  if (code === 'E0') return m.Referee || '';
  return arbitresEspn[`${dateIso(m.Date)}|${VERS_ESPN[m.HomeTeam] || m.HomeTeam}`] || '';
}

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

// ============ Construction d'un modele par ligue a partir de saisons de fit ============
function construis(code, saisonsFit, saisonsAvant) {
  const matchsFit = saisonsFit.flatMap(s => lit(code, s));
  const p0 = matchsFit.reduce((s, m) => s + aRouge(m), 0) / matchsFit.length;

  // Arbitres : rouges et jaunes
  const arbs = {};
  let totJLigue = 0;
  for (const m of matchsFit) {
    totJLigue += parseInt(m.HY) + parseInt(m.AY);
    const a = arbitreDe(code, m);
    if (!a) continue;
    (arbs[a] = arbs[a] || { matchs: 0, rouges: 0, jaunes: 0 });
    arbs[a].matchs++; arbs[a].rouges += aRouge(m); arbs[a].jaunes += parseInt(m.HY) + parseInt(m.AY);
  }
  const moyJParMatch = totJLigue / matchsFit.length;
  const jauneArb = (a) => (!a || !arbs[a]) ? moyJParMatch
    : (arbs[a].jaunes + 20 * moyJParMatch) / (arbs[a].matchs + 20);

  // Logistique P(rouge) ~ jaunes/match de l'arbitre (fit)
  const obsArbY = [];
  for (const m of matchsFit) {
    const a = arbitreDe(code, m);
    if (a && arbs[a]) obsArbY.push({ x: jauneArb(a), y: aRouge(m) });
  }
  const cArbY = logistique(obsArbY);
  const tauxArbY = obsArbY.reduce((s, o) => s + o.y, 0) / obsArbY.length;

  // Equipes
  const eqs = {};
  let totJ = 0, totM = 0;
  for (const m of matchsFit) {
    (eqs[m.HomeTeam] = eqs[m.HomeTeam] || { matchs: 0, jaunes: 0 });
    (eqs[m.AwayTeam] = eqs[m.AwayTeam] || { matchs: 0, jaunes: 0 });
    eqs[m.HomeTeam].matchs++; eqs[m.HomeTeam].jaunes += parseInt(m.HY);
    eqs[m.AwayTeam].matchs++; eqs[m.AwayTeam].jaunes += parseInt(m.AY);
    totM++; totJ += parseInt(m.HY) + parseInt(m.AY);
  }
  const moyEq = totJ / (2 * totM);
  const aggDe = (e) => eqs[e] ? (eqs[e].jaunes + 10 * moyEq) / (eqs[e].matchs + 10) : null;

  // Profil des promus sur les saisons de fit
  let jP = 0, mP = 0;
  for (let i = 0; i < saisonsFit.length; i++) {
    const avant = equipesDe(lit(code, i === 0 ? saisonsAvant : saisonsFit[i - 1]));
    const matchsS = lit(code, saisonsFit[i]);
    for (const pr of [...equipesDe(matchsS)].filter(e => !avant.has(e))) {
      for (const m of matchsS) {
        if (m.HomeTeam === pr) { mP++; jP += parseInt(m.HY); }
        if (m.AwayTeam === pr) { mP++; jP += parseInt(m.AY); }
      }
    }
  }
  const aggPromu = mP ? jP / mP : moyEq;

  // Logistiques classement et agressivite (moyennes glissantes intra-saison)
  const obsGap = [], obsAgg = [];
  for (const s of saisonsFit) {
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

  return { p0, arbs, jauneArb, cArbY, tauxArbY, aggDe, aggPromu, cGap, tauxGap, cAgg, tauxAgg, moyJParMatch };
}

// ============ Prediction d'une saison avec des reglages donnes ============
// reglages : {arbMode: 'aucun'|'rouges'|'jaunes', arbP: nombre, alpha: nombre}
function predit(code, modele, saisonEval, reglages) {
  const M = modele;
  const sortie = [];
  const matchs = lit(code, saisonEval);
  const table = {};
  const assure = (e) => table[e] || (table[e] = { pts: 0, dif: 0, bp: 0, joues: 0 });
  for (const m of matchs) {
    const h = assure(m.HomeTeam), a = assure(m.AwayTeam);
    const aggH = M.aggDe(m.HomeTeam) ?? M.aggPromu;
    const aggA = M.aggDe(m.AwayTeam) ?? M.aggPromu;
    const fEq = plog(M.cAgg, aggH + aggA) / M.tauxAgg;
    let fGap = 1;
    if (h.joues >= 5 && a.joues >= 5) {
      const cl = Object.entries(table).sort(([, x], [, y]) => y.pts - x.pts || y.dif - x.dif || y.bp - x.bp).map(([n]) => n);
      const gap = Math.abs(cl.indexOf(m.HomeTeam) - cl.indexOf(m.AwayTeam));
      if (gap > 0) fGap = plog(M.cGap, gap) / M.tauxGap;
    }
    const arb = arbitreDe(code, m);
    let fA = 1;
    if (arb && M.arbs[arb]) {
      if (reglages.arbMode === 'rouges') {
        fA = ((M.arbs[arb].rouges + reglages.arbP * M.p0) / (M.arbs[arb].matchs + reglages.arbP)) / M.p0;
      } else if (reglages.arbMode === 'jaunes') {
        fA = plog(M.cArbY, M.jauneArb(arb)) / M.tauxArbY;
      }
    }
    const fTotal = Math.pow(fEq * fGap * fA, reglages.alpha);
    sortie.push({ p: Math.min(0.97, Math.max(0.005, M.p0 * fTotal)), p0: M.p0, y: aRouge(m) });
    const gh = parseInt(m.FTHG), ga = parseInt(m.FTAG);
    h.joues++; a.joues++; h.bp += gh; a.bp += ga; h.dif += gh - ga; a.dif += ga - gh;
    if (gh > ga) h.pts += 3; else if (gh < ga) a.pts += 3; else { h.pts++; a.pts++; }
  }
  return sortie;
}
const brier = (preds) => preds.reduce((s, p) => s + (p.p - p.y) ** 2, 0) / preds.length;
const brierRef = (preds) => preds.reduce((s, p) => s + (p.p0 - p.y) ** 2, 0) / preds.length;

// ============ 1. VALIDATION : fit 2023-24, choix des reglages sur 2024-25 ============
console.log('ETAPE 1 — choix des reglages (fit 2023-24, validation 2024-25) :');
const grilles = [];
for (const arb of [{ arbMode: 'aucun', arbP: 0 }, { arbMode: 'rouges', arbP: 30 }, { arbMode: 'rouges', arbP: 100 }, { arbMode: 'rouges', arbP: 300 }, { arbMode: 'jaunes', arbP: 0 }]) {
  for (const alpha of [1, 0.7, 0.5]) grilles.push({ ...arb, alpha });
}
const modelesVal = {};
for (const { code } of LIGUES) modelesVal[code] = construis(code, ['2324'], '2223');
let meilleur = null;
for (const g of grilles) {
  let toutes = [];
  for (const { code } of LIGUES) toutes = toutes.concat(predit(code, modelesVal[code], '2425', g));
  const b = brier(toutes), bRef = brierRef(toutes);
  const gain = 100 * (bRef - b) / bRef;
  const nomG = `arbitre=${g.arbMode}${g.arbMode === 'rouges' ? '(+' + g.arbP + ')' : ''}, alpha=${g.alpha}`;
  console.log(`  ${nomG.padEnd(38)} : Brier x100 = ${(100 * b).toFixed(3)}  (gain vs taux seul : ${gain >= 0 ? '+' : ''}${gain.toFixed(2)} %)`);
  if (!meilleur || b < meilleur.b) meilleur = { ...g, b };
}
console.log(`\n  ==> Reglages retenus : arbitre=${meilleur.arbMode}${meilleur.arbMode === 'rouges' ? '(+' + meilleur.arbP + ')' : ''}, alpha=${meilleur.alpha}\n`);

// ============ 2. TEST FINAL : fit 2023-24 + 2024-25, evaluation unique sur 2025-26 ============
console.log('ETAPE 2 — evaluation finale sur 2025-26 (jamais utilisee jusqu\'ici) :');
const modelesFinaux = {};
for (const { code } of LIGUES) modelesFinaux[code] = construis(code, ['2324', '2425'], '2223');
let toutes = [];
const parLigue = {};
for (const { code, nom } of LIGUES) {
  const preds = predit(code, modelesFinaux[code], '2526', meilleur);
  parLigue[nom] = preds;
  toutes = toutes.concat(preds);
}
const bFinal = brier(toutes), bRefFinal = brierRef(toutes);
console.log(`  Modele retravaille : Brier x100 = ${(100 * bFinal).toFixed(3)}  vs taux seul ${(100 * bRefFinal).toFixed(3)}  (gain ${(100 * (bRefFinal - bFinal) / bRefFinal).toFixed(2)} %)`);
for (const nom of Object.keys(parLigue)) {
  const b = brier(parLigue[nom]), bR = brierRef(parLigue[nom]);
  console.log(`    ${nom.padEnd(16)} : ${(100 * bR).toFixed(3)} -> ${(100 * b).toFixed(3)}  (${b < bR ? 'MIEUX' : 'MOINS BON'}, ${(100 * (bR - b) / bR).toFixed(2)} %)`);
}

// Calibration
console.log('\n  Calibration (quintiles) :');
const triees = [...toutes].sort((a, b) => a.p - b.p);
const T = Math.floor(triees.length / 5);
for (let i = 0; i < 5; i++) {
  const bloc = triees.slice(i * T, i === 4 ? triees.length : (i + 1) * T);
  console.log(`    quintile ${i + 1} : predit ${(100 * bloc.reduce((s, p) => s + p.p, 0) / bloc.length).toFixed(1)} %, observe ${(100 * bloc.reduce((s, p) => s + p.y, 0) / bloc.length).toFixed(1)} %`);
}

// Simulation de paris
console.log('\n  Simulation de paris (bookmaker = taux du championnat + marge) :');
for (const marge of [0.04, 0.08]) {
  let mises = 0, gains = 0;
  for (const p of toutes) {
    const impliedSans = (1 - p.p0) * (1 + marge / 2);
    const impliedRouge = p.p0 * (1 + marge / 2);
    if ((1 - p.p) > impliedSans) { mises++; gains += p.y === 0 ? 1 / impliedSans - 1 : -1; }
    else if (p.p > impliedRouge) { mises++; gains += p.y === 1 ? 1 / impliedRouge - 1 : -1; }
  }
  console.log(`    marge ${(100 * marge).toFixed(0)} % : ${mises} paris -> ${gains >= 0 ? '+' : ''}${gains.toFixed(1)} unites (ROI ${(100 * gains / Math.max(1, mises)).toFixed(1)} %)`);
}