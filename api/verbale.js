// /api/verbale.js — funzione serverless Vercel (Node.js, nessun framework richiesto)
//
// Fa scrivere a un'intelligenza artificiale la parte discorsiva del verbale d'assemblea.
// La chiave di OpenAI resta SEMPRE qui sul server, non compare mai nel file HTML che gira
// nel browser: stessa regola della funzione del video.
//
// ===================== COSA RICEVE E COSA RESTITUISCE =====================
// Riceve dal browser:
//   { token, bloccoA, bloccoB }
//   token   -> il biglietto della sessione dell'amministratore già collegato (vedi sotto)
//   bloccoA -> i DATI CERTIFICATI dell'assemblea, già formattati dall'applicazione:
//              presenti, millesimi, deleghe, esiti delle votazioni, ingressi e uscite.
//              Li costruisce l'applicazione, che è l'unica a conoscerli davvero; qui non si
//              ricalcola nulla.
//   bloccoB -> quello che è stato detto in assemblea: gli appunti dell'amministratore oggi,
//              la trascrizione della registrazione quando ci sarà. Per questa funzione sono
//              la stessa cosa, quindi quando arriverà la trascrizione non andrà cambiata.
// Restituisce { ok, verbale, modello, uso } — oppure { ok:false, errore } con un messaggio
// scritto per essere letto da una persona, non da un programmatore.
//
// ===================== PERCHÉ SERVE IL BIGLIETTO (token) =====================
// Ogni chiamata a questa funzione costa soldi veri sul conto OpenAI. Un indirizzo lasciato
// aperto a chiunque è un rubinetto aperto: basta che qualcuno lo trovi e lo chiami in un
// ciclo per svuotare il credito. Qui dentro, prima di spendere un centesimo, si verifica
// presso Supabase che il biglietto appartenga davvero a un utente collegato. Chi non ha
// fatto l'accesso a Riunion riceve un rifiuto e non consuma nulla.
//
// ===================== VARIABILI D'AMBIENTE USATE =====================
//   OPENAI_API_KEY            -> la chiave del conto OpenAI (segreta)
//   VERBALE_MODELLO           -> il nome del modello da usare, es. "gpt-5.6-terra".
//                                Se manca, la funzione chiede a OpenAI l'elenco dei modelli
//                                disponibili su QUEL conto e lo riporta nel messaggio di
//                                errore: così il nome giusto si legge invece di indovinarlo.
//   SUPABASE_URL              -> già presente, usata anche da /api/config
//   SUPABASE_PUBLISHABLE_KEY  -> già presente, usata anche da /api/config
//
// Cambiare modello non richiede di toccare questo file né di ricaricare l'applicazione:
// si cambia la parola in VERBALE_MODELLO su Vercel, come si fa con VIDEO_FORNITORE.

// Limiti di buon senso sul materiale in ingresso: tre ore di assemblea trascritte stanno
// ampiamente dentro, ma un invio malformato o enorme viene fermato prima di diventare una
// bolletta.
const MAX_BLOCCO_A = 60000;
const MAX_BLOCCO_B = 400000;

// Riassume un testo di errore per mostrarlo a schermo: niente a capo, lunghezza limitata.
function riassunto(testo) {
  if (!testo) return 'nessun dettaglio';
  return String(testo).replace(/\s+/g, ' ').trim().slice(0, 400);
}

