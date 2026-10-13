// ============================================================================
//  test-live-saison.js — EXAMEN À L'AVEUGLE du modèle LIVE.
//
//  Le modèle n'a appris que sur les saisons 2023-24 à 2025-26. La saison en
//  cours (2026-27) lui est totalement inconnue. On rejoue donc chaque match
//  déjà joué de cette saison, minute par minute, comme si on le suivait en
//  direct, et on compare ce que le modèle annonçait à ce qui s'est passé.
//
//  À chaque minute testée et pour chaque match encore sans rouge, on note :
//    - p_modele : la probabilité "pas de rouge d'ici la fin" du modèle complet
//    - p_base   : la même chose SANS les facteurs (juste minute + jaunes)
//    - p_ligue  : la version bête (le taux moyen de la ligue, quoi qu'il arrive)
//    - la vérité : y a-t-il eu un rouge, oui ou non
//
//  Le score utilisé est le score de Brier = moyenne de (proba − vérité)².
//  PLUS BAS = MEILLEUR. Un modèle parfait ferait 0.
//
//  Lancement :  node test-live-saison.js
//               node test-live-saison.js --pas 1      (teste chaque minute)
//               node test-live-saison.js --recollecte (ignore le cache ESPN)
// ============================================================================
const fs = require('fs');
const path = require('path');
const M = require('./modele.js');
const F = require('./fournisseurs.js');
const moteur = require('./moteur.js');

const CACHE = path.join(__dirname, 'donnees', 'live-saison-courante.json');

const args = process.argv.slice(2);
const PAS = parseInt((args.find(a => a.startsWith('--pas')) || '').split('=')[1] || args[args.indexOf('--pas') + 1] || '5', 10) || 5;
const RECOLLECTE = args.includes('--recollecte');
const MIN_DEBUT = 5, MIN_FIN = 85;

function lireJson(f, d = null) {
  try { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return JSON.parse(t); }
  catch (e) { return d; }
}

// ---------------------------------------------------------------------------
//  1) Récupérer, pour chaque match joué de la saison, les minutes des cartons
//     et des buts. Mis en cache : la 2e exécution est instantanée.
// ---------------------------------------------------------------------------
function minuteDe(txt) {
  const m = /^(\d+)/.exec(String(txt || '').trim());
  return m ? parseInt(m[1], 10) : null;
}

