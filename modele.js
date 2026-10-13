// ============================================================================
//  modele.js — Le "cerveau" de la prédiction AVANT-MATCH, côté Node.
//  Réutilise EXACTEMENT la méthodologie de la page live (index.html), mais
//  pour un match qui n'a pas encore commencé :
//    - pas de temps écoulé  (on se place à la minute 0)
//    - pas de jaunes déjà donnés (0 jaune)
//    - pas de score en cours (facteur score neutre)
//  Il reste : taux de base de la ligue  ×  arbitre  ×  agressivité des équipes
//             ×  écart de classement (quand il est connu, ≥ journée 6).
//
//  Ce fichier ne va sur aucun site : il ne fait que du calcul sur les données
//  déjà collectées dans le dossier "donnees".
// ============================================================================
const fs = require('fs');
const path = require('path');

const DONNEES = path.join(__dirname, 'donnees');

// Les fichiers JSON écrits par PowerShell commencent souvent par un caractère
// invisible (BOM). On le retire avant de lire, sinon JSON.parse plante.
function lireJson(fichier) {
  let txt = fs.readFileSync(fichier, 'utf8');
  if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
  return JSON.parse(txt);
}

// ---------------------------------------------------------------------------
//  1) Reconstruire les données des 3 ligues (même logique que assemble.ps1)
//     LIGUES[i] = { nom, arbitres:[noms...], matchs:[[iArbitre, [[minute, estRouge], ...]], ...] }
// ---------------------------------------------------------------------------
const SAISONS_MODELE = ['2023-24', '2024-25', '2025-26'];

function parseCartons(cartons) {
  const evts = [];
  for (const c of (cartons || [])) {
    if (!c || !c.minute) continue;
    const m = /^(\d+)'(?:\+(\d+)')?/.exec(c.minute);
    if (!m) continue;
    const t = parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / 100 : 0);
    const estRouge = /Red/i.test(c.type || '') ? 1 : 0;
    evts.push([t, estRouge]);
  }
  return evts;
}

function construitLigue(nom, sousDossier, arbitreInterne) {
  const dossier = sousDossier ? path.join(DONNEES, sousDossier) : DONNEES;
  let brut = [];
  for (const s of SAISONS_MODELE) {
    const f = path.join(dossier, `saison-${s}.json`);
    if (fs.existsSync(f)) brut = brut.concat(lireJson(f));
  }
  // Table id -> nom d'arbitre pour la Premier League (fichier fusionné ESPN + football-data)
  let arbPL = {};
  if (!arbitreInterne) {
    const tbl = lireJson(path.join(DONNEES, 'arbitres-final.json'));
    for (const [id, v] of Object.entries(tbl)) {
      const n = String(v || '').trim();
      if (n) arbPL[id] = n;
    }
  }
  const nomArbitre = (m) => (arbitreInterne ? String(m.arbitre || '').trim() : (arbPL[String(m.id)] || '')).trim();

  // Liste triée des arbitres connus
  const noms = new Set();
  for (const m of brut) { if (m.erreur) continue; const a = nomArbitre(m); if (a) noms.add(a); }
  const arbitres = [...noms].sort((a, b) => a.localeCompare(b));
  const indexNom = new Map(arbitres.map((n, i) => [n, i]));

  const matchs = [];
  for (const m of brut) {
    if (m.erreur) continue;
    const evts = parseCartons(m.cartons);
    const a = nomArbitre(m);
    const ia = (a && indexNom.has(a)) ? indexNom.get(a) : -1;
    matchs.push([ia, evts]);
  }
  return { nom, arbitres, matchs };
}