// ===================== LE ISTRUZIONI PER L'AI =====================
// Questo testo è il cuore del lavoro, più del modello scelto: nella prova del 14/10/2026 due
// modelli su tre hanno sbagliato lo stesso punto, segno che la regola era scritta male e non
// che i modelli fossero scadenti. Ogni regola qui sotto nasce da un errore visto davvero.
const ISTRUZIONI = `Sei il segretario verbalizzante di un'assemblea condominiale italiana. Devi redigere il verbale.

Ricevi due blocchi di materiale, e vanno trattati in modo diverso.

Il BLOCCO A contiene i dati certificati dalla piattaforma che ha gestito l'assemblea: presenze, millesimi, deleghe, esiti delle votazioni, orari. Questi dati sono l'unica fonte valida per qualsiasi numero, nome o esito. Vanno riportati esattamente come sono. Non ricalcolarli, non arrotondarli, non sommarli diversamente, non correggerli nemmeno se nel blocco B qualcuno dice una cifra diversa.

Il BLOCCO B è quanto è stato detto durante la seduta, negli appunti del verbalizzante o nella trascrizione della registrazione. È l'unica fonte per la parte discorsiva: cosa è stato esposto, chi è intervenuto, quali obiezioni sono state sollevate, come si è arrivati alla decisione.

REGOLE DI REDAZIONE

1. Non inventare nulla. Se un'informazione non è né nel blocco A né nel blocco B, non deve comparire nel verbale.
2. Ogni nome di persona citato nel blocco B va confrontato con l'elenco dei presenti e degli assenti del blocco A. Se il nome non compare in quell'elenco, riportalo esattamente come è stato pronunciato, senza attribuirlo a nessuno dei nominativi noti e senza completarlo, e aggiungi subito dopo [da verificare: nominativo non riscontrabile fra i convocati]. Due persone con lo stesso cognome non sono la stessa persona.
3. Ogni dichiarazione va attribuita a chi l'ha pronunciata. Se una cifra è stata detta dall'amministratore in risposta a una domanda, è una dichiarazione dell'amministratore, non di chi ha fatto la domanda.
4. Se qualcuno nel blocco B afferma un dato che contrasta con il blocco A, riporta l'affermazione come dichiarazione di quella persona, mantieni il dato del blocco A come dato dell'assemblea e segnala la divergenza nelle osservazioni finali. Non scegliere tu chi ha ragione e non ricalcolare nulla sulla base del dato corretto.
5. Se qualcosa nel blocco B è incomprensibile, troncato o ambiguo, scrivi [da verificare] al posto di indovinare.
6. Non citare articoli di legge, commi, maggioranze di legge o riferimenti normativi che non siano scritti nel materiale ricevuto. Un riferimento giuridico aggiunto di tua iniziativa è un errore anche quando è quello giusto.
7. Riporta i fatti procedurali come sono accaduti, senza correggerli e senza nasconderli: una votazione chiusa mentre qualcuno era disconnesso, una richiesta di deliberare su un argomento non all'ordine del giorno, un intervento fuori tema. Quando un fatto del genere è rilevante, richiamalo in una sezione finale intitolata OSSERVAZIONI DEL VERBALIZZANTE.
8. Non attribuire intenzioni, valutazioni o omissioni a nessuno. Scrivi cosa è stato fatto e a che ora, non se è stato fatto bene.
9. Usa il linguaggio di un verbale assembleare italiano: terza persona, tempo passato, tono asciutto. Niente commenti personali, niente giudizi, niente abbellimenti, nessuna parola ricercata al posto di quella comune.
10. Non riportare le chiacchiere e le battute fuori tema: il verbale dice cosa è stato deciso e perché, non trascrive la seduta.

STRUTTURA RICHIESTA

VERBALE DI ASSEMBLEA CONDOMINIALE
(intestazione con condominio, tipo di assemblea, data, ora di apertura e chiusura, luogo)
COSTITUZIONE DELL'ASSEMBLEA (presidente, segretario, verifica del quorum con i dati del blocco A)
PRESENTI (dal blocco A)
ORDINE DEL GIORNO
SVOLGIMENTO (un paragrafo per ciascun punto: discussione, poi deliberazione con l'esito dal blocco A)
INGRESSI E USCITE DURANTE LA SEDUTA (dal blocco A, se presenti)
OSSERVAZIONI DEL VERBALIZZANTE (solo se ce ne sono)
CHIUSURA E FIRME

Rispondi con il solo testo del verbale, senza premesse e senza commenti finali.`;

// Verifica presso Supabase che il biglietto appartenga a un utente davvero collegato.
// Restituisce true/false, senza mai far fallire la funzione per un problema di rete: in caso
// di dubbio si rifiuta, perché il danno di un rifiuto è un messaggio, quello di un via libera
// sbagliato è il credito di qualcun altro.
async function biglietoValido(token) {
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

// Chiede a OpenAI l'elenco dei modelli disponibili su questo conto. Serve solo a scrivere un
// messaggio di errore utile quando VERBALE_MODELLO non è stata impostata.
async function elencoModelli(chiave) {
  try {
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: 'Bearer ' + chiave }
    });
    if (!r.ok) return [];
    const dati = await r.json();
    return (dati.data || [])
      .map(m => m.id)
      .filter(id => /gpt|o\d/i.test(id))
      .sort()
      .slice(0, 40);
  } catch (e) {
    return [];
  }
}

