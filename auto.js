// auto.js — mise à jour automatique, lancée par GitHub (sans ton ordinateur).
//   node auto.js          -> passage léger : arbitres, cotes, résultats des matchs des 3 prochains jours
//   node auto.js complet  -> passage complet : les 3 championnats en entier (classements, nouveaux matchs)
// Prépare aussi le dossier "site/" qui est publié en ligne (page + mémoire).
const fs = require('fs');
const path = require('path');
const moteur = require('./moteur.js');

(async () => {
  const journal = [];
  const complet = process.argv[2] === 'complet';
  try {
    if (complet) await moteur.rafraichit('all', journal);
    await moteur.rafraichitImminents(3 * 24 * 60, journal);
  } catch (e) {
    journal.push('ERREUR : ' + (e && e.message || e));
    process.exitCode = 1;
  }
  journal.forEach(l => console.log(l));

  const etat = moteur.chargeEtat();
  if (!etat) { console.log('Aucune mémoire : rien à publier.'); process.exitCode = 1; return; }
  const site = path.join(__dirname, 'site');
  fs.mkdirSync(site, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'matchs.html'), path.join(site, 'index.html'));
  fs.writeFileSync(path.join(site, 'etat.json'), JSON.stringify(etat), 'utf8');
  // Journal du dernier passage, lisible en ligne (journal.txt) pour comprendre un souci de source
  fs.writeFileSync(path.join(site, 'journal.txt'), [new Date().toISOString(), ...journal].join('\n') + '\n', 'utf8');
  console.log('Site prêt dans site/ (mis à jour le ' + etat.misAJour + ').');
})();
