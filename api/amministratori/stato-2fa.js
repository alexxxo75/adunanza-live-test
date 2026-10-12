// POST /api/amministratori/stato-2fa   (nessun corpo)
// Dice quali account hanno la verifica in due passaggi ATTIVA (fattore confermato).
// Serve alla pagina /gestione per abilitare l'icona "azzera 2FA" solo dove ha senso.
import { errore, richiediAdministrator, rispondiErrore } from '../../lib/supabase.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw errore(405, 'Metodo non consentito.');
    const { db } = await richiediAdministrator(req);

    const attivi = [];
    for (let pagina = 1; pagina <= 20; pagina++) {   // fino a 20 × 1000 account
      const { data, error } = await db.auth.admin.listUsers({ page: pagina, perPage: 1000 });
      if (error) throw errore(502, 'Impossibile leggere lo stato della verifica in due passaggi.');
      const utenti = (data && data.users) || [];
      for (const u of utenti) {
        if ((u.factors || []).some(f => f.status === 'verified')) attivi.push(u.id);
      }
      if (utenti.length < 1000) break;
    }
    res.status(200).json({ ok: true, con_2fa: attivi });
  } catch (e) {
    rispondiErrore(res, e);
  }
}
