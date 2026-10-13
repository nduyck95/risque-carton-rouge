// ============================================================================
//  serveur.js — Petit serveur local (http://localhost:8123)
//    /            -> l'outil "live" existant (index.html)
//    /matchs      -> la nouvelle page : tous les matchs de la saison + prédictions
//    /api/etat    -> renvoie la mémoire (donnees/saison-courante.json)
//    /api/rafraichir?ligue=all|eng.1|esp.1|ita.1 -> va chercher matchs, arbitres,
//                    classement, cotes bookmaker, calcule tout et sauvegarde.
//  Aucun scraping ne part du navigateur : c'est ce serveur (sur ta machine) qui
//  contacte ESPN / Pinnacle / Unibet, ce qui évite les blocages du navigateur.
// ============================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const moteur = require('./moteur.js');
const paris = require('./paris.js');
const betfair = require('./betfair.js');

const PORT = 8123;
function envoieFichier(res, fichier, type) {
  fs.readFile(fichier, (err, data) => {
    if (err) { res.writeHead(404); res.end('Introuvable : ' + path.basename(fichier)); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}
function envoieJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

let rafraichissementEnCours = false;

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const chemin = url.pathname;
  try {
    if (chemin === '/' || chemin === '/index.html') {
      return envoieFichier(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
    }
    if (chemin === '/matchs' || chemin === '/matchs.html') {
      return envoieFichier(res, path.join(__dirname, 'matchs.html'), 'text/html; charset=utf-8');
    }
    if (chemin === '/api/etat') {
      const etat = moteur.chargeEtat();
      return envoieJson(res, 200, etat || { vide: true });
    }
    if (chemin === '/api/rafraichir') {
      if (rafraichissementEnCours) return envoieJson(res, 409, { erreur: 'Un rafraîchissement est déjà en cours.' });
      const ligue = url.searchParams.get('ligue') || 'all';
      rafraichissementEnCours = true;
      const journal = [];
      try {
        const etat = await moteur.rafraichit(ligue, journal);
        return envoieJson(res, 200, { etat, journal });
      } finally {
        rafraichissementEnCours = false;
      }
    }
    if (chemin === '/api/imminents') {
      // Rafraîchit maintenant les matchs qui commencent bientôt (test manuel de l'auto-refresh)
      const fen = parseInt(url.searchParams.get('min') || '35', 10);
      const journal = [];
      const r = await moteur.rafraichitImminents(fen, journal);
      return envoieJson(res, 200, { rafraichis: r.rafraichis, journal });
    }
    // ---------------- LE BOT DE PARIS SIMULÉS ----------------
    if (chemin === '/paris' || chemin === '/paris.html') {
      return envoieFichier(res, path.join(__dirname, 'paris.html'), 'text/html; charset=utf-8');
    }
    if (chemin === '/api/paris') {
      const etat = paris.chargeParis();
      return envoieJson(res, 200, {
        config: paris.config(),
        betfair: betfair.etatConfig(),
        stop: fs.existsSync(paris.FICHIER_STOP),
        stats: paris.statistiques(etat),
        paris: etat.paris,
        journal: etat.journal || [],
        majAt: etat.majAt,
        dernieresDecisions: dernieresDecisions,
        dernierTour: dernierTour,
      });
    }
    if (chemin === '/api/paris/tour') {
      // Force un tour de bot tout de suite (bouton "Analyser maintenant")
      const r = await tourDeBot(true);
      return envoieJson(res, 200, r);
    }
    if (chemin === '/api/paris/stop') {
      // Bouton d'arrêt d'urgence : crée (ou supprime) le fichier STOP
      const actif = url.searchParams.get('actif') !== '0';
      if (actif) fs.writeFileSync(paris.FICHIER_STOP, 'Arrêt demandé le ' + new Date().toISOString(), 'utf8');
      else if (fs.existsSync(paris.FICHIER_STOP)) fs.unlinkSync(paris.FICHIER_STOP);
      return envoieJson(res, 200, { stop: fs.existsSync(paris.FICHIER_STOP) });
    }
    if (chemin === '/api/betfair/test') {
      // Vérifie la connexion Betfair sans rien parier
      try {
        const e = betfair.etatConfig();
        if (!e.pret) return envoieJson(res, 200, { ok: false, ...e });
        await betfair.connexion();
        const comps = await betfair.competitions();
        return envoieJson(res, 200, { ok: true, ...e, competitions: comps });
      } catch (err) {
        return envoieJson(res, 200, { ok: false, erreur: String(err && err.message || err) });
      }
    }
    res.writeHead(404); res.end('Route inconnue : ' + chemin);
  } catch (e) {
    rafraichissementEnCours = false;
    envoieJson(res, 500, { erreur: String(e && e.message || e) });
  }
}).listen(PORT, () => {
  console.log(`Serveur sur http://localhost:${PORT}`);
  console.log(`  • Outil live    : http://localhost:${PORT}/`);
  console.log(`  • Page saison   : http://localhost:${PORT}/matchs`);
  console.log(`  • Bot de paris  : http://localhost:${PORT}/paris   (SIMULATION, aucun argent engagé)`);
  console.log(`  • Auto : arbitre + cote rafraîchis ~30 min avant chaque match (toutes les 5 min).`);
});

// ============================================================================
//  AUTO-REFRESH : tant que ce serveur tourne, il vérifie toutes les 5 minutes
//  s'il y a des matchs qui commencent dans ~30 min et met à jour leur arbitre
//  et leur cote automatiquement. (Ne marche que PC allumé + serveur lancé.)
// ============================================================================
async function passeAuto(fenetreMin, etiquette) {
  if (rafraichissementEnCours) return; // on laisse la priorité à un rafraîchissement manuel
  rafraichissementEnCours = true;
  try {
    const journal = [];
    const r = await moteur.rafraichitImminents(fenetreMin, journal);
    if (r.rafraichis > 0) {
      const h = new Date().toLocaleTimeString('fr-FR');
      console.log(`[auto ${etiquette} ${h}] ${r.rafraichis} match(s) rafraîchi(s). ${journal.join(' ')}`);
    }
  } catch (e) {
    console.log(`[auto ${etiquette}] erreur :`, e && e.message);
  } finally {
    rafraichissementEnCours = false;
  }
}
// ============================================================================
//  BOUCLE DU BOT DE PARIS (simulation).
//  Toutes les 30 s : s'il y a des matchs en cours, il analyse et note ce qu'il
//  aurait parié. S'il n'y a aucun match en cours, il ne fait quasiment rien
//  (un seul appel léger par ligue) et se rendort.
// ============================================================================
let tourEnCours = false;
let dernieresDecisions = [];
let dernierTour = null;

async function tourDeBot(force = false) {
  if (tourEnCours) return { occupe: true, decisions: dernieresDecisions, journal: [] };
  tourEnCours = true;
  const journal = [];
  try {
    const r = await paris.tick(journal);
    dernieresDecisions = r.decisions || [];
    dernierTour = new Date().toISOString();
    const interessant = journal.filter(l => /PARI SIMULÉ|Réglé|erreur|indisponible/.test(l));
    if (interessant.length) {
      const h = new Date().toLocaleTimeString('fr-FR');
      for (const l of interessant) console.log(`[bot ${h}] ${l}`);
    }
    return { live: r.live, decisions: r.decisions, journal, stats: paris.statistiques(r.etat) };
  } catch (e) {
    console.log('[bot] erreur :', e && e.message);
    return { erreur: String(e && e.message || e), journal };
  } finally {
    tourEnCours = false;
  }
}
setInterval(() => tourDeBot(false), 30 * 1000);
setTimeout(() => tourDeBot(false), 12000);

// Passage RAPIDE toutes les 5 min : matchs qui commencent dans ~35 min (arbitre + cote de dernière minute, gel des résultats).
setInterval(() => passeAuto(35, 'imminent'), 5 * 60 * 1000);
// Passage LARGE toutes les heures : matchs des 3 prochains jours (attrape l'arbitre dès sa désignation, 1-2 j avant).
setInterval(() => passeAuto(3 * 24 * 60, 'jours'), 60 * 60 * 1000);
// Premiers passages peu après le démarrage.
setTimeout(() => passeAuto(3 * 24 * 60, 'jours'), 8000);
setTimeout(() => passeAuto(35, 'imminent'), 20000);
