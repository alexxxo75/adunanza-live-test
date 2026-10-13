// /api/video-token.js — funzione serverless Vercel (Node.js, nessun framework richiesto)
//
// Prepara il link di ingresso alla videochiamata, con il nome della persona e il ruolo
// giusto (moderatore per l'amministratore, partecipante per condòmini e ospiti).
// Le credenziali restano SEMPRE qui sul server, mai nel file HTML che gira nel browser.
//
// ===================== DUE FORNITORI, UN INTERRUTTORE =====================
// Da questa versione la funzione sa parlare con DUE fornitori di videochiamata, e sceglie
// in base a una variabile d'ambiente su Vercel:
//
//   VIDEO_FORNITORE = digitalsamba   -> come è sempre stato (valore predefinito)
//   VIDEO_FORNITORE = daily          -> usa Daily
//
// Si passa dall'uno all'altro cambiando quella parola nel pannello di Vercel e rilanciando
// la pubblicazione: nessun file da modificare, nessun caricamento su GitHub. Serve a provare
// Daily su un'assemblea vera sapendo che il ritorno indietro costa trenta secondi.
//
// Variabili d'ambiente usate:
//   VIDEO_FORNITORE               -> "digitalsamba" (predefinito) oppure "daily"
//   DIGITALSAMBA_TEAM_ID          -> Team ID di Digital Samba
//   DIGITALSAMBA_DEVELOPER_KEY    -> Developer Key di Digital Samba
//   DIGITALSAMBA_ROOM_URL         -> (opzionale) stanza di riserva, default "demo-room"
//   DAILY_API_KEY                 -> chiave dell'account Daily
//   DAILY_DOMAIN                  -> nome del dominio Daily, es. "riunion" (senza .daily.co)
//
// ===================== COME FUNZIONA, CON ENTRAMBI =====================
// Il browser manda { ruolo, nome, stanza }. Il nome della stanza NON è un dato libero: viene
// calcolato dall'applicazione a partire da condominio e assemblea, così tutti i partecipanti
// della stessa assemblea arrivano allo stesso identico nome senza doversi scambiare nulla.
// Qui la stanza viene cercata e, se non esiste ancora, creata al volo; poi si genera il
// biglietto d'ingresso. Le stanze sono PRIVATE con entrambi i fornitori: senza un biglietto
// generato qui non ci si entra, nemmeno conoscendo l'indirizzo.
//
// La risposta è sempre la stessa, qualunque fornitore: { url, urlStanza, stanza, fornitore }.
// Il file HTML non sa né deve sapere chi sia il fornitore: riceve un indirizzo e lo mette nel
// riquadro del video. È il motivo per cui questo cambio non tocca l'applicazione.

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

// Ripulisce il nome stanza che arriva dal browser: solo lettere minuscole, cifre e trattini.
// È una misura di sicurezza, non un capriccio — quel valore finisce dentro l'indirizzo di una
// chiamata all'API del fornitore, e non deve poter contenere caratteri capaci di alterarla
// (es. "../" o uno spazio). Poi lo accorcia se necessario: gli identificativi di condominio e
// assemblea derivano dall'orologio, quindi sono numeri lunghissimi, e Digital Samba rifiutava
// i nomi oltre una certa lunghezza. L'accorciamento è RIPETIBILE: stesso nome in ingresso,
// sempre stesso nome in uscita, altrimenti i partecipanti finirebbero in stanze diverse.
function pulisciNomeStanza(valore) {
  if (typeof valore !== 'string') return null;
  let pulito = valore.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+/, '');
  if (pulito.length < 3) return null;
  if (pulito.length > 30) {
    pulito = pulito.slice(0, 18).replace(/-+$/, '') + '-' + improntaBreve(pulito);
  }
  return pulito;
}