// ---------------------------------------------------------------------------
//  2) Charger toutes les constantes du modèle (une seule fois)
// ---------------------------------------------------------------------------
const LIGUES = [
  construitLigue('Premier League', '', false),
  construitLigue('Liga', 'esp1', true),
  construitLigue('Serie A', 'ita1', true),
];
const CLASSEMENT = lireJson(path.join(DONNEES, 'classement-coeffs.json'));
const EQUIPES = lireJson(path.join(DONNEES, 'equipes.json'));
const REGLAGES = lireJson(path.join(DONNEES, 'reglages-ligues.json'));
// Facteur « score en cours de match » : multiplicateurs par [mi-temps][écart 0/1/2+].
// Ne sert qu'au modèle LIVE (avant le coup d'envoi, il n'y a pas encore de score).
const SCORE = lireJson(path.join(DONNEES, 'score-facteurs.json'));

// Index nom d'équipe (dans equipes.json) -> position dans le tableau
const INDEX_EQUIPE = EQUIPES.map(l => new Map(l.equipes.map((e, i) => [e.nom, i])));

// ---------------------------------------------------------------------------
//  3) Le modèle (copie fidèle des fonctions de index.html)
// ---------------------------------------------------------------------------
const NB_TRANCHES = 6;
function trancheDe(t) {
  const tf = Math.floor(t);
  return tf <= 15 ? 0 : tf <= 30 ? 1 : tf <= 45 ? 2 : tf <= 60 ? 3 : tf <= 75 ? 4 : 5;
}
const cacheCtx = [];
function contexte(il) {
  if (cacheCtx[il]) return cacheCtx[il];
  const L = LIGUES[il];
  const stats = L.arbitres.map(nom => ({ nom, matchs: 0, rouges: 0, matchsRouge: 0 }));
  const global = { matchs: L.matchs.length, matchsRouge: 0 };
  for (const [ia, evts] of L.matchs) {
    const s = ia >= 0 ? stats[ia] : null;
    if (s) s.matchs++;
    let rouge = false;
    for (const [, estRouge] of evts) if (estRouge) rouge = true;
    if (rouge) { global.matchsRouge++; if (s) s.matchsRouge++; }
  }
  const ctx = { nom: L.nom, matchs: L.matchs, stats, global, taux: global.matchsRouge / global.matchs };
  cacheCtx[il] = ctx;
  return ctx;
}

function facteurArbitre(il, ia) {
  if (ia < 0) return 1;
  const arbP = REGLAGES[il].arbP;
  if (arbP === 0) return 1; // ligue où l'arbitre ne prédit rien (Serie A)
  const ctx = contexte(il);
  const s = ctx.stats[ia];
  const taux = (s.matchsRouge + arbP * ctx.taux) / (s.matchs + arbP);
  return taux / ctx.taux;
}

function etatALaMinute(evts, t) {
  let jaunes = 0, rouge = false;
  for (const [tm, estRouge] of evts) if (tm <= t) { if (estRouge) rouge = true; else jaunes++; }
  return { jaunes, rouge };
}
function aUnRouge(evts) { for (const ev of evts) if (ev[1]) return true; return false; }
function estime(ctx, t, k) {
  let n = 0, sans = 0;
  for (const m of ctx.matchs) {
    const s = etatALaMinute(m[1], t);
    if (!s.rouge && s.jaunes === k) { n++; if (!aUnRouge(m[1])) sans++; }
  }
  return { n, sans };
}
const SEUIL = 40;
function estimeRobuste(ctx, t, k) {
  const exact = estime(ctx, t, k);
  if (exact.n >= SEUIL) return { p: exact.sans / exact.n, n: exact.n };
  let n = 0, sans = 0;
  for (let kk = Math.max(0, k - 1); kk <= k + 1; kk++) { const e = estime(ctx, t, kk); n += e.n; sans += e.sans; }
  if (n >= SEUIL) return { p: sans / n, n };
  n = 0; sans = 0;
  for (let tt = Math.max(0, t - 3); tt <= Math.min(90, t + 3); tt++)
    for (let kk = Math.max(0, k - 1); kk <= k + 1; kk++) { const e = estime(ctx, tt, kk); n += e.n; sans += e.sans; }
  if (n > 0) return { p: sans / n, n };
  return { p: null, n: 0 };
}

