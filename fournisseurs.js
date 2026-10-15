// ============================================================================
//  fournisseurs.js — Tout ce qui va CHERCHER des infos sur internet :
//    - ESPN   : la liste des matchs de la saison, l'arbitre, le classement,
//               et le résultat réel une fois le match joué (y a-t-il eu rouge ?)
//    - Pinnacle : on ESSAIE d'abord (comme demandé) le marché "carton rouge".
//                 Vérifié : Pinnacle ne cote pas ce marché pour ces 3 ligues,
//                 donc en pratique cela renvoie "rien" et on passe au repli.
//    - Unibet (Kambi) : source de repli qui, elle, cote "Red Card given" (oui/non).
//    - Winamax Espagne (winamax.es) : 2e site, pari « Expulsión » (sí/no). Ce pari
//      n'existe pas sur winamax.fr (règles françaises), mais le site espagnol
//      répond depuis la France comme depuis GitHub.
// ============================================================================
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' };

async function httpJson(url, headers = {}, essais = 3) {
  let derniereErr;
  for (let i = 1; i <= essais; i++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 25000);
      const r = await fetch(url, { headers: { ...UA, ...headers }, signal: ctrl.signal });
      clearTimeout(to);
      const txt = await r.text();
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return JSON.parse(txt);
    } catch (e) {
      derniereErr = e;
      if (i < essais) await new Promise(res => setTimeout(res, 800 * i));
    }
  }
  throw derniereErr;
}
const pause = (ms) => new Promise(r => setTimeout(r, ms));

// Les 3 ligues, avec tous leurs identifiants selon la source
const LIGUES_META = [
  { il: 0, nom: 'Premier League', espn: 'eng.1', kambi: 'football/england/premier_league', pinnacle: 1980, winamax: '1/1' },
  { il: 1, nom: 'Liga',           espn: 'esp.1', kambi: 'football/spain/la_liga',           pinnacle: 2196, winamax: '32/36' },
  { il: 2, nom: 'Serie A',        espn: 'ita.1', kambi: 'football/italy/serie_a',           pinnacle: 2436, winamax: '31/33' },
];

// Saison de football courante à partir d'une date (une saison va d'août à juin)
function saisonCourante(date = new Date()) {
  const a = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1; // 1..12
  const debut = m >= 7 ? a : a - 1;  // juillet ou après => saison qui commence cette année
  return { debut, fin: debut + 1, plage: `${debut}0701-${debut + 1}0630`, anneeEspn: debut };
}

