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
// NOVITÀ LT-279 — UNA STANZA DIVERSA PER OGNI ASSEMBLEA.
// Prima esisteva una sola stanza fissa ("demo-room") condivisa da tutti: due assemblee
// nello stesso momento avrebbero riversato tutti i partecipanti nella stessa
// videochiamata. Ora il browser manda anche il campo "stanza" (es. "asm-3-1742..."),
// questa funzione la cerca su Digital Samba e — se non esiste ancora — la crea al volo,
// poi genera il token come prima. Se il campo "stanza" non arriva (versioni vecchie del
// file HTML), si continua a usare la stanza di riserva: nulla si rompe.
//
// Le stanze create qui sono PRIVATE: senza un token generato da questa funzione non ci
// si entra, nemmeno conoscendo l'indirizzo. La vecchia demo-room era pubblica, quindi
// chiunque ne conoscesse l'URL poteva entrare in assemblea.
//
// Il chiamante (il file HTML) manda una POST con { ruolo, nome, stanza } e riceve
// indietro { url, urlStanza, stanza } — "url" è quello pronto da usare come src
// dell'iframe.

// Ripulisce il nome stanza che arriva dal browser: solo lettere minuscole, cifre e
// trattini. È una misura di sicurezza, non un capriccio — quel valore finisce dentro
// l'indirizzo di una chiamata all'API di Digital Samba, e non deve poter contenere
// caratteri capaci di alterarla (es. "../" o uno spazio). Se dopo la pulizia non resta
// nulla di sensato, restituiamo null e il chiamante userà la stanza di riserva.
function pulisciNomeStanza(valore) {
  if (typeof valore !== 'string') return null;
  const pulito = valore.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (pulito.length < 3 || pulito.length > 60) return null;
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
    const dettaglio = await risposta.text();
    const errore = new Error('Ricerca della stanza fallita (codice ' + risposta.status + ').');
    errore.dettaglio = dettaglio;
    throw errore;
  }

  try {
    let datiStanza = await cercaStanza();

    // La stanza dell'assemblea non esiste ancora: la creiamo adesso. Succede una sola volta
    // per assemblea, alla prima persona che apre il video (di solito l'amministratore).
    if (!datiStanza && eStanzaDiAssemblea) {
      const rispostaCreazione = await fetch('https://api.digitalsamba.com/api/v1/rooms', {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          friendly_url: nomeStanza,
          privacy: 'private',
          roles: ['moderator', 'attendee'],
          default_role: 'attendee'
        })
      });
      if (rispostaCreazione.ok) {
        datiStanza = await rispostaCreazione.json();
      } else {
        // Caso normale, non un guasto: due persone hanno aperto il video nello stesso
        // istante, la stanza l'ha creata l'altra richiesta un attimo prima e Digital Samba
        // rifiuta il doppione. Rileggiamo la stanza appena creata dall'altra e proseguiamo.
        datiStanza = await cercaStanza();
        if (!datiStanza) {
          const dettaglio = await rispostaCreazione.text();
          res.status(502).json({ error: 'Non sono riuscito a creare la stanza "' + nomeStanza + '" su Digital Samba.', dettaglio });
          return;
        }
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
      const dettaglio = await rispostaToken.text();
      res.status(502).json({ error: 'Non sono riuscito a generare il token di ingresso.', dettaglio });
      return;
    }
    const datiToken = await rispostaToken.json();

    const urlStanza = datiStanza.room_url || `https://${TEAM_ID}.digitalsamba.com/${nomeStanza}`;
    const urlConToken = `${urlStanza}?token=${encodeURIComponent(datiToken.token)}`;

    res.status(200).json({ url: urlConToken, urlStanza, stanza: nomeStanza });
  } catch (e) {
    res.status(500).json({ error: 'Errore imprevisto nel generare il link di ingresso.', dettaglio: e.dettaglio || String(e) });
  }
}