function facteurClassement(il, gap) {
  if (gap === null || gap === undefined) return 1;
  const c = CLASSEMENT[il];
  const p = 1 / (1 + Math.exp(-(c.b0 + c.b1 * gap)));
  return p / c.taux;
}
function facteurEquipes(il, aggX) {
  if (aggX === null || aggX === undefined) return 1;
  const c = EQUIPES[il].coeffs;
  const p = 1 / (1 + Math.exp(-(c.c0 + c.c1 * aggX)));
  return p / c.taux;
}
// Multiplicateur lié à l'écart au score en cours (0, 1, 2 buts et plus), selon la mi-temps.
// Actif SEULEMENT dans les ligues où le backtest le valide (scoreActif = Liga uniquement).
function facteurScore(il, marge, t) {
  if (marge === null || marge === undefined) return 1;
  if (!REGLAGES[il].scoreActif) return 1;
  return SCORE[il].periodes[t <= 45 ? 0 : 1][Math.min(2, marge)];
}

// ---------------------------------------------------------------------------
//  4) Correspondance des noms d'équipes ESPN -> equipes.json (noms francisés)
//     Les noms non listés (promus récents) renvoient null => profil "promu".
// ---------------------------------------------------------------------------
const MAP_ESPN = [
  { // Premier League
    'AFC Bournemouth': 'Bournemouth', 'Arsenal': 'Arsenal', 'Aston Villa': 'Aston Villa',
    'Brentford': 'Brentford', 'Brighton & Hove Albion': 'Brighton', 'Chelsea': 'Chelsea',
    'Coventry City': null, 'Crystal Palace': 'Crystal Palace', 'Everton': 'Everton',
    'Fulham': 'Fulham', 'Hull City': null, 'Ipswich Town': 'Ipswich Town',
    'Leeds United': 'Leeds United', 'Liverpool': 'Liverpool', 'Manchester City': 'Manchester City',
    'Manchester United': 'Manchester United', 'Newcastle United': 'Newcastle',
    'Nottingham Forest': 'Nottingham Forest', 'Sunderland': 'Sunderland', 'Tottenham Hotspur': 'Tottenham',
    // équipes des 3 saisons pouvant réapparaître :
    'Burnley': 'Burnley', 'Leicester City': 'Leicester City', 'Luton Town': 'Luton Town',
    'Sheffield United': 'Sheffield United', 'Southampton': 'Southampton', 'West Ham United': 'West Ham',
    'Wolverhampton Wanderers': 'Wolverhampton',
  },
  { // Liga
    'Alavés': 'Alavés', 'Athletic Club': 'Athletic Bilbao', 'Atlético Madrid': 'Atlético Madrid',
    'Barcelona': 'Barcelona', 'Celta Vigo': 'Celta Vigo', 'Deportivo': null, 'Elche': 'Elche',
    'Espanyol': 'Espanyol', 'Getafe': 'Getafe', 'Levante': 'Levante', 'Málaga': null,
    'Osasuna': 'Osasuna', 'Racing Santander': null, 'Rayo Vallecano': 'Rayo Vallecano',
    'Real Betis': 'Real Betis', 'Real Madrid': 'Real Madrid', 'Real Sociedad': 'Real Sociedad',
    'Sevilla': 'Séville', 'Valencia': 'Valence', 'Villarreal': 'Villarreal',
    'Almería': 'Almería', 'Cádiz': 'Cadix', 'Girona': 'Girona', 'Granada': 'Grenade',
    'Las Palmas': 'Las Palmas', 'Leganés': 'Leganés', 'Mallorca': 'Majorque',
    'Real Oviedo': 'Real Oviedo', 'Real Valladolid': 'Valladolid',
  },
  { // Serie A
    'AC Milan': 'AC Milan', 'AS Roma': 'AS Roma', 'Atalanta': 'Atalanta', 'Bologna': 'Bologne',
    'Cagliari': 'Cagliari', 'Como': 'Como', 'Fiorentina': 'Fiorentina', 'Frosinone': 'Frosinone',
    'Genoa': 'Genoa', 'Internazionale': 'Inter', 'Juventus': 'Juventus', 'Lazio': 'Lazio',
    'Lecce': 'Lecce', 'Monza': 'Monza', 'Napoli': 'Naples', 'Parma': 'Parme', 'Sassuolo': 'Sassuolo',
    'Torino': 'Torino', 'Udinese': 'Udinese', 'Venezia': 'Venise',
    'Cremonese': 'Cremonese', 'Empoli': 'Empoli', 'Hellas Verona': 'Hellas Vérone',
    'Pisa': 'Pise', 'Salernitana': 'Salernitana',
  },
];

