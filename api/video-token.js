// /api/video-token.js — funzione serverless Vercel (Node.js, nessun framework richiesto)
//
// Genera un link di ingresso alla videochiamata Digital Samba con il ruolo giusto
// (moderatore per l'amministratore, partecipante per i condòmini). Le credenziali
// (Team ID e Developer Key) restano SEMPRE qui sul server, mai nel file HTML/JS che
// gira nel browser — impostale come variabili d'ambiente su Vercel:
//   DIGITALSAMBA_TEAM_ID          -> il tuo Team ID
//   DIGITALSAMBA_DEVELOPER_KEY    -> la tua Developer Key
//   DIGITALSAMBA_ROOM_URL         -> (opzionale) il friendly_url della stanza, default "demo-room"
//
// Il chiamante (il file HTML) manda una richiesta POST con { ruolo, nome } e riceve
// indietro { url } pronto da usare come src dell'iframe.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metodo non consentito, usa POST.' });
    return;
  }

  const { ruolo, nome } = req.body || {};
  if (ruolo !== 'moderatore' && ruolo !== 'partecipante') {
    res.status(400).json({ error: 'Il campo "ruolo" deve essere "moderatore" o "partecipante".' });
    return;
  }

  const TEAM_ID = process.env.DIGITALSAMBA_TEAM_ID;
  const DEV_KEY = process.env.DIGITALSAMBA_DEVELOPER_KEY;
  const ROOM_FRIENDLY_URL = process.env.DIGITALSAMBA_ROOM_URL || 'demo-room';

  if (!TEAM_ID || !DEV_KEY) {
    res.status(500).json({ error: 'Credenziali Digital Samba non configurate: manca DIGITALSAMBA_TEAM_ID o DIGITALSAMBA_DEVELOPER_KEY tra le variabili d\'ambiente su Vercel.' });
    return;
  }

  const authHeader = 'Basic ' + Buffer.from(`${TEAM_ID}:${DEV_KEY}`).toString('base64');
  const ruoloDigitalSamba = ruolo === 'moderatore' ? 'moderator' : 'attendee';

  try {
    // 1) Recupero i dati della stanza esistente (serve l'id reale della stanza, non
    //    basta il friendly_url, per generare il token al passo successivo).
    const rispostaStanza = await fetch(`https://api.digitalsamba.com/api/v1/rooms/${ROOM_FRIENDLY_URL}`, {
      headers: { Authorization: authHeader }
    });
    if (!rispostaStanza.ok) {
      const dettaglio = await rispostaStanza.text();
      res.status(502).json({ error: 'Non sono riuscito a trovare la stanza "' + ROOM_FRIENDLY_URL + '" su Digital Samba.', dettaglio });
      return;
    }
    const stanza = await rispostaStanza.json();

    // 2) Genero il token di ingresso per questa persona, con il ruolo richiesto.
    //    Validità: 6 ore, più che sufficiente per un'assemblea condominiale.
    const rispostaToken = await fetch(`https://api.digitalsamba.com/api/v1/rooms/${stanza.id}/token`, {
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

    const urlStanza = stanza.room_url || `https://${TEAM_ID}.digitalsamba.com/${ROOM_FRIENDLY_URL}`;
    const urlConToken = `${urlStanza}?token=${encodeURIComponent(datiToken.token)}`;

    res.status(200).json({ url: urlConToken });
  } catch (e) {
    res.status(500).json({ error: 'Errore imprevisto nel generare il link di ingresso.', dettaglio: String(e) });
  }
}
