// POST /api/amministratori/stato   corpo: { id, attivo }
// Solo un ADMINISTRATOR attivo può attivare o disattivare un altro account.
// Tra ADMINISTRATOR non ci sono gerarchie: ciascuno può gestire gli altri, ma non se stesso.
import { errore, leggiCorpo, richiediAdministrator, rispondiErrore } from '../../lib/supabase.js';

const BLOCCO_LUNGO = '876000h'; // circa 100 anni: equivale a "bloccato"

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw errore(405, 'Metodo non consentito.');
    const { db, profilo } = await richiediAdministrator(req);

    const corpo = leggiCorpo(req);
    const id = String(corpo.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw errore(400, 'Account non valido.');
    if (typeof corpo.attivo !== 'boolean') throw errore(400, 'Stato non valido.');
    const attivo = corpo.attivo;

    if (id === profilo.id) throw errore(400, 'Non puoi cambiare lo stato del tuo stesso account.');

    const { data: bersaglio, error: errCerca } = await db
      .from('amministratori').select('id, ruolo, attivo, email').eq('id', id).maybeSingle();
    if (errCerca) throw errore(500, 'Errore nella ricerca dell\'account.');
    if (!bersaglio) throw errore(404, 'Account non trovato.');
    if (bersaglio.attivo === attivo) return res.status(200).json({ ok: true, invariato: true });

    let avviso = null;

    if (attivo) {
      // Riattivazione: prima si toglie il blocco di accesso, poi si riattiva l'account.
      const { error: errSblocco } = await db.auth.admin.updateUserById(id, { ban_duration: 'none' });
      if (errSblocco) throw errore(502, 'Impossibile sbloccare l\'accesso dell\'account.');
      const { error: errAttiva } = await db.from('amministratori').update({ attivo: true }).eq('id', id);
      if (errAttiva) throw errore(500, 'Impossibile riattivare l\'account.');
    } else {
      // Disattivazione: prima si spegne l'account (da subito le regole RLS non gli mostrano più
      // nulla), poi si blocca l'accesso così le sessioni già aperte non si rinnovano.
      const { error: errSpegni } = await db.from('amministratori').update({ attivo: false }).eq('id', id);
      if (errSpegni) throw errore(500, 'Impossibile disattivare l\'account.');
      const { error: errBlocco } = await db.auth.admin.updateUserById(id, { ban_duration: BLOCCO_LUNGO });
      if (errBlocco) {
        console.error('Blocco accesso non riuscito:', errBlocco);
        avviso = 'Account disattivato, ma non è stato possibile bloccare le sessioni già aperte: scadranno da sole entro circa un\'ora.';
      }
    }

    const { error: errReg } = await db.from('registro_operazioni').insert({
      eseguita_da: profilo.id,
      operazione: attivo ? 'attivazione' : 'disattivazione',
      su_amministratore: id,
      dettagli: { email: bersaglio.email, ruolo: bersaglio.ruolo }
    });
    if (errReg) console.error('Registro operazioni non aggiornato:', errReg);

    res.status(200).json({ ok: true, avviso });
  } catch (e) {
    rispondiErrore(res, e);
  }
}
