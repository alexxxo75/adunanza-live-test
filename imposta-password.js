// © 2026 Alessandro Castiglioni. Tutti i diritti riservati.
// POST /api/account/imposta-password   corpo: { password }   Authorization: Bearer <token del link>
// Serve a chi ha la verifica in due passaggi (2FA) attiva: Supabase rifiuta il cambio password
// da una sessione "normale" (aal1), e la sessione aperta dal link di recupero è proprio aal1.
// La prova di identità qui è il link ricevuto per email: accettiamo SOLO token nati da un
// link (recupero/invito), recenti. Un token ottenuto con la sola password NON basta.
// Il 2FA resta obbligatorio al successivo accesso.
import { errore, clienteServer, leggiCorpo, rispondiErrore } from '../../lib/supabase.js';

const METODI_LINK = ['recovery', 'invite', 'otp', 'magiclink'];
const FINESTRA_SEC = 2 * 60 * 60; // il link deve essere stato usato nelle ultime 2 ore

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw errore(405, 'Metodo non consentito.');
    const intestazione = req.headers['authorization'] || '';
    const token = intestazione.startsWith('Bearer ') ? intestazione.slice(7).trim() : '';
    if (!token) throw errore(401, 'Link non valido o scaduto. Richiedi un nuovo recupero password.');

    let claims = null;
    try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch (e) { claims = null; }
    const adesso = Math.floor(Date.now() / 1000);
    const amr = (claims && Array.isArray(claims.amr)) ? claims.amr : [];
    const daLink = amr.some(a => a && METODI_LINK.includes(a.method) && (adesso - Number(a.timestamp || 0)) <= FINESTRA_SEC);
    const daPassword = amr.some(a => a && (a.method === 'password' || a.method === 'totp'));
    if (!daLink || daPassword) throw errore(403, 'Questa operazione è consentita solo dal link ricevuto per email. Richiedi un nuovo recupero password.');

    const password = String((leggiCorpo(req)).password || '');
    if (password.length < 12) throw errore(400, 'La password deve avere almeno 12 caratteri.');
    if (password.length > 200) throw errore(400, 'Password troppo lunga.');

    const db = clienteServer();
    const { data, error } = await db.auth.getUser(token);
    if (error || !data || !data.user) throw errore(401, 'Link non valido o scaduto. Richiedi un nuovo recupero password.');

    const { data: profilo } = await db.from('amministratori').select('id, attivo').eq('id', data.user.id).maybeSingle();
    if (profilo && !profilo.attivo) throw errore(403, 'Account disattivato.');

    const { error: errUp } = await db.auth.admin.updateUserById(data.user.id, { password });
    if (errUp) {
      const m = errUp.message || '';
      if (/same|different from the old/i.test(m)) throw errore(400, 'Scegli una password diversa dalla precedente.');
      if (/weak|short|at least/i.test(m)) throw errore(400, 'La password non è abbastanza robusta.');
      console.error('Impostazione password non riuscita:', errUp);
      throw errore(502, 'Impossibile salvare la password.');
    }

    const { error: errReg } = await db.from('registro_operazioni').insert({
      eseguita_da: data.user.id, operazione: 'password_da_link', su_amministratore: data.user.id, dettagli: {}
    });
    if (errReg) console.error('Registro operazioni non aggiornato:', errReg);

    res.status(200).json({ ok: true });
  } catch (e) {
    rispondiErrore(res, e);
  }
}
