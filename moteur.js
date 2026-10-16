// ============================================================================
//  moteur.js — Le chef d'orchestre.
//  Il assemble : la liste des matchs de la saison (ESPN) + la prédiction maison
//  (modele.js) + l'arbitre + le classement + les cotes bookmaker (fournisseurs.js),
//  détecte les "value bets", fige les matchs terminés avec leur résultat réel,
//  et sauvegarde tout dans donnees/saison-courante.json (la "mémoire").
// ============================================================================
const fs = require('fs');
const path = require('path');
const M = require('./modele.js');
const F = require('./fournisseurs.js');

const FICHIER_ETAT = path.join(__dirname, 'donnees', 'saison-courante.json');
const SEUIL_VALUE = 0.02;      // +2% d'espérance mini pour parler de "value bet"
const MAX_FIGE_PAR_FOIS = 80;  // borne le nb de matchs terminés traités par rafraîchissement
const MAX_CONFIRME_PAR_FOIS = 30; // borne le nb de résultats revérifiés par passage
// Délai après le coup d'envoi au bout duquel on considère qu'ESPN a fini de
// publier tous les évènements d'un match (cartons de la 90e compris).
// BUG CORRIGÉ le 07/09/2026 : un match était figé dès qu'ESPN le déclarait
// terminé, et ne l'était plus jamais revérifié. Un rouge à la 90e tombé juste
// après le gel restait invisible pour toujours (cas AS Roma-Atalanta du 05/09,
// enregistré "pas de rouge" alors qu'il y a eu un rouge à la 90e).
const DELAI_CONFIRMATION_MS = 3.5 * 3600 * 1000;

// Cotes Winamax lues par le PC de Nicolas (envoi-winamax.js), pour quand Winamax
// ne répond pas directement (cas des serveurs GitHub, bloqués par Winamax).
const FICHIER_WINAMAX_PC = path.join(__dirname, 'donnees', 'cotes-winamax.json');
const AGE_MAX_WINAMAX_PC_MS = 3 * 3600 * 1000;   // au-delà de 3 h, la cote est jugée trop ancienne

