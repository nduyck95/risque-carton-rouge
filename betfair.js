// ============================================================================
//  betfair.js — Le "téléphone" vers Betfair.
//
//  Ce que ce fichier fait :
//    - se connecter à ton compte Betfair via l'API OFFICIELLE (pas de scraping,
//      pas de captcha contourné) ;
//    - trouver, pour un match, le marché "carton rouge" (Sending Off / Red Card) ;
//    - lire les cotes réellement disponibles à l'instant (back Oui / back Non)
//      ainsi que les montants disponibles (la "liquidité").
//
//  Ce que ce fichier NE fait PAS : placer un pari. Volontairement.
//  Tant qu'on est en simulation, aucune fonction d'ici ne peut engager d'argent.
//  (La fonction de pari réel viendra dans un fichier séparé, plus tard, et
//   seulement si la simulation est concluante.)
//
//  IDENTIFIANTS : ils sont lus dans betfair-config.json, à côté de ce fichier.
//  Ce fichier n'est jamais affiché ni recopié dans les journaux.
// ============================================================================
const fs = require('fs');
const path = require('path');
const https = require('https');

const FICHIER_CONFIG = path.join(__dirname, 'betfair-config.json');

const URL_LOGIN_INTERACTIF = 'https://identitysso.betfair.com/api/login';
const URL_LOGIN_CERT = 'https://identitysso-cert.betfair.com/api/certlogin';
const URL_KEEPALIVE = 'https://identitysso.betfair.com/api/keepAlive';
const URL_BETTING = 'https://api.betfair.com/exchange/betting/json-rpc/v1';

const FOOTBALL = '1'; // eventTypeId Betfair pour le football

// Comment reconnaître le marché "carton rouge" parmi tous les marchés d'un match.
const RE_MARCHE_CARTON = /(sending[- ]?off|red[- ]?card|sent[- ]?off)/i;

// ---------------------------------------------------------------------------
//  Configuration
// ---------------------------------------------------------------------------
function lisConfig() {
  if (!fs.existsSync(FICHIER_CONFIG)) return null;
  let t = fs.readFileSync(FICHIER_CONFIG, 'utf8');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  const c = JSON.parse(t);
  // Les variables d'environnement peuvent remplacer le fichier (pratique et plus discret).
  c.appKey = process.env.BETFAIR_APP_KEY || c.appKey;
  c.username = process.env.BETFAIR_USERNAME || c.username;
  c.password = process.env.BETFAIR_PASSWORD || c.password;
  return c;
}

// Diagnostic SANS jamais révéler le contenu des identifiants.
function etatConfig() {
  const c = lisConfig();
  if (!c) return { pret: false, raison: 'fichier betfair-config.json absent' };
  const aCert = !!(c.certFile && c.keyFile && fs.existsSync(c.certFile) && fs.existsSync(c.keyFile));
  if (!c.appKey) return { pret: false, raison: 'appKey manquante' };
  if (!c.username) return { pret: false, raison: 'username manquant' };
  if (!c.password) return { pret: false, raison: 'password manquant' };
  return {
    pret: true,
    methode: aCert ? 'certificat (recommandé)' : 'interactif',
    aCert,
    appKeyIndice: String(c.appKey).slice(0, 4) + '…', // 4 premiers caractères, pour vérifier qu'on lit le bon
  };
}

// ---------------------------------------------------------------------------
//  Connexion
// ---------------------------------------------------------------------------
let session = { token: null, quand: 0 };
const DUREE_SESSION_MS = 3 * 3600 * 1000; // on renouvelle largement avant les 4 h de Betfair

// Connexion par certificat (méthode recommandée par Betfair pour les programmes).
function loginCert(c) {
  return new Promise((resolve, reject) => {
    const corps = `username=${encodeURIComponent(c.username)}&password=${encodeURIComponent(c.password)}`;
    const u = new URL(URL_LOGIN_CERT);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      cert: fs.readFileSync(c.certFile), key: fs.readFileSync(c.keyFile),
      headers: {
        'X-Application': c.appKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(corps),
        'Accept': 'application/json',
      },
    }, (res) => {
      let d = '';
      res.on('data', (x) => d += x);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.loginStatus === 'SUCCESS' && j.sessionToken) resolve(j.sessionToken);
          else reject(new Error('Betfair refuse la connexion par certificat : ' + (j.loginStatus || d.slice(0, 120))));
        } catch (e) { reject(new Error('Réponse illisible de Betfair (certificat)')); }
      });
    });
    req.on('error', reject);
    req.write(corps);
    req.end();
  });
}

