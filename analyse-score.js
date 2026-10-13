// FACTEUR SCORE EN COURS DE MATCH, championnat par championnat.
// Pour chaque match : ecart au score aux minutes 15/30/45/60/75 (matchs encore sans rouge),
// et survenue d'un rouge APRES cet instant. Le multiplicateur est un ratio de calibration
// observe/predit par rapport au modele de base (minute + jaunes), donc il ne compte pas
// deux fois la correlation "match serre = plus de jaunes".
// Fit : 2023-24 + 2024-25. Test aveugle : 2025-26. Sortie : donnees/score-facteurs.json
const fs = require('fs');
const path = require('path');

const LIGUES = [
  { etiquette: 'eng1', nom: 'Premier League', dossierCartons: '' },
  { etiquette: 'esp1', nom: 'Liga', dossierCartons: 'esp1' },
  { etiquette: 'ita1', nom: 'Serie A', dossierCartons: 'ita1' }
];
const SAISONS_FIT = ['2023-24', '2024-25'];
const SAISON_TEST = '2025-26';
const MINUTES = [15, 30, 45, 60, 75];

function litJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
function parseMinute(s) {
  const m = /^(\d+)'(?:\+(\d+)')?/.exec(s);
  if (!m) return null;
  return parseInt(m[1]) + (m[2] ? parseInt(m[2]) / 100 : 0);
}

// Charge une ligue-saison : [{cartons: [[t, rouge]], buts: [[t, pourDomicile]]}]
function charge(ligue, saison) {
  const base = path.join(__dirname, 'donnees');
  const fichierCartons = ligue.dossierCartons
    ? path.join(base, ligue.dossierCartons, `saison-${saison}.json`)
    : path.join(base, `saison-${saison}.json`);
  const cartonsParId = {};
  for (const m of litJson(fichierCartons)) {
    if (m.erreur) continue;
    cartonsParId[String(m.id)] = {
      nom: m.nom,
      cartons: (m.cartons || []).map(c => {
        const t = parseMinute(c.minute);
        return t === null ? null : [t, /Red/.test(c.type) ? 1 : 0];
      }).filter(Boolean)
    };
  }
  const butsTable = litJson(path.join(base, 'buts', `buts-${ligue.etiquette}-${saison}.json`));
  const matchs = [];
  for (const [id, infos] of Object.entries(butsTable)) {
    const c = cartonsParId[id];
    if (!c) continue;
    const domicile = infos.nom.split(' at ').pop();
    const buts = [];
    for (const b of (infos.buts || [])) {
      if (!/Goal|Penalty - Scored/.test(b.type)) continue;
      if (/VAR|Disallow|Missed|Cancel|No Goal/i.test(b.type)) continue;
      const t = parseMinute(b.minute);
      if (t === null) continue;
      const og = /Own Goal/i.test(b.type);
      const equipeDom = b.equipe === domicile;
      buts.push([t, og ? !equipeDom : equipeDom]);
    }
    matchs.push({ cartons: c.cartons, buts });
  }
  return matchs;
}

function etats(matchs) {
  // Un etat par (match vivant, minute echantillonnee) : {t, k, marge, y}
  const sortie = [];
  for (const m of matchs) {
    for (const t of MINUTES) {
      let k = 0, rougeAvant = false, rougeApres = false, gh = 0, ga = 0;
      for (const [tc, r] of m.cartons) {
        if (tc <= t) { if (r) rougeAvant = true; else k++; }
        else if (r) rougeApres = true;
      }
      if (rougeAvant) continue;
      for (const [tb, dom] of m.buts) {
        if (tb <= t) { if (dom) gh++; else ga++; }
      }
      sortie.push({ t, k, marge: Math.min(2, Math.abs(gh - ga)), y: rougeApres ? 1 : 0 });
    }
  }
  return sortie;
}

