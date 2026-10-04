// POST /api/amministratori/azzera-2fa   corpo: { id }
// Se un amministratore perde il telefono, un ALTRO ADMINISTRATOR può togliere la sua verifica in
// due passaggi: al prossimo accesso dovrà registrarla di nuovo (obbligatorio se è ADMINISTRATOR).
import { errore, leggiCorpo, richiediAdministrator, rispondiErrore } from '../../lib/supabase.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw errore(405, 'Metodo non consentito.');
    const { db, profilo } = await richiediAdministrator(req);

    const corpo = leggiCorpo(req);
    const id = String(corpo.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw errore(400, 'Account non valido.');
    if (id === profilo.id) throw errore(400, 'Per il tuo account usa la pagina Sicurezza. Un altro ADMINISTRATOR può azzerare il tuo.');

    const { data: bersaglio, error: errCerca } = await db
      .from('amministratori').select('id, ruolo, email').eq('id', id).maybeSingle();
    if (errCerca) throw errore(500, 'Errore nella ricerca dell\'account.');
    if (!bersaglio) throw errore(404, 'Account non trovato.');

    const { data: elenco, error: errElenco } = await db.auth.admin.mfa.listFactors({ userId: id });
    if (errElenco) throw errore(502, 'Impossibile leggere i fattori dell\'account.');
    const fattori = (elenco && elenco.factors) || [];
    for (const f of fattori) {
      const { error: errDel } = await db.auth.admin.mfa.deleteFactor({ id: f.id, userId: id });
      if (errDel) throw errore(502, 'Impossibile rimuovere la verifica in due passaggi.');
    }

    const { error: errReg } = await db.from('registro_operazioni').insert({
      eseguita_da: profilo.id,
      operazione: 'azzera_2fa',
      su_amministratore: id,
      dettagli: { email: bersaglio.email, fattori_rimossi: fattori.length }
    });
    if (errReg) console.error('Registro operazioni non aggiornato:', errReg);

    res.status(200).json({ ok: true, rimossi: fattori.length });
  } catch (e) {
    rispondiErrore(res, e);
  }
}