// ============================================================================
// DIGITAL SAMBA
// ============================================================================
async function ingressoDigitalSamba({ ruolo, nome, stanzaRichiesta }) {
  const TEAM_ID = process.env.DIGITALSAMBA_TEAM_ID;
  const DEV_KEY = process.env.DIGITALSAMBA_DEVELOPER_KEY;
  const STANZA_DI_RISERVA = process.env.DIGITALSAMBA_ROOM_URL || 'demo-room';

  if (!TEAM_ID || !DEV_KEY) {
    return { errore: 'Credenziali Digital Samba non configurate: manca DIGITALSAMBA_TEAM_ID o DIGITALSAMBA_DEVELOPER_KEY tra le variabili d\'ambiente su Vercel.', codice: 500 };
  }

  const authHeader = 'Basic ' + Buffer.from(`${TEAM_ID}:${DEV_KEY}`).toString('base64');
  const ruoloDigitalSamba = ruolo === 'moderatore' ? 'moderator' : 'attendee';
  const nomeStanza = pulisciNomeStanza(stanzaRichiesta) || STANZA_DI_RISERVA;
  const eStanzaDiAssemblea = nomeStanza !== STANZA_DI_RISERVA;

  async function cercaStanza() {
    const risposta = await fetch(`https://api.digitalsamba.com/api/v1/rooms/${nomeStanza}`, {
      headers: { Authorization: authHeader }
    });
    if (risposta.ok) return await risposta.json();
    if (risposta.status === 404) return null;
    throw new Error('Ricerca della stanza fallita (codice ' + risposta.status + '): ' + riassunto(await risposta.text()));
  }

  // "conRuoli" alla prima chiamata; in caso di rifiuto si riprova senza, lasciando i ruoli
  // predefiniti del team.
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

  let datiStanza = await cercaStanza();

  if (!datiStanza && eStanzaDiAssemblea) {
    let tentativo = await creaStanza(true);
    const motivi = [];
    if (!tentativo.dati) {
      motivi.push('con ruoli -> ' + tentativo.errore);
      // Caso normale, non un guasto: due persone hanno aperto il video nello stesso istante e
      // la stanza l'ha già creata l'altra richiesta. Prima di insistere, ricontrolliamo.
      datiStanza = await cercaStanza();
      if (!datiStanza) {
        tentativo = await creaStanza(false);
        if (!tentativo.dati) motivi.push('senza ruoli -> ' + tentativo.errore);
      }
    }
    if (!datiStanza && tentativo.dati) datiStanza = tentativo.dati;
    if (!datiStanza) {
      return { errore: 'Digital Samba ha rifiutato la creazione della stanza "' + nomeStanza + '" (' + nomeStanza.length + ' caratteri). ' + motivi.join(' | '), codice: 502 };
    }
  }

  if (!datiStanza) {
    return { errore: 'La stanza di riserva "' + nomeStanza + '" non esiste su Digital Samba. Controlla il valore di DIGITALSAMBA_ROOM_URL su Vercel.', codice: 502 };
  }

  const rispostaToken = await fetch(`https://api.digitalsamba.com/api/v1/rooms/${datiStanza.id}/token`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      u: nome,
      role: ruoloDigitalSamba,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 6
    })
  });
  if (!rispostaToken.ok) {
    return { errore: 'Stanza "' + nomeStanza + '" pronta, ma Digital Samba ha rifiutato il biglietto d\'ingresso (codice ' + rispostaToken.status + '): ' + riassunto(await rispostaToken.text()), codice: 502 };
  }
  const datiToken = await rispostaToken.json();

  const urlStanza = datiStanza.room_url || `https://${TEAM_ID}.digitalsamba.com/${nomeStanza}`;
  return {
    url: `${urlStanza}?token=${encodeURIComponent(datiToken.token)}`,
    urlStanza,
    stanza: nomeStanza
  };
}

