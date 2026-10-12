// POST /api/amministratori/modifica   corpo: { id, nome, cognome, email, ruolo }
// Solo un ADMINISTRATOR attivo. Modifica nome, cognome, email e ruolo di un ALTRO account.
// L'email è anche il nome di accesso: va cambiata sia in Supabase Auth sia nella tabella
// "amministratori", altrimenti i due elenchi si disallineano e l'accesso si rompe.
import { errore, leggiCorpo, richiediAdministrator, rispondiErrore } from '../../lib/supabase.js';

const RUOLI = ['amministratore', 'administrator'];
const EMAIL_VALIDA = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw errore(405, 'Metodo non consentito.');
    const { db, profilo } = await richiediAdministrator(req);

    const corpo = leggiCorpo(req);
    const id = String(corpo.id || '');
    const nome = String(corpo.nome || '').trim().slice(0, 120);
    const cognome = String(corpo.cognome || '').trim().slice(0, 120);
    const email = String(corpo.email || '').trim().toLowerCase();
    const ruolo = String(corpo.ruolo || '');

    if (!/^[0-9a-f-]{36}$/i.test(id)) throw errore(400, 'Account non valido.');
    if (id === profilo.id) throw errore(400, 'Per i tuoi dati usa "Il mio profilo". Un altro ADMINISTRATOR può modificare i tuoi.');
    if (!nome) throw errore(400, 'Inserisci almeno il nome.');
    if (!EMAIL_VALIDA.test(email) || email.length > 254) throw errore(400, 'Indirizzo email non valido.');
    if (!RUOLI.includes(ruolo)) throw errore(400, 'Ruolo non valido.');

    const { data: att, error: errCerca } = await db
      .from('amministratori').select('id, nome, cognome, email, ruolo').eq('id', id).maybeSingle();
    if (errCerca) throw errore(500, 'Errore nella ricerca dell\'account.');
    if (!att) throw errore(404, 'Account non trovato.');

    const cambiaEmail = email !== String(att.email || '').toLowerCase();
    if (cambiaEmail) {
      const { data: doppio, error: errDoppio } = await db
        .from('amministratori').select('id').eq('email', email).neq('id', id).maybeSingle();
      if (errDoppio) throw errore(500, 'Errore nel controllo dell\'email.');
      if (doppio) throw errore(409, 'Esiste già un account con questa email.');

      // email_confirm: true = cambio immediato, senza mail di conferma al nuovo indirizzo.
      const { error: errAuth } = await db.auth.admin.updateUserById(id, { email, email_confirm: true });
      if (errAuth) {
        console.error('Cambio email in Auth non riuscito:', errAuth);
        if ((errAuth.code === 'email_exists') || /already|registered/i.test(errAuth.message || '')) {
          throw errore(409, 'Questa email risulta già registrata.');
        }
        throw errore(502, 'Impossibile cambiare l\'email di accesso. ' + (errAuth.message ? '(' + errAuth.message + ')' : ''));
      }
    }

    const { error: errSalva } = await db
      .from('amministratori').update({ nome, cognome, email, ruolo }).eq('id', id);
    if (errSalva) {
      console.error('Salvataggio modifiche non riuscito:', errSalva);
      if (cambiaEmail) {   // niente account "a metà": si rimette la vecchia email
        const { error: errRip } = await db.auth.admin.updateUserById(id, { email: att.email, email_confirm: true });
        if (errRip) console.error('RIPRISTINO EMAIL FALLITO per', id, errRip);
      }
      throw errore(500, 'Modifica annullata per un errore nel salvataggio. Riprova.');
    }

    const { error: errReg } = await db.from('registro_operazioni').insert({
      eseguita_da: profilo.id,
      operazione: 'modifica_dati',
      su_amministratore: id,
      dettagli: {
        prima: { nome: att.nome, cognome: att.cognome, email: att.email, ruolo: att.ruolo },
        dopo: { nome, cognome, email, ruolo }
      }
    });
    if (errReg) console.error('Registro operazioni non aggiornato:', errReg);

    res.status(200).json({ ok: true, email_cambiata: cambiaEmail });
  } catch (e) {
    rispondiErrore(res, e);
  }
}
