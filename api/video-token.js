// /api/video-token.js — funzione serverless Vercel (Node.js, nessun framework richiesto)
//
// Genera un link di ingresso alla videochiamata Digital Samba con il ruolo giusto
// (moderatore per l'amministratore, partecipante per i condòmini e gli ospiti). Le
// credenziali (Team ID e Developer Key) restano SEMPRE qui sul server, mai nel file
// HTML/JS che gira nel browser — impostale come variabili d'ambiente su Vercel:
//   DIGITALSAMBA_TEAM_ID          -> il tuo Team ID
//   DIGITALSAMBA_DEVELOPER_KEY    -> la tua Developer Key
//   DIGITALSAMBA_ROOM_URL         -> (opzionale) stanza di riserva, default "demo-room"
//
// UNA STANZA DIVERSA PER OGNI ASSEMBLEA (introdotto con LT-279).
// Prima esisteva una sola stanza fissa ("demo-room") condivisa da tutti: due assemblee
// nello stesso momento avrebbero riversato tutti i partecipanti nella stessa
// videochiamata. Ora il browser manda anche il campo "stanza", questa funzione la cerca
// su Digital Samba e — se non esiste ancora — la crea al volo, poi genera il token come
// prima. Se il campo "stanza" non arriva (versioni vecchie del file HTML), si continua a
// usare la stanza di riserva: nulla si rompe.
//
// Le stanze create qui sono PRIVATE: senza un token generato da questa funzione non ci
// si entra, nemmeno conoscendo l'indirizzo.
//
// CORREZIONI DI QUESTA VERSIONE (dopo la prima prova dal vivo su LT-281):
//  1) NOMI DI STANZA TROPPO LUNGHI. Gli identificativi di condominio e assemblea sono
//     numeri lunghissimi (derivano dall'orologio), e il nome che ne usciva arrivava a 34
//     caratteri: Digital Samba lo rifiutava. Ora, se il nome supera i 30 caratteri, viene
//     accorciato in modo RIPETIBILE (stesso nome in ingresso -> sempre stesso nome in
//     uscita), così tutti i partecipanti della stessa assemblea finiscono comunque nella
//     stessa stanza. L'accorciamento avviene QUI e non nel file HTML, così il file HTML
//     non va ricaricato.
//  2) ERRORI CIECHI. Prima, quando Digital Samba rifiutava qualcosa, il motivo restava
//     nascosto e il messaggio a schermo diceva solo "non sono riuscito". Ora la risposta
//     vera di Digital Samba viene riportata dentro il messaggio che l'utente legge.
//  3) SECONDO TENTATIVO SENZA RUOLI. Se la creazione fallisce indicando i ruoli, la stanza
//     viene ricreata senza specificarli, lasciando quelli predefiniti del team.

// Riassume una risposta di errore per mostrarla a schermo: niente a capo, lunghezza limitata.
function riassunto(testo) {
  if (!testo) return 'nessun dettaglio';
  return String(testo).replace(/\s+/g, ' ').trim().slice(0, 300);
}

