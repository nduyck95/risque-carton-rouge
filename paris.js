// ============================================================================
//  paris.js — LE BOT, en mode SIMULATION.
//
//  Toutes les 30 secondes environ, pendant les matchs en cours :
//    1. il lit l'etat du match chez ESPN (minute, jaunes, score, arbitre) ;
//    2. il demande au modele la probabilite de finir SANS carton rouge ;
//    3. il lit la cote reellement disponible sur Betfair (marche "carton rouge") ;
//    4. il applique TOUTES les conditions de config-paris.json ;
//    5. si ca passe, il NOTE le pari qu'il aurait pris (mise, cote, minute...) ;
//    6. quand le match est fini, il note s'il aurait gagne ou perdu, et combien.
//
//  AUCUN ARGENT N'EST ENGAGE. Il n'y a pas une seule ligne de code capable de
//  placer un pari reel dans ce fichier : betfair.js ne sait que LIRE des cotes.
//
//  Fichier de resultats : donnees/paris-simules.json
//  Bouton d'arret d'urgence : creer un fichier vide nomme STOP a cote de ce fichier.
// ============================================================================
const fs = require('fs');
const path = require('path');
const M = require('./modele.js');
const F = require('./fournisseurs.js');
const BF = require('./betfair.js');

const FICHIER_CONFIG = path.join(__dirname, 'config-paris.json');
const FICHIER_PARIS = path.join(__dirname, 'donnees', 'paris-simules.json');
const FICHIER_STOP = path.join(__dirname, 'STOP');