// Manda la richiesta a OpenAI. I nomi di alcuni parametri cambiano da una generazione di
// modelli all'altra (temperature non sempre ammessa, max_tokens diventato
// max_completion_tokens): invece di scommettere su una forma sola, si prova la più completa e
// si scende di un gradino ogni volta che la risposta dice che un parametro non è ammesso.
// Così il giorno in cui si cambia modello non si rompe nulla.
async function chiediIlVerbale(chiave, modello, materiale) {
  const base = {
    model: modello,
    messages: [
      { role: 'system', content: ISTRUZIONI },
      { role: 'user', content: materiale }
    ]
  };
  const tentativi = [
    Object.assign({}, base, { temperature: 0.2, max_completion_tokens: 12000 }),
    Object.assign({}, base, { max_completion_tokens: 12000 }),
    Object.assign({}, base, { temperature: 0.2, max_tokens: 12000 }),
    base
  ];

  let ultimoErrore = 'nessun dettaglio';
  for (const corpo of tentativi) {
    let r;
    try {
      r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + chiave, 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo)
      });
    } catch (e) {
      return { errore: 'Non è stato possibile raggiungere OpenAI: ' + riassunto(e && e.message), codice: 502 };
    }

    const testo = await r.text();
    let dati = null;
    try { dati = JSON.parse(testo); } catch (e) { /* risposta non in JSON: resta nel messaggio */ }

    if (r.ok) {
      const verbale = dati && dati.choices && dati.choices[0] && dati.choices[0].message
        ? String(dati.choices[0].message.content || '').trim()
        : '';
      if (!verbale) return { errore: 'OpenAI ha risposto senza testo. Riprova fra qualche istante.', codice: 502 };
      return { verbale, uso: (dati && dati.usage) || null };
    }

    const messaggio = (dati && dati.error && dati.error.message) || riassunto(testo);
    ultimoErrore = messaggio;
    // Parametro non ammesso da questo modello: si riprova con la forma più semplice.
    if (r.status === 400 && /unsupported|unrecognized|not supported|unknown parameter|max_tokens/i.test(messaggio)) continue;

    if (r.status === 401) return { errore: 'OpenAI non riconosce la chiave. Controlla la variabile OPENAI_API_KEY su Vercel.', codice: 401 };
    if (r.status === 404) return { errore: 'Il modello "' + modello + '" non esiste su questo conto OpenAI. Correggi la variabile VERBALE_MODELLO su Vercel.', codice: 400 };
    if (r.status === 429) return { errore: 'OpenAI ha rifiutato la richiesta: credito esaurito oppure troppe richieste ravvicinate. Dettaglio: ' + riassunto(messaggio), codice: 429 };
    return { errore: 'OpenAI ha risposto con un errore (' + r.status + '): ' + riassunto(messaggio), codice: 502 };
  }
  return { errore: 'OpenAI ha rifiutato la richiesta in tutte le forme provate. Ultimo dettaglio: ' + riassunto(ultimoErrore), codice: 502 };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, errore: 'Metodo non consentito, usa POST.' });
    return;
  }

  const { token, bloccoA, bloccoB } = req.body || {};

  const chiave = process.env.OPENAI_API_KEY;
  if (!chiave) {
    res.status(500).json({ ok: false, errore: 'Manca la chiave di OpenAI sul server: va creata la variabile OPENAI_API_KEY nelle impostazioni del progetto su Vercel.' });
    return;
  }

  if (!(await biglietoValido(token))) {
    res.status(401).json({ ok: false, errore: 'Sessione non riconosciuta. Esci e rientra in Riunion, poi riprova.' });
    return;
  }

  const datiCertificati = String(bloccoA || '').trim();
  const dettoInSeduta = String(bloccoB || '').trim();
  if (!datiCertificati) {
    res.status(400).json({ ok: false, errore: 'Mancano i dati certificati dell\'assemblea.' });
    return;
  }
  if (!dettoInSeduta) {
    res.status(400).json({ ok: false, errore: 'Non c\'è nulla da verbalizzare: servono gli appunti della seduta o la trascrizione.' });
    return;
  }
  if (datiCertificati.length > MAX_BLOCCO_A || dettoInSeduta.length > MAX_BLOCCO_B) {
    res.status(413).json({ ok: false, errore: 'Il materiale da verbalizzare è troppo lungo per una sola richiesta.' });
    return;
  }

  const modello = (process.env.VERBALE_MODELLO || '').trim();
  if (!modello) {
    const disponibili = await elencoModelli(chiave);
    res.status(500).json({
      ok: false,
      errore: 'Manca la variabile VERBALE_MODELLO su Vercel: va scritto lì il nome del modello da usare.'
        + (disponibili.length ? ' Su questo conto OpenAI risultano disponibili, fra gli altri: ' + disponibili.join(', ') + '.' : ''),
      modelliDisponibili: disponibili
    });
    return;
  }

  const materiale =
    '=====================================================================\n' +
    'BLOCCO A — DATI CERTIFICATI DALLA PIATTAFORMA\n' +
    '=====================================================================\n\n' +
    datiCertificati +
    '\n\n=====================================================================\n' +
    'BLOCCO B — QUANTO È STATO DETTO IN SEDUTA\n' +
    '=====================================================================\n\n' +
    dettoInSeduta;

  const esito = await chiediIlVerbale(chiave, modello, materiale);
  if (esito.errore) {
    res.status(esito.codice || 502).json({ ok: false, errore: esito.errore });
    return;
  }

  res.status(200).json({ ok: true, verbale: esito.verbale, modello, uso: esito.uso });
}