// Connexion interactive (login/mot de passe). Refusée par Betfair si la
// double authentification est activée sur le compte -> passer au certificat.
async function loginInteractif(c) {
  const corps = `username=${encodeURIComponent(c.username)}&password=${encodeURIComponent(c.password)}`;
  const r = await fetch(URL_LOGIN_INTERACTIF, {
    method: 'POST',
    headers: {
      'X-Application': c.appKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: corps,
  });
  const j = await r.json().catch(() => ({}));
  if (j.status === 'SUCCESS' && j.token) return j.token;
  const err = j.error || j.status || ('HTTP ' + r.status);
  throw new Error('Betfair refuse la connexion : ' + err
    + (err === 'INVALID_USERNAME_OR_PASSWORD' ? ' (identifiants)' : '')
    + (/TWO_FACTOR|CERT/i.test(String(err)) ? ' (double authentification active : il faut la méthode certificat)' : ''));
}

async function connexion(forcer = false) {
  const c = lisConfig();
  if (!c) throw new Error('betfair-config.json absent : Betfair n\'est pas configuré.');
  if (!forcer && session.token && Date.now() - session.quand < DUREE_SESSION_MS) return session.token;
  const aCert = !!(c.certFile && c.keyFile && fs.existsSync(c.certFile) && fs.existsSync(c.keyFile));
  const token = aCert ? await loginCert(c) : await loginInteractif(c);
  session = { token, quand: Date.now() };
  return token;
}

async function keepAlive() {
  const c = lisConfig();
  if (!session.token) return false;
  try {
    const r = await fetch(URL_KEEPALIVE, {
      headers: { 'X-Application': c.appKey, 'X-Authentication': session.token, 'Accept': 'application/json' },
    });
    const j = await r.json().catch(() => ({}));
    return j.status === 'SUCCESS';
  } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
//  Appel générique de l'API paris (JSON-RPC)
// ---------------------------------------------------------------------------
let compteur = 0;
async function appel(methode, params, essais = 2) {
  const c = lisConfig();
  let derniere;
  for (let i = 1; i <= essais; i++) {
    try {
      const token = await connexion(i > 1); // au 2e essai, on force une reconnexion
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(URL_BETTING, {
        method: 'POST',
        headers: {
          'X-Application': c.appKey, 'X-Authentication': token,
          'Content-Type': 'application/json', 'Accept': 'application/json',
        },
        body: JSON.stringify([{ jsonrpc: '2.0', method: 'SportsAPING/v1.0/' + methode, params, id: ++compteur }]),
        signal: ctrl.signal,
      });
      clearTimeout(to);
      const txt = await r.text();
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 200));
      const j = JSON.parse(txt);
      const rep = Array.isArray(j) ? j[0] : j;
      if (rep.error) {
        const d = rep.error.data?.APINGException?.errorCode || JSON.stringify(rep.error).slice(0, 200);
        throw new Error('Betfair ' + methode + ' : ' + d);
      }
      return rep.result;
    } catch (e) {
      derniere = e;
      if (i < essais) await new Promise(res => setTimeout(res, 700));
    }
  }
  throw derniere;
}

// ---------------------------------------------------------------------------
//  Trouver les compétitions (Premier League, Liga, Serie A) une fois pour toutes
// ---------------------------------------------------------------------------
const RE_COMPETITIONS = [
  { il: 0, nom: 'Premier League', re: /^english premier league$|^premier league$/i },
  { il: 1, nom: 'Liga', re: /^spanish la liga$|^la liga$|^laliga$/i },
  { il: 2, nom: 'Serie A', re: /^italian serie a$|^serie a$/i },
];

let cacheCompetitions = null;
async function competitions() {
  if (cacheCompetitions) return cacheCompetitions;
  const res = await appel('listCompetitions', { filter: { eventTypeIds: [FOOTBALL] } });
  const out = [];
  for (const spec of RE_COMPETITIONS) {
    // On prend la compétition qui correspond ET qui a le plus de marchés (évite les
    // homonymes : "Serie A" existe aussi au Brésil, en Équateur…).
    const cands = (res || []).filter(x => spec.re.test(String(x.competition?.name || '')));
    cands.sort((a, b) => (b.marketCount || 0) - (a.marketCount || 0));
    if (cands.length) {
      out.push({
        il: spec.il, nom: spec.nom,
        id: String(cands[0].competition.id),
        nomBetfair: cands[0].competition.name,
        region: cands[0].competitionRegion,
        nbMarches: cands[0].marketCount,
      });
    }
  }
  cacheCompetitions = out;
  return out;
}

