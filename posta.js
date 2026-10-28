// © 2026 Alessandro Castiglioni. Tutti i diritti riservati.
// lib/posta.js — strumenti per spedire email dal server (LT-320).
// Usato dalle funzioni che compongono l'email DA SOLE sul server (oggi: /api/email-delega).
// /api/invia-email.js resta com'è: lì il testo lo compone la pagina dell'amministratore.
// Fornitore: Brevo, con le stesse variabili d'ambiente di invia-email (BREVO_API_KEY, EMAIL_MITTENTE).

function riassunto(testo) {
  if (!testo) return 'nessun dettaglio';
  return String(testo).replace(/\s+/g, ' ').trim().slice(0, 400);
}

export function indirizzoPlausibile(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());
}

// Testo normale -> HTML sicuro: niente di quello che arriva dal database viene interpretato
// come codice (un nome con "<" resta un nome), e gli "a capo" diventano visibili.
export function escHtml(testo) {
  return String(testo || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function testoInHtml(testo) {
  const sicuro = escHtml(testo)
    .replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2B2E33;max-width:600px;">' + sicuro + '</div>';
}

// Spedisce UNA email a UN destinatario. Restituisce { ok:true } oppure { errore }.
// "html" è facoltativo (LT-322): se manca, l'HTML si ricava dal testo.
export async function spedisci({ a, oggetto, testo, html, nomeMittente, rispondiA }) {
  const chiave = process.env.BREVO_API_KEY;
  const mittente = (process.env.EMAIL_MITTENTE || '').trim();
  if (!chiave) return { errore: 'Manca la variabile BREVO_API_KEY su Vercel.' };
  if (!indirizzoPlausibile(mittente)) return { errore: 'Manca o non è valida la variabile EMAIL_MITTENTE su Vercel.' };
  if (!indirizzoPlausibile(a)) return { errore: 'Indirizzo del destinatario non valido.' };

  const corpo = {
    sender: { email: mittente, name: String(nomeMittente || 'Riunion').slice(0, 100) },
    to: [{ email: a.trim() }],
    subject: String(oggetto || '').slice(0, 300),
    htmlContent: typeof html === 'string' && html ? html : testoInHtml(testo),
    textContent: String(testo || '')
  };
  if (indirizzoPlausibile(rispondiA)) corpo.replyTo = { email: rispondiA.trim() };

  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': chiave, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(corpo)
    });
    if (r.ok) return { ok: true };
    return { errore: 'Brevo ha risposto con un errore (' + r.status + '): ' + riassunto(await r.text()) };
  } catch (e) {
    return { errore: 'Non è stato possibile raggiungere Brevo: ' + riassunto(e && e.message) };
  }
}