async function collecte() {
  const etat = moteur.chargeEtat();
  if (!etat || !etat.ligues) throw new Error('Aucune mémoire de saison. Lance d\'abord un rafraîchissement depuis la page /matchs.');
  const cache = RECOLLECTE ? {} : (lireJson(CACHE, {}) || {});
  const matchs = [];
  let aTelecharger = 0;

  for (const L of etat.ligues) {
    const meta = F.LIGUES_META.find(m => m.il === L.il);
    for (const m of (L.matchs || [])) {
      if (!m.fige || !m.resultat || !m.resultat.termine) continue;
      matchs.push({ id: m.id, il: L.il, ligue: L.nom, code: meta.espn, home: m.home, away: m.away, arbitre: m.arbitre || '', date: m.date, aRougeMemo: m.resultat.aRouge });
      if (!cache[m.id]) aTelecharger++;
    }
  }
  console.log(`${matchs.length} matchs joués en mémoire ; ${aTelecharger} à télécharger chez ESPN.`);

  let fait = 0;
  for (const mt of matchs) {
    if (cache[mt.id]) continue;
    try {
      const s = await F.httpJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${mt.code}/summary?event=${mt.id}`);
      const cartes = [], buts = [];
      for (const k of (s.keyEvents || [])) {
        const t = String(k.type?.text || '');
        const min = minuteDe(k.clock?.displayValue);
        if (min == null) continue;
        if (/Card/i.test(t)) cartes.push({ min, rouge: /Red/i.test(t) ? 1 : 0 });
        else if (/^Goal$/i.test(t)) buts.push({ min, equipe: k.team?.displayName || null });
      }
      cache[mt.id] = { cartes, buts };
      fait++;
      if (fait % 20 === 0) console.log(`  … ${fait}/${aTelecharger}`);
      await F.pause(130);
    } catch (e) {
      console.log(`  ! ${mt.home}-${mt.away} : ${e.message}`);
    }
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1), 'utf8');
  return { matchs, cache };
}

// ---------------------------------------------------------------------------
//  2) Rejouer les matchs et collecter les observations
// ---------------------------------------------------------------------------
function rejoue(matchs, cache) {
  const obs = [];
  const tauxLigue = [0, 1, 2].map(il => M.contexte(il).taux); // taux de rouge appris (2023-26)
  let sansDonnees = 0;

  for (const mt of matchs) {
    const d = cache[mt.id];
    if (!d) { sansDonnees++; continue; }
    const cartes = d.cartes || [], buts = d.buts || [];
    const aRouge = cartes.some(c => c.rouge === 1);
    // Cohérence : le résultat mémorisé et les keyEvents doivent dire la même chose
    const minuteRouge = aRouge ? Math.min(...cartes.filter(c => c.rouge === 1).map(c => c.min)) : null;

    for (let minute = MIN_DEBUT; minute <= MIN_FIN; minute += PAS) {
      // On ne teste que les instants où AUCUN rouge n'est encore tombé :
      // c'est la seule situation où la question du modèle a un sens.
      if (minuteRouge != null && minuteRouge <= minute) break;

      const passees = cartes.filter(c => c.min <= minute);
      const jaunes = passees.filter(c => c.rouge === 0).length;
      const butsA = buts.filter(b => b.min <= minute && b.equipe === mt.home).length;
      const butsB = buts.filter(b => b.min <= minute && b.equipe === mt.away).length;

      const pr = M.predireLive(mt.il, {
        home: mt.home, away: mt.away, arbitre: mt.arbitre,
        posA: null, posB: null,
        minute, jaunes, butsA, butsB, dejaRouge: false,
      });
      if (pr.pNo == null) continue;

      obs.push({
        il: mt.il, ligue: mt.ligue, match: `${mt.home} - ${mt.away}`, minute, jaunes, n: pr.n,
        pModele: pr.pNo,
        pBase: pr.pBase,                       // minute + jaunes, sans aucun facteur
        pLigue: 1 - tauxLigue[mt.il],          // le modèle "bête"
        y: aRouge ? 0 : 1,                     // 1 = le match a fini SANS rouge
        arbitreConnu: pr.arbitreConnu,
        facteurs: pr.facteurs,
      });
    }
  }
  if (sansDonnees) console.log(`(${sansDonnees} matchs sans détail ESPN, ignorés)`);
  return obs;
}

// ---------------------------------------------------------------------------
//  3) Les scores
// ---------------------------------------------------------------------------
const brier = (arr, champ) => arr.reduce((s, o) => s + Math.pow(o[champ] - o.y, 2), 0) / arr.length;
const moy = (arr, f) => arr.reduce((s, o) => s + f(o), 0) / arr.length;
const pc = (x, d = 1) => (x * 100).toFixed(d) + ' %';

function ligneScores(nom, arr) {
  if (!arr.length) return `${nom.padEnd(18)} —`;
  const bm = brier(arr, 'pModele'), bb = brier(arr, 'pBase'), bl = brier(arr, 'pLigue');
  const gainVsLigue = (bl - bm) / bl, gainVsBase = (bb - bm) / bb;
  return `${nom.padEnd(18)} ${String(arr.length).padStart(5)} obs | `
    + `Brier modèle ${bm.toFixed(4)} · base ${bb.toFixed(4)} · ligue ${bl.toFixed(4)} | `
    + `vs ligue ${(gainVsLigue >= 0 ? '+' : '') + pc(gainVsLigue)} · vs base ${(gainVsBase >= 0 ? '+' : '') + pc(gainVsBase)}`;
}

function calibration(obs, bornes = [0.75, 0.85, 0.90, 0.94, 0.97, 1.01]) {
  console.log('\nCALIBRATION — le modèle dit-il la vérité en moyenne ?');
  console.log('  tranche annoncée      n     annoncé   observé   écart');
  let bas = 0;
  for (const haut of bornes) {
    const lot = obs.filter(o => o.pModele >= bas && o.pModele < haut);
    if (lot.length) {
      const ann = moy(lot, o => o.pModele), obsv = moy(lot, o => o.y);
      const ecart = obsv - ann;
      console.log(`  ${(pc(bas, 0) + '–' + pc(haut > 1 ? 1 : haut, 0)).padEnd(16)} ${String(lot.length).padStart(5)}   ${pc(ann).padStart(7)}   ${pc(obsv).padStart(7)}   ${(ecart >= 0 ? '+' : '') + pc(ecart)}`);
    }
    bas = haut;
  }
}

function parMinute(obs) {
  console.log('\nPAR PÉRIODE DE JEU');
  const bandes = [[5, 20], [21, 40], [41, 60], [61, 85]];
  for (const [a, b] of bandes) {
    const lot = obs.filter(o => o.minute >= a && o.minute <= b);
    console.log('  ' + ligneScores(`${a}'–${b}'`, lot));
  }
}

// AUC : probabilité que le modèle classe correctement un couple (match à rouge,
// match sans rouge). 0,5 = hasard pur.
function aucDe(arr, champ = 'pModele') {
  const avec = arr.filter(o => o.y === 0).map(o => o[champ]);
  const sans = arr.filter(o => o.y === 1).map(o => o[champ]);
  if (!avec.length || !sans.length) return null;
  let bons = 0, egaux = 0;
  for (const a of avec) for (const s of sans) { if (a < s) bons++; else if (a === s) egaux++; }
  return (bons + egaux / 2) / (avec.length * sans.length);
}

// Le test qui compte vraiment pour parier : le modèle sait-il CLASSER les
// situations ? On compare les 20 % d'instants les plus "risqués" selon le
// modèle aux 20 % les plus "calmes", et on regarde ce qui s'est réellement passé.
function discrimination(obs) {
  console.log('\nPOUVOIR DE TRI (le plus important pour parier)');
  const tri = obs.slice().sort((a, b) => a.pModele - b.pModele);
  const q = Math.floor(tri.length / 5);
  if (q >= 5) {
    const risques = tri.slice(0, q), calmes = tri.slice(-q);
    const tauxR = 1 - moy(risques, o => o.y), tauxC = 1 - moy(calmes, o => o.y);
    console.log(`  20 % jugés les PLUS risqués  : annoncé ${pc(1 - moy(risques, o => o.pModele))} de rouge → observé ${pc(tauxR)} (n=${risques.length})`);
    console.log(`  20 % jugés les PLUS calmes   : annoncé ${pc(1 - moy(calmes, o => o.pModele))} de rouge → observé ${pc(tauxC)} (n=${calmes.length})`);
    console.log(`  Écart observé : ${(tauxR - tauxC >= 0 ? '+' : '') + pc(tauxR - tauxC)} ${tauxR > tauxC ? '(le tri va dans le bon sens)' : '(LE TRI EST À L\'ENVERS)'}`);
  }
  const global = aucDe(obs);
  console.log(`  AUC toutes ligues confondues = ${global == null ? '—' : global.toFixed(3)}`);
  console.log('  ATTENTION : ce chiffre global est FLATTEUR. Il récompense le modèle simplement');
  console.log('  parce qu\'il connaît les taux par championnat (la Liga a 3× plus de rouges que');
  console.log('  la PL). Le seul test honnête est le tri À L\'INTÉRIEUR de chaque championnat :');
  for (const il of [0, 1, 2]) {
    const lot = obs.filter(o => o.il === il);
    const nR = new Set(lot.filter(o => o.y === 0).map(o => o.match)).size;
    const a = aucDe(lot), ab = aucDe(lot, 'pBase');
    const fiable = nR >= 5;
    console.log(`    ${M.LIGUES[il].nom.padEnd(15)} AUC ${a == null ? '—' : a.toFixed(3)}`
      + ` (base seule ${ab == null ? '—' : ab.toFixed(3)}) · ${nR} match(s) à rouge`
      + (fiable ? '' : ' → INEXPLOITABLE, trop peu de rouges'));
  }
}

// Le biais : le modèle se trompe-t-il SYSTÉMATIQUEMENT dans un sens ?
// C'est décisif pour parier : un biais fabrique de fausses occasions d'un côté.
function biais(obs) {
  console.log('\nBIAIS — le modèle penche-t-il d\'un côté ?');
  const ligne = (nom, lot) => {
    if (!lot.length) return;
    const ann = moy(lot, o => o.pModele), reel = moy(lot, o => o.y);
    const ecart = reel - ann;
    console.log(`  ${nom.padEnd(16)} annonce ${pc(ann)} sans rouge · observé ${pc(reel)}`
      + ` · écart ${(ecart >= 0 ? '+' : '') + (ecart * 100).toFixed(1)} pts`
      + (Math.abs(ecart) > 0.03 ? (ecart > 0 ? '  ← TROP PESSIMISTE' : '  ← TROP OPTIMISTE') : ''));
  };
  for (const il of [0, 1, 2]) ligne(M.LIGUES[il].nom, obs.filter(o => o.il === il));
  ligne('ENSEMBLE', obs);

  const ann = moy(obs, o => o.pModele), reel = moy(obs, o => o.y);
  const pRa = 1 - ann, pRo = 1 - reel;
  console.log(`\n  Traduit en cotes sur le côté « ROUGE » :`);
  console.log(`    cote juste selon le modèle : ${(1 / pRa).toFixed(2)}   ·   cote juste selon la réalité : ${(1 / pRo).toFixed(2)}`);
  if (pRa > pRo) {
    console.log('    → Le modèle surestime le risque de rouge. Conséquence directe : il trouvera');
    console.log('      des « occasions » sur le côté ROUGE qui n\'en sont pas. C\'est un piège.');
  } else if (pRo > pRa) {
    console.log('    → Le modèle sous-estime le risque de rouge : ce sont les paris « pas de rouge »');
    console.log('      qui deviennent trompeurs.');
  }
}

// Cette saison ressemble-t-elle aux précédentes ? Si un championnat donne
// beaucoup moins de rouges que d'habitude, ce n'est pas le modèle qui est
// cassé : c'est le football qui a changé (ou la chance). On le chiffre.
function rougesAttendus(matchs, cache) {
  console.log('\nCETTE SAISON EST-ELLE NORMALE ?');
  // Probabilité d'observer AU PLUS k rouges sur n matchs si le taux appris était juste
  const binomCum = (k, n, p) => {
    let s = 0, terme = Math.pow(1 - p, n);
    for (let i = 0; i <= k; i++) { s += terme; terme *= ((n - i) / (i + 1)) * (p / (1 - p)); }
    return Math.min(1, s);
  };
  for (const il of [0, 1, 2]) {
    const lot = matchs.filter(m => m.il === il && cache[m.id]);
    if (!lot.length) continue;
    const observes = lot.filter(m => (cache[m.id].cartes || []).some(c => c.rouge === 1)).length;
    const p = M.contexte(il).taux;
    const attendus = lot.length * p;
    const proba = binomCum(observes, lot.length, p);
    console.log(`  ${M.LIGUES[il].nom.padEnd(15)} ${observes} rouge(s) sur ${lot.length} matchs`
      + ` · attendu ${attendus.toFixed(1)} (taux appris ${pc(p)})`
      + ` · probabilité d'en avoir si peu par hasard : ${pc(proba)}`
      + (proba < 0.05 ? '  ← ANORMAL' : ''));
  }
  console.log('  Si un championnat est marqué ANORMAL, deux lectures : soit l\'arbitrage y a');
  console.log('  changé cette saison (et le modèle doit être réappris), soit c\'est de la chance.');
  console.log('  Un seul moyen de trancher : attendre d\'autres journées.');
}