// Agressivité d'une équipe ESPN dans une ligue : renvoie {agg, connue, promu}
function aggEquipe(il, nomEspn) {
  const map = MAP_ESPN[il];
  const cible = Object.prototype.hasOwnProperty.call(map, nomEspn) ? map[nomEspn] : undefined;
  const L = EQUIPES[il];
  if (cible && INDEX_EQUIPE[il].has(cible)) {
    return { agg: L.equipes[INDEX_EQUIPE[il].get(cible)].agg, connue: true, promu: false, nomData: cible };
  }
  // Promu (ou nom inconnu) => profil moyen des promus de la ligue
  return { agg: L.promu.agg, connue: false, promu: true, nomData: null };
}

// Retrouver l'index d'un arbitre à partir d'un nom scrappé (comparaison souple)
function normNom(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}
function indexArbitre(il, nomArbitre) {
  if (!nomArbitre) return -1;
  const cible = normNom(nomArbitre);
  if (!cible) return -1;
  const arbs = LIGUES[il].arbitres;
  let iExact = arbs.findIndex(a => normNom(a) === cible);
  if (iExact >= 0) return iExact;
  // Repli : nom de famille commun (dernier mot)
  const famille = cible.slice(-Math.min(cible.length, 12));
  for (let i = 0; i < arbs.length; i++) {
    const a = normNom(arbs[i]);
    if (a && (a.includes(cible) || cible.includes(a))) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
//  4bis) DERBIES : les derbies génèrent plus de cartons rouges.
//   Mesuré sur les 3 dernières saisons (donnees\saison-*.json) : le taux de
//   matchs avec rouge en derby vs la moyenne de la ligue est PL ×1,56 (13/68),
//   Liga ×1,01 (11/52), Serie A ×1,64 (10/38). Échantillon modeste → on AMORTIT
//   vers la moyenne (prudence 30 matchs fictifs au taux de ligue), comme pour
//   l'arbitre. Multiplicateurs amortis obtenus : PL 1,386 · Liga 1,008 · Serie A 1,357.
//   (Liga ≈ 1 : les derbies n'y ajoutent quasiment rien — dit honnêtement.)
// ---------------------------------------------------------------------------
const DERBY_MULT = [1.386, 1.008, 1.357]; // par ligue [PL, Liga, Serie A]
const DERBIES = [
  [ // Premier League (noms ESPN)
    ['Manchester City', 'Manchester United', 'Derby de Manchester'],
    ['Arsenal', 'Tottenham Hotspur', 'Derby du nord de Londres'],
    ['Liverpool', 'Everton', 'Derby de la Mersey'],
    ['Newcastle United', 'Sunderland', 'Derby Tyne-Wear'],
    ['Aston Villa', 'Wolverhampton Wanderers', 'Derby des Midlands'],
    ['Chelsea', 'Tottenham Hotspur', 'Derby de Londres'],
    ['Arsenal', 'Chelsea', 'Derby de Londres'],
    ['Tottenham Hotspur', 'West Ham United', 'Derby de Londres'],
    ['Arsenal', 'West Ham United', 'Derby de Londres'],
    ['Chelsea', 'West Ham United', 'Derby de Londres'],
    ['Crystal Palace', 'Brighton & Hove Albion', 'Derby M23'],
    ['Liverpool', 'Manchester United', 'Derby du Nord-Ouest'],
  ],
  [ // Liga
    ['Real Madrid', 'Barcelona', 'El Clásico'],
    ['Real Madrid', 'Atlético Madrid', 'Derby de Madrid'],
    ['Atlético Madrid', 'Rayo Vallecano', 'Derby de Madrid'],
    ['Getafe', 'Rayo Vallecano', 'Derby de Madrid'],
    ['Sevilla', 'Real Betis', 'Derby de Séville'],
    ['Athletic Club', 'Real Sociedad', 'Derby basque'],
    ['Barcelona', 'Espanyol', 'Derby de Barcelone'],
    ['Espanyol', 'Girona', 'Derby catalan'],
    ['Valencia', 'Levante', 'Derby de Valence'],
    ['Valencia', 'Villarreal', 'Derby valencien'],
    ['Celta Vigo', 'Deportivo', 'Derby galicien'],
  ],
  [ // Serie A
    ['AC Milan', 'Internazionale', 'Derby de la Madonnina'],
    ['AS Roma', 'Lazio', 'Derby de Rome'],
    ['Juventus', 'Torino', 'Derby de Turin'],
    ['Juventus', 'Internazionale', "Derby d'Italie"],
    ['Napoli', 'AS Roma', 'Derby du Soleil'],
    ['Fiorentina', 'Empoli', 'Derby toscan'],
    ['Bologna', 'Parma', 'Derby émilien'],
  ],
];
// Est-ce un derby ? Renvoie { est, label, mult }
function infoDerby(il, homeEspn, awayEspn) {
  for (const [a, b, label] of DERBIES[il]) {
    if ((homeEspn === a && awayEspn === b) || (homeEspn === b && awayEspn === a)) {
      return { est: true, label, mult: DERBY_MULT[il] };
    }
  }
  return { est: false, label: null, mult: 1 };
}

// ---------------------------------------------------------------------------
//  5) LA fonction principale : probabilité "pas de carton rouge" AVANT le match
// ---------------------------------------------------------------------------
// Entrées :
//   il        : index de ligue (0 PL, 1 Liga, 2 Serie A)
//   homeEspn  : nom ESPN équipe à domicile
//   awayEspn  : nom ESPN équipe à l'extérieur
//   arbitre   : nom de l'arbitre scrappé (ou '' si inconnu)
//   posA,posB : positions au classement (ou null) ; gap appliqué seulement si fournies
// Sortie : détail complet (proba, cote équitable, facteurs, ce qui est connu/inconnu)
function predirePreMatch(il, homeEspn, awayEspn, arbitre, posA, posB) {
  const ctx = contexte(il);
  const base = estimeRobuste(ctx, 0, 0); // = 1 - taux de la ligue
  const pBase = base.p;

  const eA = aggEquipe(il, homeEspn);
  const eB = aggEquipe(il, awayEspn);
  const aggX = eA.agg + eB.agg;
  const fEquipes = facteurEquipes(il, aggX);

  const ia = indexArbitre(il, arbitre);
  const fArbitre = facteurArbitre(il, ia);
  const arbitreActif = REGLAGES[il].arbP !== 0;

  const gap = (posA && posB && posA !== posB) ? Math.abs(posA - posB) : null;
  const fClassement = facteurClassement(il, gap);

  const derby = infoDerby(il, homeEspn, awayEspn);
  const fDerby = derby.mult;

  const f = fArbitre * fEquipes * fClassement * fDerby;
  const risque = Math.min(0.97, (1 - pBase) * f);
  const pNo = 1 - risque;

  return {
    pNo,                                   // proba PAS de rouge (0..1)
    coteEquitable: pNo > 0 ? 1 / pNo : null, // cote juste "pas de rouge"
    pRouge: 1 - pNo,
    coteEquitableRouge: (1 - pNo) > 0 ? 1 / (1 - pNo) : null,
    pBase,
    facteurs: {
      arbitre: fArbitre, equipes: fEquipes, classement: fClassement, derby: fDerby,
    },
    derby,
    arbitre: {
      nom: arbitre || null,
      connu: ia >= 0,
      actifDansLigue: arbitreActif,       // false en Serie A (désactivé par backtest)
    },
    equipes: {
      home: { espn: homeEspn, ...eA },
      away: { espn: awayEspn, ...eB },
    },
    classement: { gap, applique: gap !== null },
  };
}

// ---------------------------------------------------------------------------
//  6) MODÈLE LIVE : probabilité "pas de carton rouge d'ici la fin" EN COURS DE MATCH
//     Même méthode que la page index.html : on part de la base empirique
//     "matchs qui étaient dans le même état (minute t, k jaunes, aucun rouge)
//     et qui ont fini sans rouge", puis on applique les mêmes multiplicateurs.
//
//  ATTENTION (important) : si un rouge est DÉJÀ tombé, la question ne se pose
//  plus — on renvoie dejaRouge:true et pNo = 0 (le marché "carton rouge" est
//  tranché). Le bot de paris doit refuser de parier dans ce cas.
// ---------------------------------------------------------------------------
// Entrées : etat = { home, away, arbitre, posA, posB, minute, jaunes, butsA, butsB }
function predireLive(il, etat) {
  const ctx = contexte(il);
  const t = Math.max(0, Math.min(90, Math.floor(Number(etat.minute) || 0)));
  const k = Math.max(0, Math.min(12, Math.floor(Number(etat.jaunes) || 0)));

  if (etat.dejaRouge) {
    return {
      dejaRouge: true, pNo: 0, pRouge: 1, coteEquitable: null, coteEquitableRouge: 1,
      minute: t, jaunes: k, pBase: null, n: 0, facteurs: null,
    };
  }

  const base = estimeRobuste(ctx, t, k);
  const pBase = base.p;
  if (pBase === null) {
    return { dejaRouge: false, pNo: null, pRouge: null, minute: t, jaunes: k, pBase: null, n: 0, facteurs: null };
  }

  const eA = aggEquipe(il, etat.home);
  const eB = aggEquipe(il, etat.away);
  const fEquipes = facteurEquipes(il, eA.agg + eB.agg);

  const ia = indexArbitre(il, etat.arbitre || '');
  const fArbitre = facteurArbitre(il, ia);

  const gap = (etat.posA && etat.posB && etat.posA !== etat.posB) ? Math.abs(etat.posA - etat.posB) : null;
  const fClassement = facteurClassement(il, gap);

  const derby = infoDerby(il, etat.home, etat.away);
  const fDerby = derby.mult;

  const marge = (etat.butsA != null && etat.butsB != null) ? Math.abs(etat.butsA - etat.butsB) : null;
  const fScore = facteurScore(il, marge, t);

  const f = fArbitre * fEquipes * fClassement * fDerby * fScore;
  const risque = Math.min(0.97, (1 - pBase) * f);
  const pNo = 1 - risque;

  return {
    dejaRouge: false,
    pNo,                                       // proba de finir SANS rouge, vu d'ici
    pRouge: 1 - pNo,
    coteEquitable: pNo > 0 ? 1 / pNo : null,   // cote juste "pas de rouge"
    coteEquitableRouge: (1 - pNo) > 0 ? 1 / (1 - pNo) : null,
    minute: t, jaunes: k, marge,
    pBase, n: base.n,                          // n = taille de l'échantillon historique utilisé
    facteurs: { arbitre: fArbitre, equipes: fEquipes, classement: fClassement, derby: fDerby, score: fScore },
    derby,
    arbitreConnu: ia >= 0,
    equipes: { home: { espn: etat.home, ...eA }, away: { espn: etat.away, ...eB } },
  };
}

module.exports = {
  LIGUES, EQUIPES, REGLAGES, CLASSEMENT, SCORE,
  predirePreMatch, predireLive, aggEquipe, indexArbitre, contexte, MAP_ESPN, infoDerby,
  estimeRobuste,
};