// Les matchs Winamax d'une ligue : en direct si Winamax répond, sinon depuis le fichier
// envoyé par le PC (s'il a moins de 3 h). Chaque match lu dans le fichier porte déjà sa cote.
async function evenementsWinamax(meta, dit) {
  const enDirect = await F.winamaxEvenements(meta.winamax);
  if (enDirect.length) {
    dit(`${meta.nom} : Winamax Espagne ${enDirect.length} matchs lus en direct.`);
    return enDirect;
  }
  const probleme = F.winamaxErreur() ? ` (problème : ${F.winamaxErreur()})` : '';
  let fichier = null;
  try {
    let t = fs.readFileSync(FICHIER_WINAMAX_PC, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    fichier = JSON.parse(t);
  } catch (e) { /* pas de fichier envoyé par le PC */ }
  if (!fichier || !fichier.maj) {
    dit(`${meta.nom} : Winamax Espagne ne répond pas${probleme} et aucun fichier du PC.`);
    return [];
  }
  const age = Date.now() - new Date(fichier.maj).getTime();
  const ageTexte = `${Math.round(age / 60000)} min`;
  if (!(age >= 0 && age <= AGE_MAX_WINAMAX_PC_MS)) {
    dit(`${meta.nom} : Winamax Espagne ne répond pas${probleme} ; fichier du PC trop ancien (${ageTexte}) → ignoré.`);
    return [];
  }
  const evs = (fichier.ligues?.[meta.il] || []).map(m => ({
    id: m.id, home: m.home, away: m.away, start: m.start,
    tokensHome: F.normEquipe(m.home), tokensAway: F.normEquipe(m.away),
    coteLue: { coteNon: m.coteNon || null, coteOui: m.coteOui || null, lu: fichier.maj },
  }));
  dit(`${meta.nom} : Winamax Espagne ne répond pas${probleme} → ${evs.length} cotes reprises du fichier du PC (lu il y a ${ageTexte}).`);
  return evs;
}

function resultatConfirmable(dateISO) {
  return Date.now() - new Date(dateISO).getTime() > DELAI_CONFIRMATION_MS;
}

function chargeEtat() {
  try {
    let t = fs.readFileSync(FICHIER_ETAT, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch (e) { return null; }
}
function sauveEtat(etat) {
  fs.writeFileSync(FICHIER_ETAT, JSON.stringify(etat, null, 1), 'utf8');
}

// Calcule le value bet à partir de la proba maison et des cotes du book
function calculeValueBet(pNo, cotes) {
  if (!cotes) return null;
  const edgeNon = cotes.coteNon ? pNo * cotes.coteNon - 1 : null;
  const edgeOui = cotes.coteOui ? (1 - pNo) * cotes.coteOui - 1 : null;
  const cands = [];
  if (edgeNon != null) cands.push({ mise: 'Pas de rouge', cote: cotes.coteNon, edge: edgeNon, pModele: pNo, source: cotes.sourceNon || cotes.source });
  if (edgeOui != null) cands.push({ mise: 'Rouge', cote: cotes.coteOui, edge: edgeOui, pModele: 1 - pNo, source: cotes.sourceOui || cotes.source });
  if (!cands.length) return null;
  cands.sort((a, b) => b.edge - a.edge);
  const meilleur = cands[0];
  return {
    mise: meilleur.mise,
    cote: meilleur.cote,
    coteEquitable: meilleur.pModele > 0 ? 1 / meilleur.pModele : null,
    edge: meilleur.edge,
    interessant: meilleur.edge >= SEUIL_VALUE,
    source: meilleur.source,
    edgeNon, edgeOui,
  };
}

// Va chercher la cote « carton rouge » sur chaque site (Unibet, Winamax Espagne)
// et garde, pour chaque côté (« pas de rouge » / « rouge »), la plus haute — avec le
// nom du site qui la propose. Renvoie null si aucun site ne cote ce match.
async function chercheCotes(match, kambiEvs, winamaxEvs) {
  const offres = [];
  const evK = F.trouveKambi(match, kambiEvs);
  if (evK) {
    const c = await F.kambiCotesCarton(evK.id);
    if (c && (c.coteNon || c.coteOui)) offres.push({ source: 'Unibet', ...c });
    await F.pause(120);
  }
  const evW = F.trouveWinamax(match, winamaxEvs);
  if (evW && evW.coteLue) {
    // Cote déjà lue par le PC (fichier cotes-winamax.json) : on note l'heure de lecture
    const c = evW.coteLue;
    if (c.coteNon || c.coteOui) offres.push({ source: 'Winamax', coteNon: c.coteNon, coteOui: c.coteOui, lu: c.lu });
  } else if (evW) {
    const c = await F.winamaxCotesCarton(evW.id);
    if (c && (c.coteNon || c.coteOui)) offres.push({ source: 'Winamax', ...c });
    await F.pause(300);
  }
  return combineCotes(offres);
}

function combineCotes(offres) {
  if (!offres.length) return null;
  // La plus haute cote d'un côté, et le(s) site(s) qui la proposent (ex-æquo : « Unibet = Winamax »)
  const meilleur = (cle) => {
    const max = Math.max(...offres.map(o => o[cle] || 0));
    if (!(max > 0)) return { cote: null, source: null };
    return { cote: max, source: offres.filter(o => o[cle] === max).map(o => o.source).join(' = ') };
  };
  const non = meilleur('coteNon'), oui = meilleur('coteOui');
  const sources = [...new Set(offres.map(o => o.source))];
  return {
    source: sources.join(' + '),
    coteNon: non.cote, sourceNon: non.source,
    coteOui: oui.cote, sourceOui: oui.source,
    // Marge en prenant la meilleure cote de chaque côté (peut descendre sous 0 si les 2 sites divergent fort)
    marge: (non.cote && oui.cote) ? (1 / non.cote + 1 / oui.cote - 1) : null,
    // lu = heure de lecture quand la cote vient du PC (sinon elle a été lue à l'instant, cf. maj)
    parSite: offres.map(o => ({ source: o.source, coteNon: o.coteNon || null, coteOui: o.coteOui || null, lu: o.lu || null })),
    maj: new Date().toISOString(),
  };
}

// Faut-il aller chercher l'arbitre / le résultat de ce match maintenant ?
function fenetreProche(dateISO, maintenant) {
  const d = new Date(dateISO).getTime();
  const j = 24 * 3600 * 1000;
  return d >= maintenant - 2 * j && d <= maintenant + 12 * j;
}

// Rafraîchit une ligue. `ancienParId` = matchs déjà connus (pour préserver la mémoire).
async function rafraichitLigue(meta, saison, ancienParId, journal) {
  const dit = (s) => { if (journal) journal.push(s); };
  const maintenant = Date.now();

  const fixtures = await F.espnMatchs(meta.espn, saison.plage);
  dit(`${meta.nom} : ${fixtures.length} matchs récupérés chez ESPN.`);
  // FILET DE SÉCURITÉ : si ESPN renvoie une liste vide (maintenance, limite de requêtes…),
  // on NE touche PAS aux données déjà en mémoire (sinon on perdrait cotes et résultats).
  if (fixtures.length === 0) {
    dit(`${meta.nom} : ESPN n'a renvoyé aucun match → on garde les données précédentes (rien écrasé).`);
    return null;
  }
  const classement = await F.espnClassement(meta.espn, saison.anneeEspn);
  const pinnacleCartes = await F.pinnacleMarcheCarton(meta.pinnacle);
  dit(`${meta.nom} : Pinnacle ${pinnacleCartes ? 'cote' : 'ne cote PAS'} le carton → sources cotes = ${pinnacleCartes ? 'Pinnacle' : 'Unibet + Winamax Espagne (la plus haute)'}.`);
  const kambiEvs = pinnacleCartes ? [] : await F.kambiEvenements(meta.kambi);
  const winamaxEvs = pinnacleCartes ? [] : await evenementsWinamax(meta, dit);

  let figesFaits = 0, avecCote = 0, avecArbitre = 0, confirmesFaits = 0, corriges = 0;
  const out = [];
  for (const fx of fixtures) {
    const ancien = ancienParId.get(fx.id);
    try {
      // Match déjà figé (terminé + mémorisé) : on garde tel quel, juste le score à jour.
      // SAUF si son résultat n'a jamais été confirmé après la fin réelle du match :
      // dans ce cas on le revérifie UNE fois (voir DELAI_CONFIRMATION_MS).
      if (ancien && ancien.fige) {
        const aConfirmer = !ancien.resultat?.confirme && resultatConfirmable(fx.date);
        if (!aConfirmer || confirmesFaits >= MAX_CONFIRME_PAR_FOIS) {
          out.push({ ...ancien, statut: fx.statut, score: fx.score || ancien.score });
          continue;
        }
        try {
          const det = await F.espnDetail(meta.espn, fx.id);
          confirmesFaits++;
          await F.pause(120);
          if (det.aRouge != null) {
            const avant = ancien.resultat?.aRouge;
            if (avant !== det.aRouge) {
              dit(`${meta.nom} : RÉSULTAT CORRIGÉ — ${fx.home}-${fx.away} : rouge ${avant} → ${det.aRouge}.`);
              corriges++;
            }
            out.push({
              ...ancien, statut: fx.statut, score: fx.score || ancien.score,
              resultat: { termine: true, aRouge: det.aRouge, confirme: true, confirmeLe: new Date().toISOString() },
            });
            continue;
          }
        } catch (e) { /* on réessaiera au prochain passage */ }
        out.push({ ...ancien, statut: fx.statut, score: fx.score || ancien.score });
        continue;
      }

      // Positions au classement (appliquées seulement si les 2 équipes ont ≥ 6 journées)
      const cH = classement[fx.home], cA = classement[fx.away];
      const posOk = cH && cA && cH.joues >= 6 && cA.joues >= 6;
      const posH = posOk ? cH.pos : null, posA = posOk ? cA.pos : null;

      // Arbitre + résultat : on scrappe si le match est terminé (pour le figer) ou proche.
      const doitScraper = fx.statut === 'termine' || fenetreProche(fx.date, maintenant);
      let arbitre = ancien?.arbitre || '';
      let resultat = ancien?.resultat || null;
      let fige = false;
      let majArbitre = ancien?.majArbitre || null;
      if (fx.statut === 'termine' && figesFaits >= MAX_FIGE_PAR_FOIS) {
        // On borne le nb de matchs terminés traités par passage ; le reste au prochain clic.
        out.push(ancien || construitMinimal(fx, meta));
        continue;
      }
      if (doitScraper) {
        const det = await F.espnDetail(meta.espn, fx.id);
        if (det.arbitre) { arbitre = det.arbitre; majArbitre = new Date().toISOString(); avecArbitre++; }
        if (fx.statut === 'termine') {
          // "confirme" = on est assez loin du coup d'envoi pour qu'ESPN ait publié
          // tous les évènements. Sinon le résultat est provisoire et sera revérifié.
          const confirme = resultatConfirmable(fx.date);
          resultat = { termine: true, aRouge: det.aRouge, confirme, confirmeLe: confirme ? new Date().toISOString() : null };
          fige = true; figesFaits++;
        }
        await F.pause(120);
      }

      // Prédiction maison (avant-match)
      const pr = M.predirePreMatch(meta.il, fx.home, fx.away, arbitre, posH, posA);

      // Cotes bookmaker : Pinnacle d'abord (absent), sinon la plus haute entre Unibet et Winamax Espagne
      let cotes = ancien?.cotes || null;
      if (fx.statut !== 'termine' && new Date(fx.date).getTime() > maintenant) {
        const c = await chercheCotes(fx, kambiEvs, winamaxEvs);
        if (c) { cotes = c; avecCote++; }
      }
      const valueBet = calculeValueBet(pr.pNo, cotes);

      out.push({
        id: fx.id, date: fx.date, home: fx.home, away: fx.away,
        homeCourt: fx.homeCourt, awayCourt: fx.awayCourt,
        statut: fx.statut, score: fx.score,
        homeEq: pr.equipes.home.nomData, awayEq: pr.equipes.away.nomData,
        homePromu: pr.equipes.home.promu, awayPromu: pr.equipes.away.promu,
        arbitre: arbitre || null, arbitreConnu: pr.arbitre.connu, arbitreActif: pr.arbitre.actifDansLigue,
        prediction: {
          pNo: pr.pNo, cote: pr.coteEquitable, coteRouge: pr.coteEquitableRouge,
          pBase: pr.pBase, facteurs: pr.facteurs,
          classementApplique: pr.classement.applique, gap: pr.classement.gap,
        },
        derby: pr.derby,
        cotes, valueBet, resultat, fige, majArbitre,
      });
    } catch (e) {
      out.push(ancien || construitMinimal(fx, meta));
    }
  }
  // FILET DE SÉCURITÉ (réponse ESPN partielle) : on ne perd jamais un match déjà mémorisé
  // qui aurait un résultat figé ou des cotes, même si ESPN cesse de le renvoyer cette fois-ci.
  const idsVus = new Set(out.map(m => m.id));
  let reinjectes = 0;
  for (const [id, ancienM] of ancienParId) {
    if (!idsVus.has(id) && (ancienM.fige || ancienM.cotes)) { out.push(ancienM); reinjectes++; }
  }
  out.sort((a, b) => new Date(a.date) - new Date(b.date));
  dit(`${meta.nom} : ${avecArbitre} arbitres trouvés, ${avecCote} matchs avec cotes, ${figesFaits} matchs figés`
    + `${confirmesFaits ? `, ${confirmesFaits} résultats revérifiés (${corriges} corrigé${corriges > 1 ? 's' : ''})` : ''}`
    + `${reinjectes ? `, ${reinjectes} matchs mémorisés préservés` : ''}.`);
  return out;
}

// Enregistrement minimal quand le calcul complet échoue (garde le match visible)
function construitMinimal(fx, meta) {
  const pr = M.predirePreMatch(meta.il, fx.home, fx.away, '', null, null);
  return {
    id: fx.id, date: fx.date, home: fx.home, away: fx.away,
    homeCourt: fx.homeCourt, awayCourt: fx.awayCourt, statut: fx.statut, score: fx.score,
    homeEq: pr.equipes.home.nomData, awayEq: pr.equipes.away.nomData,
    homePromu: pr.equipes.home.promu, awayPromu: pr.equipes.away.promu,
    arbitre: null, arbitreConnu: false, arbitreActif: pr.arbitre.actifDansLigue,
    prediction: {
      pNo: pr.pNo, cote: pr.coteEquitable, coteRouge: pr.coteEquitableRouge,
      pBase: pr.pBase, facteurs: pr.facteurs, classementApplique: false, gap: null,
    },
    derby: pr.derby,
    cotes: null, valueBet: null, resultat: null, fige: false, majArbitre: null,
  };
}

// ---------------------------------------------------------------------------
//  RAFRAÎCHISSEMENT AUTOMATIQUE des matchs IMMINENTS (arbitre + cote ~30 min avant)
//  Appelé en boucle par serveur.js. Ne touche QUE les matchs qui commencent bientôt,
//  pour rester léger. Réutilise exactement le même calcul que le reste.
// ---------------------------------------------------------------------------
async function rafraichitImminents(fenetreMin = 35, journal = []) {
  const dit = (s) => journal.push(s);
  const etat = chargeEtat();
  if (!etat || !etat.ligues) return { rafraichis: 0, etat: null };
  const maintenant = Date.now();
  // On remonte jusqu'à 3 jours en arrière pour RATTRAPER et figer les matchs déjà finis
  // qui ne l'auraient pas été (ex. terminés pendant que le PC/serveur était éteint),
  // en plus des matchs en cours et des matchs imminents.
  const jmin = maintenant - 3 * 24 * 60 * 60000;
  const jmax = maintenant + fenetreMin * 60000;    // matchs à venir jusqu'à la fenêtre demandée
  const saison = F.saisonCourante();
  let total = 0;

  for (const meta of F.LIGUES_META) {
    const L = etat.ligues.find(l => l.il === meta.il);
    if (!L) continue;
    const imminents = L.matchs.filter(m => !m.fige && (() => {
      const t = new Date(m.date).getTime(); return t >= jmin && t <= jmax;
    })());
    if (!imminents.length) continue;

    const classement = await F.espnClassement(meta.espn, saison.anneeEspn);
    const pinnacleCartes = await F.pinnacleMarcheCarton(meta.pinnacle);
    const kambiEvs = pinnacleCartes ? [] : await F.kambiEvenements(meta.kambi);
    const winamaxEvs = pinnacleCartes ? [] : await evenementsWinamax(meta, dit);

    for (const m of imminents) {
      try {
        const det = await F.espnDetail(meta.espn, m.id);
        if (det.arbitre) { m.arbitre = det.arbitre; m.majArbitre = new Date().toISOString(); }
        const cH = classement[m.home], cA = classement[m.away];
        const posOk = cH && cA && cH.joues >= 6 && cA.joues >= 6;
        const pr = M.predirePreMatch(meta.il, m.home, m.away, m.arbitre || '', posOk ? cH.pos : null, posOk ? cA.pos : null);
        m.arbitreConnu = pr.arbitre.connu; m.arbitreActif = pr.arbitre.actifDansLigue;
        m.prediction = {
          pNo: pr.pNo, cote: pr.coteEquitable, coteRouge: pr.coteEquitableRouge,
          pBase: pr.pBase, facteurs: pr.facteurs, classementApplique: pr.classement.applique, gap: pr.classement.gap,
        };
        m.derby = pr.derby;
        // Cotes AVANT-MATCH seulement : une fois le match lancé on garde la dernière cote d'avant le coup d'envoi
        if (!det.termine && new Date(m.date).getTime() > Date.now()) {
          const c = await chercheCotes(m, kambiEvs, winamaxEvs);
          if (c) m.cotes = c;
        }
        m.valueBet = calculeValueBet(pr.pNo, m.cotes);
        if (det.termine) {
          const confirme = resultatConfirmable(m.date);
          m.resultat = { termine: true, aRouge: det.aRouge, confirme, confirmeLe: confirme ? new Date().toISOString() : null };
          m.fige = true; m.statut = 'termine';
        }
        total++;
        await F.pause(120);
      } catch (e) { /* on ignore ce match, on ne casse pas la boucle */ }
    }
    dit(`${meta.nom} : ${imminents.length} match(s) imminent(s) rafraîchi(s).`);
  }

  // ---- REVÉRIFICATION des résultats figés trop tôt ----------------------
  // Un match figé pile à la fin du temps réglementaire peut avoir un carton de
  // la 90e qu'ESPN n'avait pas encore publié. On repasse UNE fois sur chaque
  // résultat non confirmé, 3 h 30 après le coup d'envoi. Sans ça, l'erreur
  // reste en mémoire pour toujours (cas AS Roma-Atalanta du 05/09/2026).
  let confirmes = 0, corriges = 0;
  for (const meta of F.LIGUES_META) {
    const L = etat.ligues.find(l => l.il === meta.il);
    if (!L) continue;
    for (const m of L.matchs) {
      if (confirmes >= MAX_CONFIRME_PAR_FOIS) break;
      if (!m.fige || m.resultat?.confirme || !resultatConfirmable(m.date)) continue;
      try {
        const det = await F.espnDetail(meta.espn, m.id);
        confirmes++;
        if (det.aRouge != null) {
          const avant = m.resultat?.aRouge;
          if (avant !== det.aRouge) {
            dit(`${meta.nom} : RÉSULTAT CORRIGÉ — ${m.home}-${m.away} : rouge ${avant} → ${det.aRouge}.`);
            corriges++;
          }
          m.resultat = { termine: true, aRouge: det.aRouge, confirme: true, confirmeLe: new Date().toISOString() };
          total++;
        }
        await F.pause(120);
      } catch (e) { /* on réessaiera au prochain passage */ }
    }
  }
  if (confirmes) dit(`${confirmes} résultat(s) revérifié(s), ${corriges} corrigé(s).`);
  if (total) { etat.misAJour = new Date().toISOString(); sauveEtat(etat); }
  return { rafraichis: total, etat };
}

// Rafraîchit une ou toutes les ligues et sauvegarde. `filtreEspn` = code ligue ou 'all'.
async function rafraichit(filtreEspn = 'all', journal = []) {
  const saison = F.saisonCourante();
  const ancien = chargeEtat();
  const etat = ancien && ancien.saison === `${saison.debut}-${saison.fin}`
    ? ancien
    : { saison: `${saison.debut}-${saison.fin}`, misAJour: null, ligues: [] };

  for (const meta of F.LIGUES_META) {
    if (filtreEspn !== 'all' && filtreEspn !== meta.espn) continue;
    const ligueExistante = etat.ligues.find(l => l.il === meta.il);
    const ancienParId = new Map((ligueExistante?.matchs || []).map(m => [m.id, m]));
    const matchs = await rafraichitLigue(meta, saison, ancienParId, journal);
    if (matchs === null) continue; // ESPN vide : on garde la ligue déjà en mémoire
    const nouvelle = { il: meta.il, nom: meta.nom, code: meta.espn, matchs };
    const idx = etat.ligues.findIndex(l => l.il === meta.il);
    if (idx >= 0) etat.ligues[idx] = nouvelle; else etat.ligues.push(nouvelle);
  }
  etat.ligues.sort((a, b) => a.il - b.il);
  etat.misAJour = new Date().toISOString();
  sauveEtat(etat);
  return etat;
}

module.exports = { rafraichit, rafraichitImminents, chargeEtat, FICHIER_ETAT };

// Permet aussi de lancer un rafraîchissement en ligne de commande : node moteur.js [code|all]
if (require.main === module) {
  const filtre = process.argv[2] || 'all';
  const journal = [];
  rafraichit(filtre, journal)
    .then(() => { journal.forEach(l => console.log(l)); console.log('Terminé.'); })
    .catch(e => { console.error('ERREUR', e); process.exit(1); });
}
