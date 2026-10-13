// 1) Exporte les coefficients logistiques P(rouge) ~ ecart de classement, par ligue (pour le simulateur)
// 2) Explore d'autres facteurs candidats : periode de saison, lutte pour le maintien,
//    agressivite des equipes, favori a domicile ou non, score final serre.
const fs = require('fs');
const path = require('path');

const DOSSIER = path.join(__dirname, 'donnees', 'classements');
const LIGUES = [
  { code: 'E0', nom: 'Premier League' },
  { code: 'SP1', nom: 'Liga' },
  { code: 'I1', nom: 'Serie A' }
];
const SAISONS = ['2324', '2425', '2526'];

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
function dateFr(d) { const [j, m, a] = d.split('/').map(Number); return a * 10000 + m * 100 + j; }

// --- Observations enrichies ---
const MIN_JOUEES = 5;
const observations = []; // {ligue, gap, rouge, jaunes, journee, posH, posA, jaunesAvantH, jaunesAvantA, margeFinale}
for (const { code } of LIGUES) {
  for (const saisonCode of SAISONS) {
    const matchs = parseCsv(fs.readFileSync(path.join(DOSSIER, `${code}-${saisonCode}.csv`), 'utf8'))
      .filter(m => m.HomeTeam && m.FTHG !== '' && m.HR !== '' && m.AR !== '')
      .sort((a, b) => dateFr(a.Date) - dateFr(b.Date));

    const table = {};
    const assure = (e) => table[e] || (table[e] = { pts: 0, dif: 0, bp: 0, joues: 0, jaunesPris: 0 });

    for (const m of matchs) {
      const h = assure(m.HomeTeam), a = assure(m.AwayTeam);
      if (h.joues >= MIN_JOUEES && a.joues >= MIN_JOUEES) {
        const classement = Object.entries(table)
          .sort(([, x], [, y]) => y.pts - x.pts || y.dif - x.dif || y.bp - x.bp)
          .map(([nom]) => nom);
        const posH = classement.indexOf(m.HomeTeam) + 1;
        const posA = classement.indexOf(m.AwayTeam) + 1;
        observations.push({
          ligue: code,
          gap: Math.abs(posH - posA),
          rouge: (parseInt(m.HR) + parseInt(m.AR)) > 0 ? 1 : 0,
          jaunes: parseInt(m.HY || 0) + parseInt(m.AY || 0),
          journee: Math.round((h.joues + a.joues) / 2) + 1,
          posH, posA,
          nbEquipes: classement.length,
          agressivite: h.jaunesPris / h.joues + a.jaunesPris / a.joues, // jaunes/match des 2 equipes avant le match
          margeFinale: Math.abs(parseInt(m.FTHG) - parseInt(m.FTAG))
        });
      }
      const gh = parseInt(m.FTHG), ga = parseInt(m.FTAG);
      h.joues++; a.joues++; h.bp += gh; a.bp += ga; h.dif += gh - ga; a.dif += ga - gh;
      h.jaunesPris += parseInt(m.HY || 0); a.jaunesPris += parseInt(m.AY || 0);
      if (gh > ga) h.pts += 3; else if (gh < ga) a.pts += 3; else { h.pts++; a.pts++; }
    }
  }
}
console.log(`Observations : ${observations.length}\n`);

