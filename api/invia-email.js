// © 2026 Alessandro Castiglioni. Tutti i diritti riservati.
// LT-346: link agli allegati della convocazione (firmati qui, con la chiave segreta)
import { clienteServer } from '../lib/supabase.js';
import { sostituisciLinkAllegati, trovaLinkAllegati } from '../lib/allegati.js';

// /api/invia-email.js — funzione serverless Vercel (Node.js, nessun framework richiesto)
//
// Manda le email di Riunion: convocazioni, inviti agli ospiti, deleghe, verbali.
// La chiave resta SEMPRE qui sul server, non compare mai nel file HTML che gira nel browser.
//
// ===================== COSA SOSTITUISCE =====================
// Fino alla LT-317 le email partivano da EmailJS, direttamente dal browser, appoggiandosi a una
// casella Gmail personale. Tre problemi, in ordine di gravità:
//   1. partivano dall'indirizzo sbagliato — un amministratore non può convocare un'assemblea da
//      una casella che non è la sua;
//   2. partivano dal browser, quindi chiudere la finestra a metà invio lasciava indietro i
//      condòmini rimanenti, e la chiave era leggibile da chiunque aprisse la pagina;
//   3. Gmail ha un tetto giornaliero suo, e quando scatta non te lo dice: lo scopri dai
//      condòmini che non hanno ricevuto la convocazione.
// Ora le email partono da qui, con il dominio riunion.it autenticato (SPF, DKIM, DMARC) e un
// fornitore che tiene il registro di cosa è stato consegnato e cosa è rimbalzato.
//
// ===================== COSA RICEVE =====================
//   { token, destinatari, oggetto, testoHtml, nomeMittente, rispondiA }
//   token        -> il biglietto della sessione dell'amministratore collegato
//   destinatari  -> elenco di indirizzi (uno per le convocazioni, più d'uno per le deleghe)
//   oggetto      -> l'oggetto dell'email
//   testoHtml    -> il corpo come lo compone l'applicazione: testo normale con dentro, dove
//                   servono, i collegamenti già pronti. NON va ripulito dai tag: quei link
//                   devono restare cliccabili.
//   nomeMittente -> il nome dello studio che il condòmino vede come mittente
//   rispondiA    -> l'indirizzo dell'amministratore: se il condòmino risponde, scrive a lui
//
// ===================== VARIABILI D'AMBIENTE USATE =====================
//   BREVO_API_KEY             -> la chiave del conto Brevo (segreta)
//   EMAIL_MITTENTE            -> l'indirizzo da cui partono le email, es. convocazioni@riunion.it
//                                Deve stare su un dominio autenticato presso il fornitore.
//   EMAIL_FORNITORE           -> "brevo" (predefinito). Predisposto per cambiare fornitore
//                                senza toccare l'applicazione, come VIDEO_FORNITORE.
//   SUPABASE_URL              -> già presente, usata anche da /api/config
//   SUPABASE_PUBLISHABLE_KEY  -> già presente, usata anche da /api/config

const MAX_DESTINATARI = 60;      // un condominio grande sta dentro; oltre, è un errore o un abuso
const MAX_OGGETTO = 300;
const MAX_CORPO = 200000;