// Modele de base "minute + jaunes" : p(rouge apres t | vivant a t, k jaunes), estime sur le fit
function baseDepuis(matchsFit) {
  const exact = {}; // "t|k" -> {n, rouges}
  for (const e of etats(matchsFit)) {
    const cle = `${e.t}|${e.k}`;
    (exact[cle] = exact[cle] || { n: 0, r: 0 });
    exact[cle].n++; exact[cle].r += e.y;
  }
  return (t, k) => {
    // elargissement k±1 puis k±2 si moins de 40 etats
    for (const w of [0, 1, 2, 4]) {
      let n = 0, r = 0;
      for (let kk = Math.max(0, k - w); kk <= k + w; kk++) {
        const c = exact[`${t}|${kk}`];
        if (c) { n += c.n; r += c.r; }
      }
      if (n >= 40) return r / n;
    }
    let n = 0, r = 0;
    for (const cle in exact) { if (cle.startsWith(t + '|')) { n += exact[cle].n; r += exact[cle].r; } }
    return n ? r / n : 0.1;
  };
}

const resultat = [];
for (const ligue of LIGUES) {
  const matchsFit = SAISONS_FIT.flatMap(s => charge(ligue, s));
  const matchsTest = charge(ligue, SAISON_TEST);
  const base = baseDepuis(matchsFit);

  // Multiplicateurs par (periode, ecart au score) : ratio observe / predit-par-la-base
  const cellules = [[{ o: 0, p: 0, n: 0 }, { o: 0, p: 0, n: 0 }, { o: 0, p: 0, n: 0 }],
                    [{ o: 0, p: 0, n: 0 }, { o: 0, p: 0, n: 0 }, { o: 0, p: 0, n: 0 }]];
  for (const e of etats(matchsFit)) {
    const c = cellules[e.t <= 45 ? 0 : 1][e.marge];
    c.o += e.y; c.p += base(e.t, e.k); c.n++;
  }
  const facteurs = cellules.map(periode => periode.map(c => c.n ? +(c.o / c.p).toFixed(4) : 1));

  console.log(`\n=== ${ligue.nom} ===  (${matchsFit.length} matchs fit, ${matchsTest.length} test)`);
  const nomsP = ['1re mi-temps', '2de mi-temps'];
  const nomsB = ['egalite', '1 but d\'ecart', '2 buts ou +'];
  for (let p = 0; p < 2; p++) {
    for (let b = 0; b < 3; b++) {
      const c = cellules[p][b];
      console.log(`  ${nomsP[p]}, ${nomsB[b].padEnd(14)} : rouge ensuite ${(100 * c.o / c.n).toFixed(1)} % observe vs ${(100 * c.p / c.n).toFixed(1)} % attendu -> facteur x ${facteurs[p][b].toFixed(2)}  (n=${c.n})`);
    }
  }

  // TEST AVEUGLE 2025-26 : base seule vs base x facteur score
  let bBase = 0, bScore = 0, n = 0;
  for (const e of etats(matchsTest)) {
    const pb = Math.min(0.97, Math.max(0.005, base(e.t, e.k)));
    const ps = Math.min(0.97, Math.max(0.005, pb * facteurs[e.t <= 45 ? 0 : 1][e.marge]));
    bBase += (pb - e.y) ** 2; bScore += (ps - e.y) ** 2; n++;
  }
  bBase /= n; bScore /= n;
  console.log(`  TEST 2025-26 (${n} etats) : Brier x100 base ${(100 * bBase).toFixed(3)} -> avec score ${(100 * bScore).toFixed(3)} (${bScore < bBase ? 'MIEUX' : 'MOINS BON'}, ${(100 * (bBase - bScore) / bBase).toFixed(2)} %)`);

  resultat.push({ nom: ligue.nom, periodes: facteurs });
}

fs.writeFileSync(path.join(__dirname, 'donnees', 'score-facteurs.json'), JSON.stringify(resultat, null, 1));
console.log('\ndonnees/score-facteurs.json ecrit.');