// ---------------------------------------------------------------------------
(async () => {
  const { matchs, cache } = await collecte();
  const obs = rejoue(matchs, cache);
  const avecRouge = new Set(obs.filter(o => o.y === 0).map(o => o.match));
  console.log(`\n${obs.length} observations sur ${matchs.length} matchs (une tous les ${PAS}' de la ${MIN_DEBUT}e à la ${MIN_FIN}e).`);
  console.log(`Matchs avec rouge dans l'échantillon : ${avecRouge.size}.`);

  console.log('\nSCORE DE BRIER — plus bas = meilleur');
  console.log('  ' + ligneScores('TOUTES LIGUES', obs));
  for (const il of [0, 1, 2]) {
    const lot = obs.filter(o => o.il === il);
    console.log('  ' + ligneScores(M.LIGUES[il].nom, lot));
  }
  parMinute(obs);
  calibration(obs);
  discrimination(obs);
  biais(obs);
  rougesAttendus(matchs, cache);

  console.log('\nRAPPEL DE PRUDENCE : avec seulement ' + avecRouge.size + ' matchs à rouge, ces chiffres bougent');
  console.log('énormément d\'un match à l\'autre. Ils disent si le modèle est GROSSIÈREMENT juste,');
  console.log('pas s\'il est rentable. Le seul juge de la rentabilité, c\'est la cote du marché.');
})().catch(e => { console.error('ERREUR', e); process.exit(1); });