// Impronta corta e ripetibile di una stringa (algoritmo FNV-1a): serve solo ad accorciare
// nomi troppo lunghi mantenendoli univoci, non ha alcuno scopo di sicurezza.
function improntaBreve(testo) {
  let h = 0x811c9dc5;
  for (let i = 0; i < testo.length; i++) {
    h ^= testo.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// Ripulisce il nome stanza che arriva dal browser: solo lettere minuscole, cifre e
// trattini. È una misura di sicurezza, non un capriccio — quel valore finisce dentro
// l'indirizzo di una chiamata all'API di Digital Samba, e non deve poter contenere
// caratteri capaci di alterarla (es. "../" o uno spazio). Poi lo accorcia se necessario.
function pulisciNomeStanza(valore) {
  if (typeof valore !== 'string') return null;
  let pulito = valore.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+/, '');
  if (pulito.length < 3) return null;
  if (pulito.length > 30) {
    pulito = pulito.slice(0, 18).replace(/-+$/, '') + '-' + improntaBreve(pulito);
  }
  return pulito;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metodo non consentito, usa POST.' });
    return;
  }

  const { ruolo, nome, stanza } = req.body || {};
  if (ruolo !== 'moderatore' && ruolo !== 'partecipante') {
    res.status(400).json({ error: 'Il campo "ruolo" deve essere "moderatore" o "partecipante".' });
    return;
  }

  const TEAM_ID = process.env.DIGITALSAMBA_TEAM_ID;
  const DEV_KEY = process.env.DIGITALSAMBA_DEVELOPER_KEY;
  const STANZA_DI_RISERVA = process.env.DIGITALSAMBA_ROOM_URL || 'demo-room';

  if (!TEAM_ID || !DEV_KEY) {
    res.status(500).json({ error: 'Credenziali Digital Samba non configurate: manca DIGITALSAMBA_TEAM_ID o DIGITALSAMBA_DEVELOPER_KEY tra le variabili d\'ambiente su Vercel.' });
    return;
  }

  const authHeader = 'Basic ' + Buffer.from(`${TEAM_ID}:${DEV_KEY}`).toString('base64');
  const ruoloDigitalSamba = ruolo === 'moderatore' ? 'moderator' : 'attendee';

  // Se il browser non manda nessuna stanza (o ne manda una non valida), si torna al
  // comportamento di prima: la stanza unica di riserva.
  const nomeStanza = pulisciNomeStanza(stanza) || STANZA_DI_RISERVA;
  const eStanzaDiAssemblea = nomeStanza !== STANZA_DI_RISERVA;

  // Cerca una stanza per nome. Restituisce i dati della stanza, oppure null se non esiste.
  async function cercaStanza() {
    const risposta = await fetch(`https://api.digitalsamba.com/api/v1/rooms/${nomeStanza}`, {
      headers: { Authorization: authHeader }
    });
    if (risposta.ok) return await risposta.json();
    if (risposta.status === 404) return null;
    // Qualsiasi altro errore (credenziali sbagliate, servizio non raggiungibile) NON è un
    // "non esiste": lo segnaliamo come errore vero, senza provare a creare una stanza che
    // quasi certamente fallirebbe allo stesso modo.
    const errore = new Error('Ricerca della stanza fallita (codice ' + risposta.status + '): ' + riassunto(await risposta.text()));
    throw errore;
  }

  // Crea la stanza. "conRuoli" alla prima chiamata; in caso di rifiuto si riprova senza,
  // lasciando i ruoli predefiniti del team.
  async function creaStanza(conRuoli) {
    const corpo = conRuoli
      ? { friendly_url: nomeStanza, privacy: 'private', roles: ['moderator', 'attendee'], default_role: 'attendee' }
      : { friendly_url: nomeStanza, privacy: 'private' };
    const risposta = await fetch('https://api.digitalsamba.com/api/v1/rooms', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    });
    if (risposta.ok) return { dati: await risposta.json(), errore: null };
    return { dati: null, errore: 'codice ' + risposta.status + ': ' + riassunto(await risposta.text()) };
  }

  try {
    let datiStanza = await cercaStanza();

    // La stanza dell'assemblea non esiste ancora: la creiamo adesso. Succede una sola volta
    // per assemblea, alla prima persona che apre il video (di solito l'amministratore).
    if (!datiStanza && eStanzaDiAssemblea) {
      let tentativo = await creaStanza(true);
      let motivi = [];
      if (!tentativo.dati) {
        motivi.push('con ruoli -> ' + tentativo.errore);
        // Caso normale, non un guasto: due persone hanno aperto il video nello stesso
        // istante e la stanza l'ha già creata l'altra richiesta. Prima di insistere,
        // ricontrolliamo se nel frattempo è comparsa.
        datiStanza = await cercaStanza();
        if (!datiStanza) {
          tentativo = await creaStanza(false);
          if (!tentativo.dati) motivi.push('senza ruoli -> ' + tentativo.errore);
        }
      }
      if (!datiStanza && tentativo.dati) datiStanza = tentativo.dati;
      if (!datiStanza) {
        res.status(502).json({
          error: 'Digital Samba ha rifiutato la creazione della stanza "' + nomeStanza + '" (' + nomeStanza.length + ' caratteri). ' + motivi.join(' | '),
          stanza: nomeStanza
        });
        return;
      }
    }

    if (!datiStanza) {
      res.status(502).json({ error: 'La stanza di riserva "' + nomeStanza + '" non esiste su Digital Samba. Controlla il valore di DIGITALSAMBA_ROOM_URL su Vercel.' });
      return;
    }

    // Genero il token di ingresso per questa persona, con il ruolo richiesto.
    // Validità: 6 ore, più che sufficiente per un'assemblea condominiale.
    const rispostaToken = await fetch(`https://api.digitalsamba.com/api/v1/rooms/${datiStanza.id}/token`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        u: (nome && String(nome).trim()) || (ruolo === 'moderatore' ? 'Amministratore' : 'Condòmino'),
        role: ruoloDigitalSamba,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 6
      })
    });
    if (!rispostaToken.ok) {
      res.status(502).json({ error: 'Stanza "' + nomeStanza + '" pronta, ma Digital Samba ha rifiutato il token di ingresso (codice ' + rispostaToken.status + '): ' + riassunto(await rispostaToken.text()) });
      return;
    }
    const datiToken = await rispostaToken.json();

    const urlStanza = datiStanza.room_url || `https://${TEAM_ID}.digitalsamba.com/${nomeStanza}`;
    const urlConToken = `${urlStanza}?token=${encodeURIComponent(datiToken.token)}`;

    res.status(200).json({ url: urlConToken, urlStanza, stanza: nomeStanza });
  } catch (e) {
    res.status(500).json({ error: 'Errore nel preparare l\'ingresso: ' + riassunto(e && e.message ? e.message : e) });
  }
}