// --- Outils statistiques ---
function logistique(obs, xDe) {
  let b0 = -1.7, b1 = 0;
  for (let iter = 0; iter < 60; iter++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (const o of obs) {
      const x = xDe(o), p = 1 / (1 + Math.exp(-(b0 + b1 * x)));
      const e = o.rouge - p, w = p * (1 - p);
      g0 += e; g1 += e * x; h00 += w; h01 += w * x; h11 += w * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    const d0 = (h11 * g0 - h01 * g1) / det, d1 = (h00 * g1 - h01 * g0) / det;
    b0 += d0; b1 += d1;
    if (Math.abs(d0) < 1e-10 && Math.abs(d1) < 1e-10) break;
  }
  let h00 = 0, h01 = 0, h11 = 0;
  for (const o of obs) {
    const x = xDe(o), p = 1 / (1 + Math.exp(-(b0 + b1 * x)));
    const w = p * (1 - p);
    h00 += w; h01 += w * x; h11 += w * x * x;
  }
  const se = Math.sqrt(h00 / (h00 * h11 - h01 * h01));
  const z = b1 / se;
  return { b0, b1, se, z, pval: 2 * (1 - phi(Math.abs(z))) };
}
function phi(x) {
  const t = 1 / (1 + 0.2316419 * x);
  const d = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  return 1 - d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
}
const taux = (obs) => obs.reduce((s, o) => s + o.rouge, 0) / obs.length;
const fmt = (x, d = 1) => (100 * x).toFixed(d) + ' %';

// --- 1. EXPORT des coefficients ecart de classement, par ligue ---
const coeffs = LIGUES.map(({ code, nom }) => {
  const obs = observations.filter(o => o.ligue === code);
  const r = logistique(obs, o => o.gap);
  return { nom, b0: +r.b0.toFixed(5), b1: +r.b1.toFixed(5), taux: +taux(obs).toFixed(5), pval: +r.pval.toFixed(4), n: obs.length };
});
fs.writeFileSync(path.join(__dirname, 'donnees', 'classement-coeffs.json'), JSON.stringify(coeffs, null, 2));
console.log('Coefficients exportes vers donnees/classement-coeffs.json :');
coeffs.forEach(c => console.log(`  ${c.nom} : b0=${c.b0} b1=${c.b1} taux=${c.taux} (p=${c.pval}, n=${c.n})`));

// --- 2. FACTEURS CANDIDATS ---
function rapporte(titre, groupes) {
  console.log(`\n${titre}`);
  for (const [nom, obs] of groupes) {
    if (!obs.length) continue;
    console.log(`  ${nom.padEnd(38)} : ${fmt(taux(obs))} de matchs avec rouge (n=${obs.length}, jaunes/m=${(obs.reduce((s, o) => s + o.jaunes, 0) / obs.length).toFixed(2)})`);
  }
}

// a) Periode de la saison
rapporte('a) PERIODE DE LA SAISON (toutes ligues)', [
  ['journees 6-13 (debut)', observations.filter(o => o.journee <= 13)],
  ['journees 14-25 (milieu)', observations.filter(o => o.journee > 13 && o.journee <= 25)],
  ['journees 26-33 (fin approche)', observations.filter(o => o.journee > 25 && o.journee <= 33)],
  ['journees 34-38 (sprint final)', observations.filter(o => o.journee > 33)]
]);
const rJournee = logistique(observations, o => o.journee);
console.log(`  logistique ~ journee : pente ${rJournee.b1.toFixed(4)} (p=${rJournee.pval.toFixed(4)})`);

// b) Lutte pour le maintien (au moins une equipe dans les 4 dernieres places)
const enDanger = (o) => o.posH > o.nbEquipes - 4 || o.posA > o.nbEquipes - 4;
rapporte('b) LUTTE POUR LE MAINTIEN', [
  ['au moins 1 equipe dans les 4 dern.', observations.filter(enDanger)],
  ['aucune equipe dans les 4 dernieres', observations.filter(o => !enDanger(o))],
  ['duel direct de bas de tableau (2 equipes)', observations.filter(o => o.posH > o.nbEquipes - 6 && o.posA > o.nbEquipes - 6)],
  ['duel direct de haut de tableau (top 6)', observations.filter(o => o.posH <= 6 && o.posA <= 6)]
]);

// c) Agressivite des equipes (jaunes/match cumules des 2 equipes avant le match)
const tri = [...observations].sort((a, b) => a.agressivite - b.agressivite);
const tiers = Math.floor(tri.length / 3);
rapporte('c) AGRESSIVITE DES EQUIPES (jaunes/match des 2 equipes avant le match)', [
  ['tiers le plus calme', tri.slice(0, tiers)],
  ['tiers intermediaire', tri.slice(tiers, 2 * tiers)],
  ['tiers le plus agressif', tri.slice(2 * tiers)]
]);
const rAgr = logistique(observations, o => o.agressivite);
console.log(`  logistique ~ agressivite : pente ${rAgr.b1.toFixed(4)} (p=${rAgr.pval.toFixed(4)})`);
console.log(`  (idem par ligue)`);
for (const { code, nom } of LIGUES) {
  const obs = observations.filter(o => o.ligue === code);
  const r = logistique(obs, o => o.agressivite);
  console.log(`    ${nom} : pente ${r.b1.toFixed(4)} (p=${r.pval.toFixed(4)})`);
}

// d) Favori a domicile ou a l'exterieur (ecart signe, matchs desequilibres seulement)
rapporte('d) OU JOUE LE FAVORI (ecart >= 6 places)', [
  ['favori a domicile', observations.filter(o => o.posA - o.posH >= 6)],
  ['favori a l\'exterieur', observations.filter(o => o.posH - o.posA >= 6)]
]);

// e) Score final serre (indicatif seulement : le rouge influence lui-meme le score)
rapporte('e) MARGE FINALE (attention : causalite inversee possible)', [
  ['match nul ou 1 but d\'ecart', observations.filter(o => o.margeFinale <= 1)],
  ['2 buts d\'ecart', observations.filter(o => o.margeFinale === 2)],
  ['3 buts ou plus', observations.filter(o => o.margeFinale >= 3)]
]);

// f) Croisement : l'agressivite reste-t-elle significative a ecart de classement egal ?
const petitGap = observations.filter(o => o.gap <= 5);
const rAgrPetit = logistique(petitGap, o => o.agressivite);
console.log(`\nf) CONTROLE : agressivite sur les seuls matchs serres (ecart <= 5, n=${petitGap.length}) : pente ${rAgrPetit.b1.toFixed(4)} (p=${rAgrPetit.pval.toFixed(4)})`);