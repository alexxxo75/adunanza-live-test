// POST /api/amministratori/stato-2fa   (nessun corpo)
// Dice quali account hanno la verifica in due passaggi ATTIVA (fattore confermato).
// Serve alla pagina /gestione per abilitare l'icona "azzera 2FA" solo dove ha senso.
// Usa lo stesso metodo di azzera-2fa (mfa.listFactors per singolo account), che è affidabile.
import { errore, richiediAdministrator, rispondiErrore } from '../../lib/supabase.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw errore(405, 'Metodo non consentito.');
    const { db } = await richiediAdministrator(req);

    const { data: righe, error: errElenco } = await db.from('amministratori').select('id');
    if (errElenco) throw errore(500, 'Impossibile leggere l\'elenco degli amministratori.');

    const attivi = [];
    await Promise.all((righe || []).map(async (r) => {
      const { data, error } = await db.auth.admin.mfa.listFactors({ userId: r.id });
      if (error) return;   // in dubbio: non lo segno come attivo
      if (((data && data.factors) || []).some(f => f.status === 'verified')) attivi.push(r.id);
    }));
    res.status(200).json({ ok: true, con_2fa: attivi });
  } catch (e) {
    rispondiErrore(res, e);
  }
}