// Les matchs Betfair d'une compétition sur les prochaines heures
async function evenements(competitionId, heuresAvant = 6, heuresApres = 30) {
  const de = new Date(Date.now() - heuresAvant * 3600 * 1000).toISOString();
  const a = new Date(Date.now() + heuresApres * 3600 * 1000).toISOString();
  const res = await appel('listEvents', {
    filter: { eventTypeIds: [FOOTBALL], competitionIds: [String(competitionId)], marketStartTime: { from: de, to: a } },
  });
  return (res || []).map(x => ({
    id: String(x.event.id),
    nom: x.event.name,             // "Arsenal v Chelsea"
    debut: x.event.openDate,
    nbMarches: x.marketCount,
  }));
}

// Le marché "carton rouge" d'un match + ses deux issues (Oui / Non)
async function marcheCarton(eventId) {
  const res = await appel('listMarketCatalogue', {
    filter: { eventIds: [String(eventId)] },
    marketProjection: ['RUNNER_DESCRIPTION', 'MARKET_START_TIME'],
    maxResults: 200,
  });
  const cands = (res || []).filter(m => RE_MARCHE_CARTON.test(String(m.marketName || '')));
  // On veut un marché à deux issues Oui/Non (et pas "premier joueur expulsé", etc.)
  for (const m of cands) {
    const rs = m.runners || [];
    const oui = rs.find(r => /^yes$/i.test(String(r.runnerName || '')));
    const non = rs.find(r => /^no$/i.test(String(r.runnerName || '')));
    if (oui && non) {
      return {
        marketId: String(m.marketId), nom: m.marketName, debut: m.marketStartTime,
        idOui: oui.selectionId, idNon: non.selectionId,
      };
    }
  }
  return null;
}

// Les cotes réellement disponibles maintenant sur ce marché
async function prixMarche(marche) {
  const res = await appel('listMarketBook', {
    marketIds: [marche.marketId],
    priceProjection: { priceData: ['EX_BEST_OFFERS'], virtualise: true },
  });
  const b = (res || [])[0];
  if (!b) return null;
  const lu = new Date().toISOString();
  const pris = (selectionId) => {
    const r = (b.runners || []).find(x => x.selectionId === selectionId);
    const back = r?.ex?.availableToBack?.[0] || null;
    const lay = r?.ex?.availableToLay?.[0] || null;
    return {
      statut: r?.status || null,
      cote: back ? back.price : null,       // la cote à laquelle on peut parier TOUT DE SUITE
      dispo: back ? back.size : 0,          // le montant disponible à cette cote (liquidité)
      coteLay: lay ? lay.price : null,      // l'autre côté du carnet (sert à mesurer l'écart)
    };
  };
  const oui = pris(marche.idOui), non = pris(marche.idNon);
  // Écart entre acheteur et vendeur ("spread") : plus il est large, moins le prix est fiable.
  const spread = (non.cote && non.coteLay) ? (non.coteLay - non.cote) : null;
  return {
    marketId: marche.marketId,
    statut: b.status,                       // OPEN / SUSPENDED / CLOSED
    inplay: !!b.inplay,
    versionRunners: b.version || null,
    liquiditeTotale: b.totalMatched || 0,
    coteOui: oui.cote, dispoOui: oui.dispo,
    coteNon: non.cote, dispoNon: non.dispo,
    spreadNon: spread,
    lu,
    source: 'Betfair',
  };
}

// Test de bout en bout, à lancer en ligne de commande : node betfair.js
async function autotest() {
  const e = etatConfig();
  console.log('Configuration :', JSON.stringify(e));
  if (!e.pret) { console.log('→ Rien à tester tant que la configuration est incomplète.'); return; }
  await connexion();
  console.log('Connexion : OK (session ouverte).');
  const comps = await competitions();
  console.log('Compétitions trouvées :');
  for (const c of comps) console.log(`  ${c.nom} -> id ${c.id} ("${c.nomBetfair}", ${c.nbMarches} marchés)`);
  for (const c of comps) {
    const evs = await evenements(c.id, 6, 36);
    console.log(`${c.nom} : ${evs.length} match(s) dans les 36 h.`);
    for (const ev of evs.slice(0, 3)) {
      const m = await marcheCarton(ev.id);
      if (!m) { console.log(`  ${ev.nom} : PAS de marché carton rouge`); continue; }
      const p = await prixMarche(m);
      console.log(`  ${ev.nom} : "${m.nom}" ${p.statut}${p.inplay ? ' EN DIRECT' : ''}`
        + ` | Non ${p.coteNon} (${p.dispoNon} € dispo) | Oui ${p.coteOui} (${p.dispoOui} € dispo)`
        + ` | volume ${Math.round(p.liquiditeTotale)} €`);
    }
  }
}

module.exports = {
  etatConfig, connexion, keepAlive, appel,
  competitions, evenements, marcheCarton, prixMarche,
  FICHIER_CONFIG,
};

if (require.main === module) {
  autotest().catch(e => { console.error('ÉCHEC :', e.message); process.exit(1); });
}