// ============================================================================
// DAILY
// ============================================================================
async function ingressoDaily({ ruolo, nome, stanzaRichiesta }) {
  const API_KEY = process.env.DAILY_API_KEY;
  const DOMINIO = (process.env.DAILY_DOMAIN || '').trim().replace(/\.daily\.co$/i, '');

  if (!API_KEY || !DOMINIO) {
    return { errore: 'Credenziali Daily non configurate: manca DAILY_API_KEY o DAILY_DOMAIN tra le variabili d\'ambiente su Vercel.', codice: 500 };
  }

  const authHeader = 'Bearer ' + API_KEY;
  const nomeStanza = pulisciNomeStanza(stanzaRichiesta);
  if (!nomeStanza) {
    return { errore: 'Non è arrivato un nome di stanza valido: non so a quale assemblea appartiene questa videochiamata.', codice: 400 };
  }

  async function cercaStanza() {
    const risposta = await fetch(`https://api.daily.co/v1/rooms/${nomeStanza}`, {
      headers: { Authorization: authHeader }
    });
    if (risposta.ok) return await risposta.json();
    if (risposta.status === 404) return null;
    throw new Error('Ricerca della stanza fallita (codice ' + risposta.status + '): ' + riassunto(await risposta.text()));
  }

  // Due tentativi: il primo con le impostazioni che vorremmo (interfaccia in italiano, e
  // SPENTE la chat, l'alza-la-mano e l'elenco partecipanti della videochiamata, perché
  // Riunion ha già i suoi e devono finire nel verbale e nell'appello — due chat affiancate
  // confonderebbero e basta). Se Daily rifiutasse una di quelle impostazioni, si riprova
  // con la stanza essenziale: meglio una videochiamata con qualche pulsante di troppo che
  // nessuna videochiamata.
  async function creaStanza(conImpostazioni) {
    const corpo = conImpostazioni
      ? {
          name: nomeStanza,
          privacy: 'private',
          properties: {
            lang: 'it',
            enable_prejoin_ui: false,   // Riunion ha già la sua schermata "prima di entrare"
            enable_chat: false,         // Riunion ha la sua chat, e quella finisce nel verbale
            enable_hand_raising: false, // idem per l'alza-la-mano: una mano alzata dentro il
                                        // video l'amministratore non la vedrebbe nell'appello
            // ATTENZIONE, lezione imparata alla prima prova: l'elenco partecipanti di Daily va
            // lasciato ACCESO. Sembrava un doppione dell'elenco di Riunion, ma non lo è: quello
            // di Riunion serve all'appello e al verbale, mentre questo è la plancia da cui
            // l'amministratore zittisce o allontana qualcuno. Spegnendolo gli si tolgono i
            // poteri da moderatore, che è esattamente il contrario di quello che vogliamo.
            enable_people_ui: true,
            enable_screenshare: true
          }
        }
      : { name: nomeStanza, privacy: 'private' };
    const risposta = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    });
    if (risposta.ok) return { dati: await risposta.json(), errore: null };
    return { dati: null, errore: 'codice ' + risposta.status + ': ' + riassunto(await risposta.text()) };
  }

  let datiStanza = await cercaStanza();

  if (!datiStanza) {
    let tentativo = await creaStanza(true);
    const motivi = [];
    if (!tentativo.dati) {
      motivi.push('con impostazioni -> ' + tentativo.errore);
      // Due persone che aprono il video nello stesso istante: la stanza l'ha creata l'altra.
      datiStanza = await cercaStanza();
      if (!datiStanza) {
        tentativo = await creaStanza(false);
        if (!tentativo.dati) motivi.push('essenziale -> ' + tentativo.errore);
      }
    }
    if (!datiStanza && tentativo.dati) datiStanza = tentativo.dati;
    if (!datiStanza) {
      return { errore: 'Daily ha rifiutato la creazione della stanza "' + nomeStanza + '". ' + motivi.join(' | '), codice: 502 };
    }
  }

  // Biglietto d'ingresso: porta con sé il nome della persona e, per l'amministratore, i poteri
  // da moderatore. Vale 6 ore e SOLO per questa stanza.
  const rispostaToken = await fetch('https://api.daily.co/v1/meeting-tokens', {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: {
        room_name: nomeStanza,
        user_name: nome,
        is_owner: ruolo === 'moderatore',
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 6
      }
    })
  });
  if (!rispostaToken.ok) {
    return { errore: 'Stanza "' + nomeStanza + '" pronta, ma Daily ha rifiutato il biglietto d\'ingresso (codice ' + rispostaToken.status + '): ' + riassunto(await rispostaToken.text()), codice: 502 };
  }
  const datiToken = await rispostaToken.json();

  const urlStanza = datiStanza.url || `https://${DOMINIO}.daily.co/${nomeStanza}`;
  return {
    url: `${urlStanza}?t=${encodeURIComponent(datiToken.token)}`,
    urlStanza,
    stanza: nomeStanza
  };
}

// ============================================================================
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

  const nomePersona = (nome && String(nome).trim()) || (ruolo === 'moderatore' ? 'Amministratore' : 'Condòmino');
  const fornitore = (process.env.VIDEO_FORNITORE || 'digitalsamba').trim().toLowerCase();

  try {
    let esito;
    if (fornitore === 'daily') {
      esito = await ingressoDaily({ ruolo, nome: nomePersona, stanzaRichiesta: stanza });
    } else if (fornitore === 'digitalsamba') {
      esito = await ingressoDigitalSamba({ ruolo, nome: nomePersona, stanzaRichiesta: stanza });
    } else {
      res.status(500).json({ error: 'La variabile VIDEO_FORNITORE contiene "' + fornitore + '", che non è un fornitore conosciuto. I valori ammessi sono "digitalsamba" e "daily".' });
      return;
    }

    if (esito.errore) {
      res.status(esito.codice || 502).json({ error: '[' + fornitore + '] ' + esito.errore, fornitore });
      return;
    }
    res.status(200).json({ url: esito.url, urlStanza: esito.urlStanza, stanza: esito.stanza, fornitore });
  } catch (e) {
    res.status(500).json({ error: '[' + fornitore + '] Errore nel preparare l\'ingresso: ' + riassunto(e && e.message ? e.message : e), fornitore });
  }
}