// ---------------------------------------------------------------------------
//  ESPN : liste des matchs de la saison (à venir + joués)
// ---------------------------------------------------------------------------
function statutEspn(ev) {
  const s = ev.status?.type?.state;
  return s === 'pre' ? 'a_venir' : s === 'in' ? 'en_cours' : s === 'post' ? 'termine' : 'a_venir';
}
// ESPN n'accepte plus les plages "AAAAMMJJ-AAAAMMJJ" dans ?dates= (HTTP 400) :
// seuls le mois "AAAAMM" et le jour "AAAAMMJJ" passent. On découpe donc la plage
// de la saison en mois, et on interroge mois par mois.
function moisDeLaPlage(plage) {
  const m = /^(\d{4})(\d{2})\d{2}-(\d{4})(\d{2})\d{2}$/.exec(String(plage || ''));
  if (!m) return [String(plage)]; // format inattendu : on envoie tel quel
  const dernier = Number(m[3]) * 12 + Number(m[4]);
  let an = Number(m[1]), mois = Number(m[2]);
  const out = [];
  while (an * 12 + mois <= dernier) {
    out.push(`${an}${String(mois).padStart(2, '0')}`);
    if (++mois > 12) { mois = 1; an++; }
  }
  return out;
}
async function espnMatchs(code, plage) {
  const out = [];
  const vus = new Set();
  for (const mois of moisDeLaPlage(plage)) {
    const j = await httpJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/scoreboard?dates=${mois}&limit=1000`);
    for (const ev of (j.events || [])) {
      const comp = ev.competitions?.[0];
      const cs = comp?.competitors || [];
      const home = cs.find(c => c.homeAway === 'home')?.team;
      const away = cs.find(c => c.homeAway === 'away')?.team;
      if (!home || !away) continue;
      if (vus.has(String(ev.id))) continue; // un match peut revenir dans 2 mois voisins
      vus.add(String(ev.id));
      const statut = statutEspn(ev);
      const scoreH = cs.find(c => c.homeAway === 'home')?.score;
      const scoreA = cs.find(c => c.homeAway === 'away')?.score;
      out.push({
        id: String(ev.id),
        date: ev.date,
        home: home.displayName,
        away: away.displayName,
        homeCourt: home.shortDisplayName,
        awayCourt: away.shortDisplayName,
        statut,
        // Le score n'a de sens que si le match a commencé (ESPN renvoie "0" pour les matchs à venir).
        score: (statut !== 'a_venir' && scoreH != null && scoreA != null) ? `${scoreH}-${scoreA}` : null,
      });
    }
    await pause(120);
  }
  // tri chronologique
  out.sort((a, b) => new Date(a.date) - new Date(b.date));
  return out;
}

// ESPN "core" API : l'arbitre DÉSIGNÉ, dispo dès l'annonce (souvent 1-2 j avant le match),
// alors que l'API "summary" ne le donne qu'au coup d'envoi. C'est la bonne source pré-match.
async function espnArbitreCore(code, id) {
  try {
    const liste = await httpJson(`https://sports.core.api.espn.com/v2/sports/soccer/leagues/${code}/events/${id}/competitions/${id}/officials`);
    const items = (liste.items || []).slice(0, 5);
    if (!items.length) return '';
    let premier = '';
    for (const it of items) {
      const o = await httpJson(String(it.$ref).replace('http://', 'https://'));
      const nom = String(o.fullName || o.displayName || '').trim();
      const role = String((o.position && (o.position.name || o.position.displayName)) || '');
      if (!premier && nom) premier = nom;
      if (nom && /^referee$/i.test(role)) return nom; // arbitre central
    }
    return premier; // sinon, le premier officiel listé
  } catch (e) { return ''; }
}

// ESPN : détail d'un match -> arbitre + (si terminé) y a-t-il eu un rouge ?
async function espnDetail(code, id) {
  const s = await httpJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/summary?event=${id}`);
  // Arbitre : on privilégie l'API core (dispo avant le match) ; repli sur summary (dispo en cours/après).
  let arbitre = await espnArbitreCore(code, id);
  if (!arbitre) {
    const off = s.gameInfo?.officials;
    if (off && off.length) arbitre = String(off[0].fullName || '').trim();
  }
  let aRouge = null; // null = inconnu, true/false sinon
  const termine = s.header?.competitions?.[0]?.status?.type?.state === 'post';
  if (s.keyEvents) {
    aRouge = false;
    for (const k of s.keyEvents) {
      const t = k.type?.text || '';
      if (/Red/i.test(t) && /Card/i.test(t)) aRouge = true;
    }
  }
  return { arbitre, aRouge, termine };
}

// ESPN : classement courant -> map "nom d'équipe" -> { pos, joues }
async function espnClassement(code, annee) {
  try {
    const j = await httpJson(`https://site.api.espn.com/apis/v2/sports/soccer/${code}/standings?season=${annee}`);
    const entries = j?.children?.[0]?.standings?.entries || j?.standings?.entries || [];
    const map = {};
    for (const e of entries) {
      const nom = e.team?.displayName;
      const st = {};
      for (const s of (e.stats || [])) st[s.name] = s.value;
      if (nom) map[nom] = { pos: st.rank || null, joues: st.gamesPlayed || 0 };
    }
    return map;
  } catch (e) { return {}; }
}

// ---------------------------------------------------------------------------
//  ESPN LIVE : l'état des matchs EN COURS (minute, score, jaunes, rouges)
//  C'est le carburant du modèle live. Deux niveaux, pour ménager ESPN :
//    - espnLiveLigue(code)  : 1 seul appel par ligue -> tous les matchs en cours
//    - espnCartesLive(code,id) : 1 appel par match en cours -> les cartons
// ---------------------------------------------------------------------------

// "67'" -> 67 ; "45'+2'" -> 45 ; "90'+4'" -> 90 ; "" -> null
function minuteDepuisHorloge(txt) {
  const m = /^(\d+)/.exec(String(txt || '').trim());
  return m ? parseInt(m[1], 10) : null;
}