// L'assemblea della cartella degli allegati deve essere di chi chiama: la si cerca con il SUO
// biglietto, quindi passano le regole del database (un'assemblea di altri non viene trovata).
async function assembleaDiChiChiama(token, idAssemblea) {
  const url = process.env.SUPABASE_URL, chiavePubblica = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !chiavePubblica || !/^[0-9a-f-]{36}$/i.test(String(idAssemblea || ''))) return false;
  try {
    const r = await fetch(url.replace(/\/+$/, '') + '/rest/v1/assemblee?select=id&id=eq.' + idAssemblea, {
      headers: { apikey: chiavePubblica, Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return false;
    const righe = await r.json();
    return Array.isArray(righe) && righe.length === 1;
  } catch (e) { return false; }
}

function riassunto(testo) {
  if (!testo) return 'nessun dettaglio';
  return String(testo).replace(/\s+/g, ' ').trim().slice(0, 400);
}

// Controllo minimo sulla forma dell'indirizzo: non serve a validare che esista — a quello
// pensa il fornitore, che ci dirà se è rimbalzato — ma a non mandare spazzatura alle sue API.
function indirizzoPlausibile(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());
}

// Versione in solo testo del corpo. Serve per due motivi: alcuni programmi di posta la
// preferiscono, e un'email che ha solo la parte HTML viene guardata con più sospetto dai filtri
// antispam. I collegamenti vengono riscritti come "testo (indirizzo)", così chi legge la
// versione semplice non perde il link per entrare in assemblea.
function versioneTestoSemplice(html) {
  return String(html || '')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, testo) => {
      const pulito = testo.replace(/<[^>]*>/g, '').trim();
      return pulito && pulito !== url ? `${pulito}: ${url}` : url;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/tr>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Il corpo in HTML: il testo dell'applicazione usa gli "a capo" semplici, che in un'email non
// si vedono se non vengono trasformati. Carattere e larghezza sono quelli di sempre.
function corpoHtml(testoHtml) {
  const conACapo = String(testoHtml || '').replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2B2E33;max-width:600px;">'
    + conACapo + '</div>';
}

// Verifica presso Supabase che il biglietto appartenga a un utente davvero collegato: senza,
// questo indirizzo sarebbe un modo per mandare email a chiunque a spese nostre, e per far
// comparire il nome di un amministratore come mittente.
async function bigliettoValido(token) {
  const url = process.env.SUPABASE_URL;
  const chiavePubblica = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !chiavePubblica || !token) return false;
  try {
    const r = await fetch(url.replace(/\/+$/, '') + '/auth/v1/user', {
      headers: { apikey: chiavePubblica, Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return false;
    const dati = await r.json();
    return !!(dati && dati.id);
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// I fornitori. Oggi ce n'è uno solo, ma la forma è la stessa del video e del verbale: il
// giorno in cui converrà passare ad Amazon SES (dieci centesimi ogni mille email contro i
// ventinove dollari al mese di un abbonamento) si aggiunge una voce qui e si cambia una parola
// su Vercel. Non è stato scritto prima perché Amazon richiede una firma crittografica delle
// richieste, e codice non provato è peggio di codice assente.
// ---------------------------------------------------------------------------
const FORNITORI = {
  brevo: {
    nome: 'Brevo',
    variabileChiave: 'BREVO_API_KEY',
    async invia({ chiave, mittente, nomeMittente, destinatari, oggetto, html, testo, rispondiA }) {
      const corpo = {
        sender: { email: mittente, name: nomeMittente || mittente },
        to: destinatari.map(e => ({ email: e })),
        subject: oggetto,
        htmlContent: html,
        textContent: testo
      };
      if (rispondiA) corpo.replyTo = { email: rispondiA };

      let r;
      try {
        r = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': chiave, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(corpo)
        });
      } catch (e) {
        return { errore: 'Non è stato possibile raggiungere Brevo: ' + riassunto(e && e.message), codice: 502 };
      }

      const grezzo = await r.text();
      let dati = null;
      try { dati = JSON.parse(grezzo); } catch (e) { /* risposta non in JSON */ }

      if (r.ok) return { id: (dati && (dati.messageId || dati.messageIds)) || null };

      const messaggio = (dati && (dati.message || dati.code)) || riassunto(grezzo);
      if (r.status === 401) return { errore: 'Brevo non riconosce la chiave. Controlla la variabile BREVO_API_KEY su Vercel.', codice: 401 };
      if (r.status === 400 && /sender/i.test(messaggio)) {
        return { errore: 'Brevo rifiuta il mittente "' + mittente + '": va aggiunto fra i mittenti autorizzati, sul dominio già autenticato. Dettaglio: ' + riassunto(messaggio), codice: 400 };
      }
      if (r.status === 402 || /credit|quota|limit/i.test(messaggio)) {
        return { errore: 'Brevo ha rifiutato l\'invio: limite di email raggiunto. Dettaglio: ' + riassunto(messaggio), codice: 429 };
      }
      return { errore: 'Brevo ha risposto con un errore (' + r.status + '): ' + riassunto(messaggio), codice: 502 };
    }
  }
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, errore: 'Metodo non consentito, usa POST.' });
    return;
  }

  const { token, destinatari, oggetto, testoHtml, nomeMittente, rispondiA } = req.body || {};

  const nomeFornitore = (process.env.EMAIL_FORNITORE || 'brevo').trim().toLowerCase();
  const f = FORNITORI[nomeFornitore];
  if (!f) {
    res.status(500).json({ ok: false, errore: 'La variabile EMAIL_FORNITORE contiene "' + nomeFornitore + '", che non è un fornitore conosciuto. Il valore ammesso è "brevo".' });
    return;
  }

  const chiave = process.env[f.variabileChiave];
  if (!chiave) {
    res.status(500).json({ ok: false, errore: 'Manca la chiave di ' + f.nome + ' sul server: va creata la variabile ' + f.variabileChiave + ' nelle impostazioni del progetto su Vercel.' });
    return;
  }

  const mittente = (process.env.EMAIL_MITTENTE || '').trim();
  if (!indirizzoPlausibile(mittente)) {
    res.status(500).json({ ok: false, errore: 'Manca la variabile EMAIL_MITTENTE su Vercel, o non contiene un indirizzo valido: va scritto lì l\'indirizzo da cui partono le email (per esempio convocazioni@riunion.it).' });
    return;
  }

  if (!(await bigliettoValido(token))) {
    res.status(401).json({ ok: false, errore: 'Sessione non riconosciuta. Esci e rientra in Riunion, poi riprova.' });
    return;
  }

  const elenco = (Array.isArray(destinatari) ? destinatari : [destinatari])
    .map(e => (typeof e === 'string' ? e.trim() : ''))
    .filter(indirizzoPlausibile);
  const unici = [...new Set(elenco.map(e => e.toLowerCase()))];

  if (unici.length === 0) {
    res.status(400).json({ ok: false, errore: 'Nessun indirizzo email valido fra i destinatari.' });
    return;
  }
  if (unici.length > MAX_DESTINATARI) {
    res.status(413).json({ ok: false, errore: 'Troppi destinatari in un solo invio (' + unici.length + '): il massimo è ' + MAX_DESTINATARI + '.' });
    return;
  }

  const titolo = String(oggetto || '').trim().slice(0, MAX_OGGETTO);
  let corpo = String(testoHtml || '');
  if (!titolo) { res.status(400).json({ ok: false, errore: 'L\'email non ha un oggetto.' }); return; }
  if (!corpo.trim()) { res.status(400).json({ ok: false, errore: 'L\'email non ha un testo.' }); return; }
  if (corpo.length > MAX_CORPO) { res.status(413).json({ ok: false, errore: 'Il testo dell\'email è troppo lungo.' }); return; }

  // LT-346: link agli allegati — solo file nella cartella di un'assemblea di chi chiama
  if (trovaLinkAllegati(corpo).length) {
    let prep;
    try { prep = await sostituisciLinkAllegati(clienteServer(), corpo, aid => assembleaDiChiChiama(token, aid)); }
    catch (e) { prep = { errore: 'Non riesco a preparare i link agli allegati: ' + riassunto(e && e.message) }; }
    if (prep.errore) { res.status(prep.errore.includes('non appartengono') ? 403 : 502).json({ ok: false, errore: prep.errore }); return; }
    corpo = prep.html;
  }

  const esito = await f.invia({
    chiave,
    mittente,
    nomeMittente: String(nomeMittente || '').trim().slice(0, 100),
    destinatari: unici,
    oggetto: titolo,
    html: corpoHtml(corpo),
    testo: versioneTestoSemplice(corpo),
    rispondiA: indirizzoPlausibile(rispondiA) ? String(rispondiA).trim() : null
  });

  if (esito.errore) {
    res.status(esito.codice || 502).json({ ok: false, errore: esito.errore, fornitore: nomeFornitore });
    return;
  }

  res.status(200).json({ ok: true, id: esito.id, destinatari: unici.length, fornitore: nomeFornitore });
}