// ---------------------------------------------------------------------------
//  Lecture / ecriture des fichiers
// ---------------------------------------------------------------------------
function lireJson(f, defaut = null) {
  try {
    let t = fs.readFileSync(f, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch (e) { return defaut; }
}
function config() {
  const c = lireJson(FICHIER_CONFIG, {});
  return {
    mode: 'simulation', // verrouille : on ne parie pas d'argent reel depuis ce fichier
    capital: 200, kellyFraction: 0.25, commission: 0.05,
    edgeMini: 0.03, coteMini: 1.08, coteMaxi: 12,
    miseMini: 2, miseMaxi: 20, liquiditeMini: 20, spreadMaxi: 0.15,
    minuteMini: 10, minuteMaxi: 80, echantillonMini: 60,
    fraicheurMaxSec: 120, attenteApresCarteMin: 3,
    maxParisParMatch: 2, maxParisParJour: 10, cooldownMin: 10,
    perteMaxJour: 30, perteMaxTotale: 100,
    ligues: [0, 1, 2], sens: 'les_deux',
    ...c,
    mode: 'simulation',
  };
}
function etatVide() {
  return { version: 1, cree: new Date().toISOString(), majAt: null, paris: [], journal: [], arret: null };
}
function chargeParis() { return lireJson(FICHIER_PARIS, null) || etatVide(); }
function sauveParis(etat) {
  etat.majAt = new Date().toISOString();
  fs.writeFileSync(FICHIER_PARIS, JSON.stringify(etat, null, 1), 'utf8');
}

// ---------------------------------------------------------------------------
//  Argent : Kelly fractionne, commission comprise
// ---------------------------------------------------------------------------
// Avantage net par euro mise, commission Betfair deduite des gains.
//   gain si ca passe : (cote - 1) x (1 - commission)      perte sinon : 1
function avantage(p, cote, commission) {
  const b = (cote - 1) * (1 - commission);
  return p * b - (1 - p);
}
// Fraction de Kelly optimale (puis on n'en prend qu'une fraction : kellyFraction)
function kelly(p, cote, commission) {
  const b = (cote - 1) * (1 - commission);
  if (b <= 0) return 0;
  return (p * b - (1 - p)) / b;
}
function miseKelly(p, cote, cfg) {
  const f = kelly(p, cote, cfg.commission);
  if (f <= 0) return 0;
  const brute = f * cfg.kellyFraction * cfg.capital;
  return Math.round(Math.min(cfg.miseMaxi, Math.max(0, brute)) * 100) / 100;
}

// ---------------------------------------------------------------------------
//  LA DECISION — fonction pure (aucun acces reseau) donc testable a froid.
//  Renvoie { parie:false, refus:[raisons...] } ou { parie:true, pari:{...} }
// ---------------------------------------------------------------------------
function decide(ctx, cfg) {
  const { il, minute, jaunes, dejaRouge, n, pNo, cotes, ageSec, derniereCarteMin,
    parisDejaCeMatch, dernierPariMin, parisAujourdhui, plJour, plTotal } = ctx;
  const refus = [];

  // --- garde-fous globaux : on coupe tout ---
  if (fs.existsSync(FICHIER_STOP)) refus.push('fichier STOP présent (arrêt manuel)');
  if (plJour <= -cfg.perteMaxJour) refus.push(`perte du jour atteinte (${plJour.toFixed(2)} €)`);
  if (plTotal <= -cfg.perteMaxTotale) refus.push(`perte totale atteinte (${plTotal.toFixed(2)} €)`);
  if (parisAujourdhui >= cfg.maxParisParJour) refus.push(`déjà ${parisAujourdhui} paris aujourd'hui (max ${cfg.maxParisParJour})`);

  // --- garde-fous du match ---
  if (!cfg.ligues.includes(il)) refus.push('championnat désactivé');
  if (dejaRouge) refus.push('un rouge est déjà tombé : le marché est tranché');
  if (minute == null) refus.push('minute de jeu inconnue');
  else if (minute < cfg.minuteMini) refus.push(`trop tôt (${minute}' < ${cfg.minuteMini}')`);
  else if (minute > cfg.minuteMaxi) refus.push(`trop tard (${minute}' > ${cfg.minuteMaxi}')`);
  if (pNo == null) refus.push('le modèle ne sait pas estimer cet état');
  if (n != null && n < cfg.echantillonMini) refus.push(`échantillon historique trop mince (n=${n} < ${cfg.echantillonMini})`);

  // --- garde-fou de RETARD : le plus important en direct ---
  if (ageSec == null) refus.push('fraîcheur des données inconnue');
  else if (ageSec > cfg.fraicheurMaxSec) refus.push(`données trop vieilles (${Math.round(ageSec)} s > ${cfg.fraicheurMaxSec} s)`);

  // --- garde-fou anti « carton tout juste tombé » ---
  if (derniereCarteMin != null && minute != null && (minute - derniereCarteMin) < cfg.attenteApresCarteMin) {
    refus.push(`carton il y a moins de ${cfg.attenteApresCarteMin}' (le marché a bougé avant nous)`);
  }

  // --- limites par match ---
  if (parisDejaCeMatch >= cfg.maxParisParMatch) refus.push(`déjà ${parisDejaCeMatch} pari(s) sur ce match (max ${cfg.maxParisParMatch})`);
  if (dernierPariMin != null && minute != null && (minute - dernierPariMin) < cfg.cooldownMin) {
    refus.push(`dernier pari il y a moins de ${cfg.cooldownMin}'`);
  }

  // --- les cotes ---
  if (!cotes) refus.push('pas de cote disponible (marché introuvable ou Betfair non configuré)');
  else {
    if (cotes.statut && cotes.statut !== 'OPEN') refus.push(`marché ${cotes.statut} (suspendu/fermé)`);
    if (cotes.spreadNon != null && cotes.coteNon) {
      const rel = cotes.spreadNon / cotes.coteNon;
      if (rel > cfg.spreadMaxi) refus.push(`écart acheteur/vendeur trop large (${(rel * 100).toFixed(1)} %)`);
    }
  }

  if (refus.length) return { parie: false, refus };

  // --- On compare les deux sens et on garde le meilleur ---
  const candidats = [];
  const veutNon = cfg.sens === 'les_deux' || cfg.sens === 'pas_de_rouge';
  const veutOui = cfg.sens === 'les_deux' || cfg.sens === 'rouge';
  if (veutNon && cotes.coteNon) candidats.push({ sens: 'Pas de rouge', p: pNo, cote: cotes.coteNon, dispo: cotes.dispoNon });
  if (veutOui && cotes.coteOui) candidats.push({ sens: 'Rouge', p: 1 - pNo, cote: cotes.coteOui, dispo: cotes.dispoOui });

  const evalues = candidats.map(c => ({
    ...c,
    edge: avantage(c.p, c.cote, cfg.commission),
    mise: miseKelly(c.p, c.cote, cfg),
    coteEquitable: c.p > 0 ? 1 / c.p : null,
  })).sort((a, b) => b.edge - a.edge);

  if (!evalues.length) return { parie: false, refus: ['aucun sens de pari autorisé par la configuration'] };
  const meilleur = evalues[0];

  // --- conditions finales sur le pari retenu ---
  const refus2 = [];
  if (meilleur.edge < cfg.edgeMini) {
    refus2.push(`avantage insuffisant (${(meilleur.edge * 100).toFixed(1)} % < ${(cfg.edgeMini * 100).toFixed(1)} %)`);
  }
  if (meilleur.cote < cfg.coteMini) refus2.push(`cote trop basse (${meilleur.cote} < ${cfg.coteMini})`);
  if (meilleur.cote > cfg.coteMaxi) refus2.push(`cote trop haute (${meilleur.cote} > ${cfg.coteMaxi})`);
  if (meilleur.dispo < cfg.liquiditeMini) refus2.push(`liquidité insuffisante (${meilleur.dispo} € < ${cfg.liquiditeMini} €)`);
  if (meilleur.mise < cfg.miseMini) refus2.push(`mise calculée trop faible (${meilleur.mise} € < ${cfg.miseMini} €)`);
  if (refus2.length) return { parie: false, refus: refus2, meilleur };

  // On ne mise jamais plus que ce qui est réellement disponible à cette cote.
  const mise = Math.round(Math.min(meilleur.mise, meilleur.dispo) * 100) / 100;

  return {
    parie: true,
    pari: {
      sens: meilleur.sens, cote: meilleur.cote, mise,
      pModele: meilleur.p, coteEquitable: meilleur.coteEquitable,
      edge: meilleur.edge, kellyBrut: kelly(meilleur.p, meilleur.cote, cfg.commission),
      dispo: meilleur.dispo,
    },
    autres: evalues.slice(1),
  };
}

// ---------------------------------------------------------------------------
//  Rapprochement des matchs ESPN <-> Betfair (noms differents des deux cotes)
// ---------------------------------------------------------------------------
function trouveEvenementBetfair(matchEspn, evsBetfair) {
  const tHome = F.normEquipe(matchEspn.home).concat(F.normEquipe(matchEspn.homeCourt || ''));
  const tAway = F.normEquipe(matchEspn.away).concat(F.normEquipe(matchEspn.awayCourt || ''));
  let best = null, bestScore = 0;
  for (const ev of evsBetfair) {
    const parts = String(ev.nom || '').split(/\s+v\s+/i);
    if (parts.length !== 2) continue;
    const s = F.jaccard(tHome, F.normEquipe(parts[0])) + F.jaccard(tAway, F.normEquipe(parts[1]));
    if (s > bestScore) { bestScore = s; best = ev; }
  }
  return bestScore >= 1.0 ? best : null; // bonne correspondance exigée des DEUX côtés
}

// ---------------------------------------------------------------------------
//  Contexte historique : positions au classement + arbitre designe
//  (on reutilise la memoire deja constituee par moteur.js, pas de reseau)
// ---------------------------------------------------------------------------
function infosMemorisees(idEspn) {
  const etat = lireJson(path.join(__dirname, 'donnees', 'saison-courante.json'), null);
  if (!etat || !etat.ligues) return {};
  for (const L of etat.ligues) {
    const m = (L.matchs || []).find(x => x.id === idEspn);
    if (m) return { arbitre: m.arbitre || '', il: L.il, gapPre: m.prediction?.gap ?? null, pPre: m.prediction?.pNo ?? null };
  }
  return {};
}

// ---------------------------------------------------------------------------
//  UN TOUR DE BOUCLE
// ---------------------------------------------------------------------------
async function tick(journal = []) {
  const dit = (s) => { journal.push(s); };
  const cfg = config();
  const etat = chargeParis();

  if (fs.existsSync(FICHIER_STOP)) {
    dit('ARRÊT : le fichier STOP est présent. Supprime-le pour relancer le bot.');
    etat.arret = 'fichier STOP';
    sauveParis(etat);
    return { etat, live: 0, decisions: [] };
  }
  etat.arret = null;

  // Bilan courant (sert aux garde-fous de perte)
  const bilan = statistiques(etat);
  const jourAuj = new Date().toISOString().slice(0, 10);
  const plJour = etat.paris.filter(p => p.resultat && p.ts.slice(0, 10) === jourAuj)
    .reduce((s, p) => s + p.resultat.pl, 0);
  const parisAujourdhui = etat.paris.filter(p => p.ts.slice(0, 10) === jourAuj).length;

  // 1) Les matchs en cours, ligue par ligue
  const enCours = [];
  for (const meta of F.LIGUES_META) {
    if (!cfg.ligues.includes(meta.il)) continue;
    try {
      const live = await F.espnLiveLigue(meta.espn);
      for (const m of live) enCours.push({ ...m, il: meta.il, code: meta.espn, ligue: meta.nom });
    } catch (e) { dit(`${meta.nom} : lecture ESPN impossible (${e.message}).`); }
  }
  dit(`${enCours.length} match(s) en cours.`);
  if (!enCours.length) { sauveParis(etat); return { etat, live: 0, decisions: [] }; }

  // 2) Les cotes Betfair (une seule connexion pour tout le tour)
  const bfPret = BF.etatConfig().pret;
  let evsBetfair = [];
  if (bfPret) {
    try {
      const comps = await BF.competitions();
      for (const c of comps) {
        if (!cfg.ligues.includes(c.il)) continue;
        const evs = await BF.evenements(c.id, 4, 6);
        for (const ev of evs) evsBetfair.push({ ...ev, il: c.il });
      }
      dit(`Betfair : ${evsBetfair.length} match(s) trouvé(s) autour de maintenant.`);
    } catch (e) { dit(`Betfair indisponible : ${e.message}`); }
  } else {
    dit(`Betfair non configuré (${BF.etatConfig().raison}) : le bot observe et explique, mais ne peut pas chiffrer de pari.`);
  }

  // 3) Match par match : etat live -> modele -> cote -> decision
  const decisions = [];
  for (const m of enCours) {
    try {
      const cartes = await F.espnCartesLive(m.code, m.id);
      await F.pause(120);
      const memo = infosMemorisees(m.id);
      const arbitre = memo.arbitre || cartes.arbitre || '';
      const minute = m.minute != null ? m.minute : cartes.minuteSummary;

      const pr = M.predireLive(m.il, {
        home: m.home, away: m.away, arbitre,
        posA: null, posB: null, // le gap pre-match est deja porte par la memoire ; on reste prudent en live
        minute, jaunes: cartes.jaunes, butsA: m.butsA, butsB: m.butsB,
        dejaRouge: cartes.dejaRouge,
      });

      // Cote Betfair pour ce match
      let cotes = null, evBf = null, marche = null;
      if (bfPret) {
        evBf = trouveEvenementBetfair(m, evsBetfair.filter(e => e.il === m.il));
        if (evBf) {
          marche = await BF.marcheCarton(evBf.id);
          if (marche) cotes = await BF.prixMarche(marche);
        }
      }

      // Historique de nos paris sur ce match
      const miens = etat.paris.filter(p => p.idEspn === m.id);
      const dernierPariMin = miens.length ? Math.max(...miens.map(p => p.minute)) : null;
      const ageSec = (Date.now() - new Date(cartes.lu).getTime()) / 1000;

      const d = decide({
        il: m.il, minute, jaunes: cartes.jaunes, dejaRouge: cartes.dejaRouge,
        n: pr.n, pNo: pr.pNo, cotes, ageSec, derniereCarteMin: cartes.derniereCarteMin,
        parisDejaCeMatch: miens.length, dernierPariMin,
        parisAujourdhui, plJour, plTotal: bilan.pl,
      }, cfg);

      const ligne = {
        match: `${m.home} - ${m.away}`, ligue: m.ligue, minute, jaunes: cartes.jaunes,
        score: `${m.butsA}-${m.butsB}`, arbitre: arbitre || null,
        pNo: pr.pNo, coteEquitable: pr.coteEquitable, n: pr.n, dejaRouge: cartes.dejaRouge,
        cotes: cotes ? { coteNon: cotes.coteNon, coteOui: cotes.coteOui, dispoNon: cotes.dispoNon, dispoOui: cotes.dispoOui, statut: cotes.statut, inplay: cotes.inplay } : null,
        betfairTrouve: !!evBf, marcheTrouve: !!marche,
        ageSec: Math.round(ageSec),
        parie: d.parie, refus: d.refus || null,
        meilleurEvalue: d.meilleur ? { sens: d.meilleur.sens, cote: d.meilleur.cote, edge: d.meilleur.edge } : null,
      };
      decisions.push(ligne);

      if (d.parie) {
        const pari = {
          id: `${m.id}-${Date.now()}`,
          ts: new Date().toISOString(),
          idEspn: m.id, il: m.il, ligue: m.ligue, code: m.code,
          match: `${m.home} - ${m.away}`, home: m.home, away: m.away,
          minute, jaunes: cartes.jaunes, score: `${m.butsA}-${m.butsB}`, arbitre: arbitre || null,
          sens: d.pari.sens, cote: d.pari.cote, mise: d.pari.mise,
          pModele: d.pari.pModele, coteEquitable: d.pari.coteEquitable,
          edge: d.pari.edge, kellyBrut: d.pari.kellyBrut,
          liquiditeDispo: d.pari.dispo, source: cotes.source, marketId: cotes.marketId,
          ageDonneesSec: Math.round(ageSec),
          simule: true,
          resultat: null,
        };
        etat.paris.push(pari);
        dit(`★ PARI SIMULÉ : ${pari.match} ${minute}' — ${pari.sens} @ ${pari.cote} pour ${pari.mise} € (avantage ${(pari.edge * 100).toFixed(1)} %).`);
      } else {
        dit(`${m.home} - ${m.away} ${minute}' (${cartes.jaunes} jaunes) : pas de pari — ${(d.refus || []).join(' ; ')}.`);
      }
    } catch (e) {
      dit(`${m.home} - ${m.away} : erreur (${e.message}).`);
    }
  }

  // 4) Regler les paris dont le match est termine
  const regles = await regleParis(etat, dit);
  etat.journal = journal.slice(-200);
  sauveParis(etat);
  return { etat, live: enCours.length, decisions, regles };
}

// ---------------------------------------------------------------------------
//  REGLEMENT : le match est fini, aurions-nous gagne ?
// ---------------------------------------------------------------------------
async function regleParis(etat, dit = () => {}) {
  const cfg = config();
  const ouverts = etat.paris.filter(p => !p.resultat);
  if (!ouverts.length) return 0;
  const parMatch = new Map();
  for (const p of ouverts) {
    if (!parMatch.has(p.idEspn)) parMatch.set(p.idEspn, []);
    parMatch.get(p.idEspn).push(p);
  }
  let regles = 0;
  for (const [idEspn, lot] of parMatch) {
    // On ne regle qu'au moins 2 h apres le coup d'envoi note (le match est fini)
    const assezVieux = Date.now() - new Date(lot[0].ts).getTime() > 2 * 3600 * 1000;
    if (!assezVieux) continue;
    try {
      const det = await F.espnDetail(lot[0].code, idEspn);
      if (!det.termine || det.aRouge == null) continue;
      for (const p of lot) {
        const gagne = (p.sens === 'Pas de rouge') ? !det.aRouge : !!det.aRouge;
        const pl = gagne
          ? Math.round(p.mise * (p.cote - 1) * (1 - cfg.commission) * 100) / 100
          : -p.mise;
        p.resultat = { termine: true, aRouge: det.aRouge, gagne, pl, regleLe: new Date().toISOString() };
        regles++;
        dit(`Réglé : ${p.match} — ${p.sens} @ ${p.cote} → ${gagne ? 'GAGNÉ' : 'perdu'} ${pl > 0 ? '+' : ''}${pl} €.`);
      }
      await F.pause(150);
    } catch (e) { /* on reessaiera au prochain tour */ }
  }
  return regles;
}

// ---------------------------------------------------------------------------
//  BILAN
// ---------------------------------------------------------------------------
function statistiques(etat) {
  const cfg = config();
  const tous = etat.paris || [];
  const regles = tous.filter(p => p.resultat);
  const mise = regles.reduce((s, p) => s + p.mise, 0);
  const pl = regles.reduce((s, p) => s + p.resultat.pl, 0);
  const gagnes = regles.filter(p => p.resultat.gagne).length;
  // Calibration : le modele annonce-t-il les bonnes probabilites ?
  const pMoyenne = regles.length ? regles.reduce((s, p) => s + p.pModele, 0) / regles.length : null;
  const tauxReel = regles.length ? gagnes / regles.length : null;
  return {
    nbParis: tous.length, nbRegles: regles.length, nbOuverts: tous.length - regles.length,
    miseTotale: Math.round(mise * 100) / 100,
    pl: Math.round(pl * 100) / 100,
    roi: mise > 0 ? pl / mise : null,
    gagnes, perdus: regles.length - gagnes,
    pModeleMoyenne: pMoyenne, tauxReussiteReel: tauxReel,
    capitalDepart: cfg.capital,
    capitalSimule: Math.round((cfg.capital + pl) * 100) / 100,
  };
}

module.exports = {
  tick, decide, statistiques, chargeParis, config, regleParis,
  avantage, kelly, miseKelly, trouveEvenementBetfair,
  FICHIER_PARIS, FICHIER_STOP, FICHIER_CONFIG,
};

// Lancement a la main : node paris.js
if (require.main === module) {
  const journal = [];
  tick(journal)
    .then((r) => {
      journal.forEach(l => console.log(l));
      console.log('---');
      console.log('BILAN :', JSON.stringify(statistiques(r.etat), null, 1));
    })
    .catch(e => { console.error('ERREUR', e); process.exit(1); });
}
