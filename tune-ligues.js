// PONDERATION CHAMPIONNAT PAR CHAMPIONNAT des facteurs (arbitre, equipes, classement, amortissement).
// Pour chaque ligue : choix des reglages sur la saison de validation (fit 2023-24 -> validation 2024-25),
// puis evaluation finale unique sur 2025-26. Ecrit donnees/reglages-ligues.json pour le simulateur.
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

function construis(code, saisonsFit, saisonAvantPremiere) {
  const matchsFit = saisonsFit.flatMap(s => lit(code, s));
  const p0 = matchsFit.reduce((s, m) => s + aRouge(m), 0) / matchsFit.length;
  const arbs = {};
  for (const m of matchsFit) {
    const a = arbitreDe(code, m);
    if (!a) continue;
    (arbs[a] = arbs[a] || { matchs: 0, rouges: 0 });
    arbs[a].matchs++; arbs[a].rouges += aRouge(m);
  }
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
  let jP = 0, mP = 0;
  for (let i = 0; i < saisonsFit.length; i++) {
    const avant = equipesDe(lit(code, i === 0 ? saisonAvantPremiere : saisonsFit[i - 1]));
    const matchsS = lit(code, saisonsFit[i]);
    for (const pr of [...equipesDe(matchsS)].filter(e => !avant.has(e))) {
      for (const m of matchsS) {
        if (m.HomeTeam === pr) { mP++; jP += parseInt(m.HY); }
        if (m.AwayTeam === pr) { mP++; jP += parseInt(m.AY); }
      }
    }
  }
  const aggPromu = mP ? jP / mP : moyEq;
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
  return { p0, arbs, aggDe, aggPromu, cGap, tauxGap, cAgg, tauxAgg };
}

// reglages : {arbP: 0=aucun|30|100|300, eqActif, gapActif, alpha}
function predit(code, M, saisonEval, r) {
  const sortie = [];
  const matchs = lit(code, saisonEval);
  const table = {};
  const assure = (e) => table[e] || (table[e] = { pts: 0, dif: 0, bp: 0, joues: 0 });
  for (const m of matchs) {
    const h = assure(m.HomeTeam), a = assure(m.AwayTeam);
    let fEq = 1;
    if (r.eqActif) {
      const aggH = M.aggDe(m.HomeTeam) ?? M.aggPromu;
      const aggA = M.aggDe(m.AwayTeam) ?? M.aggPromu;
      fEq = plog(M.cAgg, aggH + aggA) / M.tauxAgg;
    }
    let fGap = 1;
    if (r.gapActif && h.joues >= 5 && a.joues >= 5) {
      const cl = Object.entries(table).sort(([, x], [, y]) => y.pts - x.pts || y.dif - x.dif || y.bp - x.bp).map(([n]) => n);
      const gap = Math.abs(cl.indexOf(m.HomeTeam) - cl.indexOf(m.AwayTeam));
      if (gap > 0) fGap = plog(M.cGap, gap) / M.tauxGap;
    }
    let fA = 1;
    const arb = arbitreDe(code, m);
    if (r.arbP > 0 && arb && M.arbs[arb]) {
      fA = ((M.arbs[arb].rouges + r.arbP * M.p0) / (M.arbs[arb].matchs + r.arbP)) / M.p0;
    }
    sortie.push({ p: Math.min(0.97, Math.max(0.005, M.p0 * Math.pow(fEq * fGap * fA, r.alpha))), p0: M.p0, y: aRouge(m) });
    const gh = parseInt(m.FTHG), ga = parseInt(m.FTAG);
    h.joues++; a.joues++; h.bp += gh; a.bp += ga; h.dif += gh - ga; a.dif += ga - gh;
    if (gh > ga) h.pts += 3; else if (gh < ga) a.pts += 3; else { h.pts++; a.pts++; }
  }
  return sortie;
}
const brier = (p) => p.reduce((s, o) => s + (o.p - o.y) ** 2, 0) / p.length;
const brierRef = (p) => p.reduce((s, o) => s + (o.p0 - o.y) ** 2, 0) / p.length;

// Grille complete
const grilles = [];
for (const arbP of [0, 30, 100, 300])
  for (const eqActif of [true, false])
    for (const gapActif of [true, false])
      for (const alpha of [1, 0.7, 0.5])
        grilles.push({ arbP, eqActif, gapActif, alpha });

const reglagesFinaux = [];
for (const { code, nom } of LIGUES) {
  const Mval = construis(code, ['2324'], '2223');
  let meilleur = null;
  const brierRefVal = brierRef(predit(code, Mval, '2425', grilles[0]));
  for (const g of grilles) {
    const b = brier(predit(code, Mval, '2425', g));
    if (!meilleur || b < meilleur.b) meilleur = { ...g, b };
  }
  // Reference "tout a 1" (taux seul) sur la validation
  const bConst = brier(predit(code, Mval, '2425', { arbP: 0, eqActif: false, gapActif: false, alpha: 1 }));
  console.log(`\n=== ${nom} ===`);
  console.log(`  Validation 2024-25 : taux seul ${(100 * bConst).toFixed(3)} -> retenu ${(100 * meilleur.b).toFixed(3)}`);
  console.log(`  Reglages retenus : arbitre=${meilleur.arbP === 0 ? 'AUCUN' : 'prudence +' + meilleur.arbP}, equipes=${meilleur.eqActif ? 'OUI' : 'NON'}, classement=${meilleur.gapActif ? 'OUI' : 'NON'}, amortissement alpha=${meilleur.alpha}`);

  // Evaluation finale sur 2025-26 (fit 2023-24 + 2024-25)
  const Mfinal = construis(code, ['2324', '2425'], '2223');
  const predsTest = predit(code, Mfinal, '2526', meilleur);
  const bT = brier(predsTest), bRT = brierRef(predsTest);
  console.log(`  TEST 2025-26 : taux seul ${(100 * bRT).toFixed(3)} -> modele ${(100 * bT).toFixed(3)}  (${bT < bRT ? 'MIEUX' : 'MOINS BON'}, ${(100 * (bRT - bT) / bRT).toFixed(2)} %)`);

  reglagesFinaux.push({ nom, arbP: meilleur.arbP, eqActif: meilleur.eqActif, gapActif: meilleur.gapActif, alpha: meilleur.alpha });
}

fs.writeFileSync(path.join(__dirname, 'donnees', 'reglages-ligues.json'), JSON.stringify(reglagesFinaux, null, 1));
console.log('\ndonnees/reglages-ligues.json ecrit.');