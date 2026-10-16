// ============================================================================
//  envoi-winamax.js — lancé par TON PC (tâche planifiée Windows, toutes les 30 min)
//
//  Pourquoi : Winamax Espagne bloque les serveurs de GitHub, mais répond à ton PC.
//  Donc c'est ton PC qui lit les cotes « Expulsión » (carton rouge oui/non) et les
//  range dans donnees/cotes-winamax.json ; le passage GitHub les reprend ensuite.
//
//    node envoi-winamax.js            -> lit les cotes et écrit le fichier (rien n'est envoyé)
//    node envoi-winamax.js --envoyer  -> idem, puis envoie le fichier sur GitHub
// ============================================================================
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('./fournisseurs.js');

const FICHIER = path.join(__dirname, 'donnees', 'cotes-winamax.json');
const HORIZON_JOURS = 3;   // on ne lit que les matchs des 3 prochains jours

const git = (...args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function litCotes() {
  const maintenant = Date.now();
  const resultat = { maj: new Date().toISOString(), ligues: {} };
  const journal = [];
  for (const meta of F.LIGUES_META) {
    const evs = await F.winamaxEvenements(meta.winamax);
    const proches = evs.filter(e => {
      const t = new Date(e.start).getTime();
      return t > maintenant && t <= maintenant + HORIZON_JOURS * 24 * 3600 * 1000;
    });
    const matchs = [];
    for (const e of proches) {
      const c = await F.winamaxCotesCarton(e.id);
      if (c && (c.coteNon || c.coteOui)) {
        matchs.push({ id: e.id, home: e.home, away: e.away, start: e.start, coteNon: c.coteNon, coteOui: c.coteOui });
      }
      await F.pause(300);
    }
    resultat.ligues[meta.il] = matchs;
    journal.push(`${meta.nom} : ${evs.length} matchs lus, ${proches.length} dans les ${HORIZON_JOURS} jours, ${matchs.length} avec la cote carton`
      + (F.winamaxErreur() ? ` — problème : ${F.winamaxErreur()}` : ''));
  }
  return { resultat, journal };
}

function envoie() {
  git('add', 'donnees/cotes-winamax.json');
  try { git('diff', '--cached', '--quiet'); return 'rien de nouveau à envoyer'; } catch (e) { /* il y a du changement */ }
  git('commit', '-q', '-m', `Cotes Winamax lues depuis le PC ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  // Le passage GitHub peut avoir envoyé sa propre mise à jour entre-temps : on se recale puis on réessaie une fois
  try { git('push', '-q'); }
  catch (e) { git('pull', '--rebase', '-q'); git('push', '-q'); }
  return 'envoyé sur GitHub';
}

(async () => {
  const envoyer = process.argv.includes('--envoyer');
  try {
    if (envoyer) git('pull', '--rebase', '-q');   // se mettre à jour avant d'écrire
    const { resultat, journal } = await litCotes();
    journal.forEach(l => console.log(l));
    const total = Object.values(resultat.ligues).reduce((n, l) => n + l.length, 0);
    // Si Winamax n'a rien répondu du tout, on n'écrase pas le fichier précédent
    const toutVide = F.LIGUES_META.every(m => resultat.ligues[m.il].length === 0) && F.winamaxErreur();
    if (toutVide) { console.log('Winamax ne répond pas : fichier précédent conservé.'); process.exitCode = 1; return; }
    fs.writeFileSync(FICHIER, JSON.stringify(resultat, null, 1), 'utf8');
    console.log(`${total} matchs avec cote écrits dans donnees/cotes-winamax.json`);
    if (envoyer) console.log(envoie());
  } catch (e) {
    console.log('ERREUR : ' + (e.stderr || e.message || e));
    process.exitCode = 1;
  }
})();
