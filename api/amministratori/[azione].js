// POST /api/amministratori/<azione>
// UNICA funzione server per tutte le operazioni sugli amministratori. Il piano gratuito di Vercel
// accetta al massimo 12 funzioni per deploy (una per ogni file in "api/"): tenerle qui dentro,
// smistate per nome, lascia spazio per quelle future. Gli indirizzi restano quelli di prima.
// La logica di ogni operazione sta in lib/amministratori/<azione>.js (la cartella "lib" non conta).
import azzera2fa from '../../lib/amministratori/azzera-2fa.js';
import invita from '../../lib/amministratori/invita.js';
import modifica from '../../lib/amministratori/modifica.js';
import reinvia from '../../lib/amministratori/reinvia.js';
import stato from '../../lib/amministratori/stato.js';
import statistiche from '../../lib/amministratori/statistiche.js';

const AZIONI = {
  'azzera-2fa': azzera2fa,
  'invita': invita,
  'modifica': modifica,
  'reinvia': reinvia,
  'stato': stato,
  'statistiche': statistiche
};

export default async function handler(req, res) {
  let azione = req.query && req.query.azione;
  if (Array.isArray(azione)) azione = azione[0];
  if (!azione) {
    const m = /\/api\/amministratori\/([^/?#]+)/.exec(req.url || '');
    azione = m ? decodeURIComponent(m[1]) : '';
  }
  const f = Object.prototype.hasOwnProperty.call(AZIONI, azione) ? AZIONI[azione] : null;
  if (!f) return res.status(404).json({ ok: false, errore: 'Operazione non trovata.' });
  return f(req, res);
}