// Minute de jeu courante, la plus fiable possible.
// Ordre de préférence : horloge affichée > secondes écoulées > mi-temps (repli).
function minuteCourante(status) {
  const parHorloge = minuteDepuisHorloge(status?.displayClock);
  if (parHorloge != null) return Math.min(90, parHorloge);
  const sec = Number(status?.clock);
  if (Number.isFinite(sec) && sec > 0) return Math.min(90, Math.floor(sec / 60));
  const per = Number(status?.period);
  const nom = String(status?.type?.name || '');
  if (/HALFTIME/i.test(nom)) return 45;
  if (per === 2) return 46;
  if (per === 1) return 1;
  return null;
}

async function espnLiveLigue(code) {
  const j = await httpJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/scoreboard?limit=100`);
  const out = [];
  for (const ev of (j.events || [])) {
    const comp = ev.competitions?.[0];
    const status = comp?.status || ev.status;
    const state = status?.type?.state;
    if (state !== 'in') continue; // on ne veut QUE les matchs en cours
    const cs = comp?.competitors || [];
    const home = cs.find(c => c.homeAway === 'home');
    const away = cs.find(c => c.homeAway === 'away');
    if (!home || !away) continue;
    out.push({
      id: String(ev.id),
      date: ev.date,
      home: home.team?.displayName,
      away: away.team?.displayName,
      homeCourt: home.team?.shortDisplayName,
      awayCourt: away.team?.shortDisplayName,
      butsA: Number(home.score),
      butsB: Number(away.score),
      minute: minuteCourante(status),
      horloge: status?.displayClock || null,
      periode: Number(status?.period) || null,
      etatNom: String(status?.type?.name || ''),
      miTemps: /HALFTIME/i.test(String(status?.type?.name || '')),
      lu: new Date().toISOString(),   // horodatage de lecture (sert au garde-fou de fraîcheur)
    });
  }
  return out;
}

// Cartons d'un match en cours : combien de jaunes, y a-t-il déjà un rouge,
// et à quelle minute est tombé le dernier carton (garde-fou anti « on parie
// juste après un carton, alors que le marché l'a déjà intégré »).
async function espnCartesLive(code, id) {
  const s = await httpJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/summary?event=${id}`);
  let jaunes = 0, rouges = 0, derniereCarteMin = null;
  for (const k of (s.keyEvents || [])) {
    const t = String(k.type?.text || '');
    if (!/Card/i.test(t)) continue;
    const min = minuteDepuisHorloge(k.clock?.displayValue);
    if (/Red/i.test(t)) rouges++; else jaunes++;
    if (min != null && (derniereCarteMin == null || min > derniereCarteMin)) derniereCarteMin = min;
  }
  // Arbitre : au coup d'envoi, l'API summary le donne (gameInfo.officials)
  let arbitre = '';
  const off = s.gameInfo?.officials;
  if (off && off.length) arbitre = String(off[0].fullName || '').trim();
  const status = s.header?.competitions?.[0]?.status;
  return {
    jaunes, rouges, dejaRouge: rouges > 0, derniereCarteMin, arbitre,
    minuteSummary: minuteCourante(status),
    termine: status?.type?.state === 'post',
    lu: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
//  Pinnacle : on essaie de trouver un marché "carton rouge" (vérifié : absent)
// ---------------------------------------------------------------------------
const PINNACLE_KEY = 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';
async function pinnacleMarcheCarton(pinnacleId) {
  // On regarde les libellés de marchés spéciaux de la ligue. Si aucun ne parle de
  // carton/red/booking, on renvoie false (=> on utilisera le bookmaker de repli).
  try {
    const mm = await httpJson(
      `https://guest.api.arcadia.pinnacle.com/0.1/leagues/${pinnacleId}/matchups`,
      { 'x-api-key': PINNACLE_KEY });
    const libelles = (Array.isArray(mm) ? mm : [])
      .map(m => m.special && m.special.description).filter(Boolean);
    const cartes = libelles.some(d => /\b(card|cards|red card|booking|booked|sent off|caution)\b/i.test(d));
    return cartes; // true si (un jour) Pinnacle cote les cartons
  } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
//  Unibet (Kambi) : cotes "Red Card given" (oui/non) — source de repli
// ---------------------------------------------------------------------------
const KAMBI = 'https://eu-offering-api.kambicdn.com/offering/v2018/ubuk';
function normEquipe(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' ').replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(Boolean)
    .filter(w => !['fc', 'afc', 'cf', 'ac', 'as', 'sc', 'ssc', 'us', 'cd', 'rc', 'ud', 'club',
      'calcio', 'city', 'united', 'hotspur', 'wanderers', 'hove', 'albion', 'de', 'a', 'and',
      'coruna', 'cp', 'the'].includes(w));
}
function jaccard(aTokens, bTokens) {
  const A = new Set(aTokens), B = new Set(bTokens);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

async function kambiEvenements(kambiPath) {
  try {
    const j = await httpJson(`${KAMBI}/listView/${kambiPath}.json?lang=en_GB&market=GB`);
    return (j.events || []).map(e => ({
      id: e.event.id,
      home: e.event.homeName || '',
      away: e.event.awayName || '',
      start: e.event.start,
      tokensHome: normEquipe(e.event.homeName),
      tokensAway: normEquipe(e.event.awayName),
    }));
  } catch (e) { return []; }
}

// Associer un match ESPN à un évènement Kambi (même jour + noms proches)
function trouveKambi(fixture, evsKambi) {
  const jour = fixture.date.slice(0, 10);
  const tHome = normEquipe(fixture.home).concat(normEquipe(fixture.homeCourt));
  const tAway = normEquipe(fixture.away).concat(normEquipe(fixture.awayCourt));
  let best = null, bestScore = 0;
  for (const e of evsKambi) {
    const memeJour = e.start.slice(0, 10) === jour;
    const jourProche = Math.abs(new Date(e.start) - new Date(fixture.date)) < 36 * 3600 * 1000;
    if (!memeJour && !jourProche) continue;
    const s = jaccard(tHome, e.tokensHome) + jaccard(tAway, e.tokensAway);
    if (s > bestScore) { bestScore = s; best = e; }
  }
  return bestScore >= 1.0 ? best : null; // il faut une bonne corr. sur domicile ET extérieur
}

// Lire les cotes "Red Card given" d'un évènement Kambi
async function kambiCotesCarton(eventId) {
  try {
    const bo = await httpJson(`${KAMBI}/betoffer/event/${eventId}.json?lang=en_GB&market=GB`);
    const offre = (bo.betOffers || []).find(o => /^Red Card given$/i.test(o.criterion?.label || ''));
    if (!offre) return null;
    let coteNon = null, coteOui = null;
    for (const oc of (offre.outcomes || [])) {
      if (oc.type === 'OT_NO' || /^No$/i.test(oc.label)) coteNon = oc.odds / 1000;
      if (oc.type === 'OT_YES' || /^Yes$/i.test(oc.label)) coteOui = oc.odds / 1000;
    }
    if (coteNon == null && coteOui == null) return null;
    return { coteNon, coteOui };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
//  Winamax Espagne : pari « Expulsión » (marketId 146, sí/no) — 2e site de cotes
//  Pas d'API publique : chaque page du site contient toutes ses données dans un
//  bloc PRELOADED_STATE (matchs, paris, cotes) qu'on lit tel quel.
// ---------------------------------------------------------------------------
const WINAMAX = 'https://www.winamax.es/apuestas-deportivas';
const WINAMAX_UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept': 'text/html',
};
const WINAMAX_MARCHE_EXPULSION = 146;

async function httpTexte(url, headers = {}, essais = 2) {
  let derniereErr;
  for (let i = 1; i <= essais; i++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 25000);
      const r = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      derniereErr = e;
      if (i < essais) await new Promise(res => setTimeout(res, 800 * i));
    }
  }
  throw derniereErr;
}

// Extrait l'objet JSON qui suit « PRELOADED_STATE » dans la page (en sautant les
// accolades qui se trouvent à l'intérieur des textes entre guillemets).
function winamaxEtatPage(html) {
  const i = html.indexOf('PRELOADED_STATE');
  if (i < 0) return null;
  const debut = html.indexOf('{', i);
  if (debut < 0) return null;
  let prof = 0, dansTexte = false, echappe = false;
  for (let k = debut; k < html.length; k++) {
    const c = html[k];
    if (dansTexte) {
      if (echappe) echappe = false;
      else if (c === '\\') echappe = true;
      else if (c === '"') dansTexte = false;
      continue;
    }
    if (c === '"') dansTexte = true;
    else if (c === '{') prof++;
    else if (c === '}' && --prof === 0) {
      try { return JSON.parse(html.slice(debut, k + 1)); } catch (e) { return null; }
    }
  }
  return null;
}

// Les matchs à venir d'un championnat chez Winamax (chemin = "catégorie/tournoi")
async function winamaxEvenements(chemin) {
  try {
    const [cat, tournoi] = String(chemin).split('/').map(Number);
    const etat = winamaxEtatPage(await httpTexte(`${WINAMAX}/sports/1/${cat}/${tournoi}`, WINAMAX_UA));
    if (!etat || !etat.matches) return [];
    return Object.values(etat.matches)
      .filter(m => m.tournamentId === tournoi && m.status === 'PREMATCH')
      .map(m => ({
        id: m.matchId,
        home: m.competitor1Name || '',
        away: m.competitor2Name || '',
        start: new Date(m.matchStart * 1000).toISOString(),
        tokensHome: normEquipe(m.competitor1Name),
        tokensAway: normEquipe(m.competitor2Name),
      }));
  } catch (e) { return []; }
}

// Ressemblance de deux noms d'équipe écrits dans des langues différentes
// (« Nápoles » / « Napoli », « Bolonia » / « Bologna ») : on compare les 4 premières lettres des mots.
function ressemblanceNoms(aTokens, bTokens) {
  const A = [...new Set(aTokens.map(w => w.slice(0, 4)))];
  const B = new Set(bTokens.map(w => w.slice(0, 4)));
  if (!A.length || !B.size) return 0;
  const inter = A.filter(x => B.has(x)).length;
  return inter / (A.length + B.size - inter);
}

// Associer un match ESPN à un match Winamax : même heure de coup d'envoi (± 15 min)
// ET un nom qui ressemble des deux côtés (domicile et extérieur).
function trouveWinamax(fixture, evsWinamax) {
  const t = new Date(fixture.date).getTime();
  const tHome = normEquipe(fixture.home).concat(normEquipe(fixture.homeCourt));
  const tAway = normEquipe(fixture.away).concat(normEquipe(fixture.awayCourt));
  let best = null, bestScore = 0;
  for (const e of evsWinamax) {
    if (Math.abs(new Date(e.start).getTime() - t) > 15 * 60000) continue;
    const sH = ressemblanceNoms(tHome, e.tokensHome), sA = ressemblanceNoms(tAway, e.tokensAway);
    if (sH === 0 || sA === 0) continue;
    if (sH + sA > bestScore) { bestScore = sH + sA; best = e; }
  }
  return best;
}

// Lire les cotes « Expulsión » (sí/no) d'un match Winamax
async function winamaxCotesCarton(matchId) {
  try {
    const etat = winamaxEtatPage(await httpTexte(`${WINAMAX}/match/${matchId}`, WINAMAX_UA));
    if (!etat || !etat.bets) return null;
    const pari = Object.values(etat.bets).find(b => b.matchId === matchId && b.marketId === WINAMAX_MARCHE_EXPULSION && b.available !== false);
    if (!pari) return null;
    let coteNon = null, coteOui = null;
    for (const id of (pari.outcomes || [])) {
      const libelle = String(etat.outcomes?.[id]?.label || '').trim();
      const cote = Number(etat.odds?.[id]);
      if (!(cote > 1)) continue;
      if (/^no$/i.test(libelle)) coteNon = cote;
      if (/^s[ií]$/i.test(libelle)) coteOui = cote;
    }
    if (coteNon == null && coteOui == null) return null;
    return { coteNon, coteOui };
  } catch (e) { return null; }
}

module.exports = {
  LIGUES_META, saisonCourante, pause,
  espnMatchs, espnDetail, espnClassement,
  espnLiveLigue, espnCartesLive, minuteDepuisHorloge, minuteCourante,
  pinnacleMarcheCarton,
  kambiEvenements, trouveKambi, kambiCotesCarton, normEquipe, jaccard, httpJson,
  winamaxEvenements, trouveWinamax, winamaxCotesCarton,
};
