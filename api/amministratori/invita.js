// POST /api/amministratori/invita
// Solo un ADMINISTRATOR attivo può invitare un nuovo amministratore (o un altro ADMINISTRATOR).
// Il nuovo utente riceve un'email con un link per scegliere la propria password.
import { errore, urlSito, leggiCorpo, richiediAdministrator, rispondiErrore } from '../../lib/supabase.js';

const RUOLI = ['amministratore', 'administrator'];
const EMAIL_VALIDA = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw errore(405, 'Metodo non consentito.');
    const { db, profilo } = await richiediAdministrator(req);

    const corpo = leggiCorpo(req);
    const email = String(corpo.email || '').trim().toLowerCase();
    const nome = String(corpo.nome || '').trim().slice(0, 120);
    const cognome = String(corpo.cognome || '').trim().slice(0, 120);
    const ruolo = String(corpo.ruolo || '');

    if (!EMAIL_VALIDA.test(email) || email.length > 254) throw errore(400, 'Indirizzo email non valido.');
    if (!nome) throw errore(400, 'Inserisci almeno il nome.');
    if (!RUOLI.includes(ruolo)) throw errore(400, 'Ruolo non valido.');

    const { data: esistente, error: errCerca } = await db
      .from('amministratori').select('id').eq('email', email).maybeSingle();
    if (errCerca) throw errore(500, 'Errore nel controllo dell\'email.');
    if (esistente) throw errore(409, 'Esiste già un account con questa email.');

    const { data: invito, error: errInvito } = await db.auth.admin.inviteUserByEmail(email, {
      redirectTo: urlSito() + '/imposta-password/',
      data: { nome }
    });
    if (errInvito || !invito || !invito.user) {
      const m = (errInvito && errInvito.message) || '';
      if ((errInvito && errInvito.code === 'email_exists') || /already|registered/i.test(m)) {
        throw errore(409, 'Questa email risulta già registrata in Supabase.');
      }
      console.error('Invito non riuscito:', errInvito);
      throw errore(502, 'Impossibile inviare l\'invito. ' + (m ? '(' + m + ')' : ''));
    }

    const nuovoId = invito.user.id;
    const { error: errSalva } = await db.from('amministratori').insert({
      id: nuovoId, ruolo, email, nome, cognome, creato_da: profilo.id
    });
    if (errSalva) {
      console.error('Salvataggio profilo non riuscito:', errSalva);
      await db.auth.admin.deleteUser(nuovoId); // niente utenti "a metà"
      throw errore(500, 'Invito annullato per un errore nel salvataggio. Riprova.');
    }

    const { error: errReg } = await db.from('registro_operazioni').insert({
      eseguita_da: profilo.id, operazione: 'invito', su_amministratore: nuovoId, dettagli: { ruolo, email }
    });
    if (errReg) console.error('Registro operazioni non aggiornato:', errReg);

    res.status(200).json({ ok: true, id: nuovoId });
  } catch (e) {
    rispondiErrore(res, e);
  }
}
