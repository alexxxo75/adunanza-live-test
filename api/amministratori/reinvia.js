// POST /api/amministratori/reinvia   corpo: { id, modo: 'email' | 'link' }
// Solo un ADMINISTRATOR attivo. Serve per chi ha un invito pendente (non è mai entrato):
//  - modo 'email': rimanda l'email con il link per scegliere la password;
//  - modo 'link' : crea un nuovo link da copiare e consegnare a mano (utile se l'email non arriva).
import { errore, urlSito, leggiCorpo, richiediAdministrator, rispondiErrore } from '../../lib/supabase.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw errore(405, 'Metodo non consentito.');
    const { db, profilo } = await richiediAdministrator(req);

    const corpo = leggiCorpo(req);
    const id = String(corpo.id || '');
    const modo = corpo.modo === 'link' ? 'link' : 'email';
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw errore(400, 'Account non valido.');

    const { data: bersaglio, error: errCerca } = await db
      .from('amministratori').select('id, email, attivo').eq('id', id).maybeSingle();
    if (errCerca) throw errore(500, 'Errore nella ricerca dell\'account.');
    if (!bersaglio) throw errore(404, 'Account non trovato.');
    if (!bersaglio.attivo) throw errore(400, 'L\'account è disattivato: riattivalo prima.');

    const { data: ut, error: errUt } = await db.auth.admin.getUserById(id);
    if (errUt || !ut || !ut.user) throw errore(502, 'Impossibile leggere l\'account.');
    if (ut.user.last_sign_in_at) throw errore(409, 'Questa persona ha già effettuato l\'accesso: per cambiare password usa "Password dimenticata" nella pagina di accesso.');

    const redirectTo = urlSito() + '/imposta-password/';
    let link = null;
    if (modo === 'link') {
      const { data, error } = await db.auth.admin.generateLink({ type: 'recovery', email: bersaglio.email, options: { redirectTo } });
      if (error || !data || !data.properties || !data.properties.action_link) {
        console.error('Link non generato:', error);
        throw errore(502, 'Impossibile creare il link. ' + ((error && error.message) ? '(' + error.message + ')' : ''));
      }
      link = data.properties.action_link;
    } else {
      const { error } = await db.auth.resetPasswordForEmail(bersaglio.email, { redirectTo });
      if (error) {
        console.error('Reinvio non riuscito:', error);
        throw errore(502, 'Impossibile inviare l\'email. ' + (error.message ? '(' + error.message + ')' : ''));
      }
    }

    const { error: errReg } = await db.from('registro_operazioni').insert({
      eseguita_da: profilo.id, operazione: 'reinvio_invito', su_amministratore: id, dettagli: { email: bersaglio.email, modo }
    });
    if (errReg) console.error('Registro operazioni non aggiornato:', errReg);

    res.status(200).json({ ok: true, link });
  } catch (e) {
    rispondiErrore(res, e);
  }
}
