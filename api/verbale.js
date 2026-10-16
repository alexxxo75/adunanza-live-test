// /api/verbale.js — funzione serverless Vercel (Node.js, nessun framework richiesto)
//
// Fa scrivere a un'intelligenza artificiale la parte discorsiva del verbale d'assemblea.
// La chiave resta SEMPRE qui sul server, non compare mai nel file HTML che gira nel browser:
// stessa regola della funzione del video.
//
// ===================== DUE FORNITORI, UN INTERRUTTORE =====================
// Come per il video, la funzione sa parlare con due fornitori e sceglie in base a una
// variabile d'ambiente su Vercel:
//
//   VERBALE_FORNITORE = anthropic   -> usa Claude (valore predefinito)
//   VERBALE_FORNITORE = openai      -> usa ChatGPT
//
// Nella prova del 14-16 ottobre 2026 i due si sono equivalsi: ChatGPT leggermente più prudente,
// Claude più completo sugli importi. Si è partiti da Anthropic solo perché il pagamento su
// OpenAI non è andato a buon fine. Il giorno in cui si sbloccasse, si passa all'altro cambiando
// questa parola su Vercel e ripubblicando: nessun file da modificare, nessun caricamento su
// GitHub.
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
// Restituisce { ok, verbale, fornitore, modello, uso } — oppure { ok:false, errore } con un
// messaggio scritto per essere letto da una persona, non da un programmatore.
//
// ===================== PERCHÉ SERVE IL BIGLIETTO (token) =====================
// Ogni chiamata a questa funzione costa soldi veri. Un indirizzo lasciato aperto a chiunque è
// un rubinetto aperto: basta che qualcuno lo trovi e lo chiami in un ciclo per svuotare il
// credito. Qui dentro, prima di spendere un centesimo, si verifica presso Supabase che il
// biglietto appartenga davvero a un utente collegato.
//
// ===================== VARIABILI D'AMBIENTE USATE =====================
//   VERBALE_FORNITORE         -> "anthropic" (predefinito) oppure "openai"
//   ANTHROPIC_API_KEY         -> la chiave del conto Anthropic (segreta)
//   OPENAI_API_KEY            -> la chiave del conto OpenAI (segreta)
//   VERBALE_MODELLO           -> il nome del modello da usare. Se manca, la funzione chiede al
//                                fornitore l'elenco dei modelli disponibili su QUEL conto e lo
//                                riporta nel messaggio di errore: così il nome giusto si legge
//                                invece di indovinarlo.
//   SUPABASE_URL              -> già presente, usata anche da /api/config
//   SUPABASE_PUBLISHABLE_KEY  -> già presente, usata anche da /api/config

// Limiti di buon senso sul materiale in ingresso: tre ore di assemblea trascritte stanno
// ampiamente dentro, ma un invio malformato o enorme viene fermato prima di diventare una
// bolletta.
const MAX_BLOCCO_A = 60000;
const MAX_BLOCCO_B = 400000;
const MAX_RISPOSTA = 12000;

// Riassume un testo di errore per mostrarlo a schermo: niente a capo, lunghezza limitata.
function riassunto(testo) {
  if (!testo) return 'nessun dettaglio';
  return String(testo).replace(/\s+/g, ' ').trim().slice(0, 400);
}

// ===================== LE ISTRUZIONI PER L'AI =====================
// Questo testo è il cuore del lavoro, più del modello scelto. Ogni regola nasce da un errore
// visto davvero in una prova, non da un timore teorico:
//  - la regola 2 (nomi) perché due modelli su tre avevano trasformato una "signora Ferrari"
//    mai identificata in un condòmino omonimo presente nell'elenco;
//  - la regola 3 (attribuzione) perché una cifra detta dall'amministratore era stata messa in
//    bocca a chi aveva fatto la domanda;
//  - la regola 7 (importi) perché su una trascrizione vera un modello aveva omesso tutti gli
//    importi pronunciati, facendo perdere al verbale informazioni che in assemblea erano state
//    dette ad alta voce;
//  - la regola 8 (esiti) perché su quella stessa prova un modello aveva scritto "approvato" per
//    una votazione che nella registrazione nessuno aveva mai proclamato conclusa.
const ISTRUZIONI = `Sei il segretario verbalizzante di un'assemblea condominiale italiana. Devi redigere il verbale.

Ricevi due blocchi di materiale, e vanno trattati in modo diverso.

Il BLOCCO A contiene i dati certificati dalla piattaforma che ha gestito l'assemblea: presenze, millesimi, deleghe, esiti delle votazioni, orari. Questi dati sono l'unica fonte valida per qualsiasi numero, nome o esito che vi compaia. Vanno riportati esattamente come sono. Non ricalcolarli, non arrotondarli, non sommarli diversamente, non correggerli nemmeno se nel blocco B qualcuno dice una cifra diversa.

Il BLOCCO B è quanto è stato detto durante la seduta, negli appunti del verbalizzante o nella trascrizione della registrazione. È l'unica fonte per la parte discorsiva: cosa è stato esposto, chi è intervenuto, quali obiezioni sono state sollevate, come si è arrivati alla decisione.

REGOLE DI REDAZIONE

1. Non inventare nulla. Se un'informazione non è né nel blocco A né nel blocco B, non deve comparire nel verbale.
2. Ogni nome di persona citato nel blocco B va confrontato con l'elenco dei presenti e degli assenti del blocco A. Se il nome non compare in quell'elenco, riportalo esattamente come è stato pronunciato, senza attribuirlo a nessuno dei nominativi noti e senza completarlo, e aggiungi subito dopo [da verificare: nominativo non riscontrabile fra i convocati]. Due persone con lo stesso cognome non sono la stessa persona.
3. Ogni dichiarazione va attribuita a chi l'ha pronunciata. Se una cifra è stata detta dall'amministratore in risposta a una domanda, è una dichiarazione dell'amministratore, non di chi ha fatto la domanda.
4. Se qualcuno nel blocco B afferma un dato che contrasta con il blocco A, riporta l'affermazione come dichiarazione di quella persona, mantieni il dato del blocco A come dato dell'assemblea e segnala la divergenza nelle osservazioni finali. Non scegliere tu chi ha ragione e non ricalcolare nulla sulla base del dato corretto.
5. Se qualcosa nel blocco B è incomprensibile, troncato o ambiguo, scrivi [da verificare] al posto di indovinare. Una trascrizione automatica sbaglia spesso proprio sui numeri e sui nomi propri: trattali con più prudenza del resto.
6. Non citare articoli di legge, commi, maggioranze di legge o riferimenti normativi che non siano scritti nel materiale ricevuto. Un riferimento giuridico aggiunto di tua iniziativa è un errore anche quando è quello giusto.
7. Gli importi, i preventivi, le penali, i prezzi e le quantità pronunciati in seduta vanno riportati nel verbale, attribuiti a chi li ha detti. Non ometterli per prudenza: sono stati pronunciati davanti all'assemblea e fanno parte di quello che l'assemblea ha sentito. Prudenza vuol dire attribuirli e non ricalcolarli, non farli sparire.
8. Non dichiarare mai l'esito di una votazione che non risulti dal blocco A o che nessuno abbia proclamato nel blocco B. Se un punto è stato discusso e votato ma l'esito non è stato annunciato, scrivi che la votazione si è svolta e che dalla registrazione non risulta la proclamazione del risultato. Scrivere "approvato" dove nessuno lo ha detto è l'errore più grave che tu possa commettere in un verbale.
9. Riporta i fatti procedurali come sono accaduti, senza correggerli e senza nasconderli: una votazione chiusa mentre qualcuno era disconnesso, una richiesta di deliberare su un argomento non all'ordine del giorno, una votazione per alzata di mano senza conteggio. Quando un fatto del genere è rilevante, richiamalo in una sezione finale intitolata OSSERVAZIONI DEL VERBALIZZANTE.
10. Non attribuire intenzioni, valutazioni o omissioni a nessuno. Scrivi cosa è stato fatto e a che ora, non se è stato fatto bene.
11. Usa il linguaggio di un verbale assembleare italiano: terza persona, tempo passato, tono asciutto. Niente commenti personali, niente giudizi, niente abbellimenti, nessuna parola ricercata al posto di quella comune.
12. Non riportare le chiacchiere e le battute fuori tema: il verbale dice cosa è stato deciso e perché, non trascrive la seduta.

STRUTTURA RICHIESTA

VERBALE DI ASSEMBLEA CONDOMINIALE
(intestazione con condominio, tipo di assemblea, data, ora di apertura e chiusura, luogo)
COSTITUZIONE DELL'ASSEMBLEA (presidente, segretario, verifica del quorum con i dati del blocco A)
PRESENTI (dal blocco A)
ORDINE DEL GIORNO
SVOLGIMENTO (un paragrafo per ciascun punto: discussione, poi deliberazione con l'esito dal blocco A)
INGRESSI E USCITE DURANTE LA SEDUTA (dal blocco A, se presenti)
OSSERVAZIONI DEL VERBALIZZANTE (solo se ce ne sono)
DATI DA COMPLETARE (elenco breve e puntato di ciò che un verbale dovrebbe contenere e che dal materiale ricevuto non risulta, comprese tutte le voci che hai segnato [da verificare]; ometti la sezione solo se non manca davvero nulla)
CHIUSURA E FIRME

Rispondi con il solo testo del verbale, senza premesse e senza commenti finali.`;

// Verifica presso Supabase che il biglietto appartenga a un utente davvero collegato.
// In caso di dubbio si rifiuta: il danno di un rifiuto è un messaggio, quello di un via libera
// sbagliato è il credito di qualcun altro.
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
// I due fornitori. Ognuno espone le stesse tre cose: come si chiama la sua chiave, come si
// chiede l'elenco dei modelli, come si chiede il verbale. Tutto il resto della funzione non sa
// e non deve sapere con chi sta parlando.
// ---------------------------------------------------------------------------

const FORNITORI = {
  anthropic: {
    nome: 'Anthropic',
    variabileChiave: 'ANTHROPIC_API_KEY',
    intestazioni: (chiave) => ({
      'x-api-key': chiave,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }),
    urlModelli: 'https://api.anthropic.com/v1/models',
    leggiModelli: (dati) => (dati.data || []).map(m => m.id),
    urlVerbale: 'https://api.anthropic.com/v1/messages',
    // Anthropic tiene le istruzioni in un campo a parte ("system"), separato dal messaggio.
    corpi: (modello, materiale) => ([
      { model: modello, max_tokens: MAX_RISPOSTA, temperature: 0.2, system: ISTRUZIONI, messages: [{ role: 'user', content: materiale }] },
      { model: modello, max_tokens: MAX_RISPOSTA, system: ISTRUZIONI, messages: [{ role: 'user', content: materiale }] }
    ]),
    leggiVerbale: (dati) => (dati && Array.isArray(dati.content))
      ? dati.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n').trim()
      : '',
    leggiUso: (dati) => (dati && dati.uso) || (dati && dati.usage) || null
  },
  openai: {
    nome: 'OpenAI',
    variabileChiave: 'OPENAI_API_KEY',
    intestazioni: (chiave) => ({
      Authorization: 'Bearer ' + chiave,
      'Content-Type': 'application/json'
    }),
    urlModelli: 'https://api.openai.com/v1/models',
    leggiModelli: (dati) => (dati.data || []).map(m => m.id).filter(id => /gpt|o\d/i.test(id)),
    urlVerbale: 'https://api.openai.com/v1/chat/completions',
    // OpenAI mette le istruzioni come primo messaggio, e il nome del limite di lunghezza è
    // cambiato fra una generazione di modelli e l'altra: si provano le forme in ordine.
    corpi: (modello, materiale) => {
      const base = { model: modello, messages: [{ role: 'system', content: ISTRUZIONI }, { role: 'user', content: materiale }] };
      return [
        Object.assign({}, base, { temperature: 0.2, max_completion_tokens: MAX_RISPOSTA }),
        Object.assign({}, base, { max_completion_tokens: MAX_RISPOSTA }),
        Object.assign({}, base, { temperature: 0.2, max_tokens: MAX_RISPOSTA }),
        base
      ];
    },
    leggiVerbale: (dati) => (dati && dati.choices && dati.choices[0] && dati.choices[0].message)
      ? String(dati.choices[0].message.content || '').trim()
      : '',
    leggiUso: (dati) => (dati && dati.usage) || null
  }
};

// Chiede al fornitore l'elenco dei modelli disponibili su questo conto. Serve solo a scrivere
// un messaggio di errore utile quando VERBALE_MODELLO non è stata impostata.
async function elencoModelli(f, chiave) {
  try {
    const r = await fetch(f.urlModelli, { headers: f.intestazioni(chiave) });
    if (!r.ok) return [];
    const dati = await r.json();
    return (f.leggiModelli(dati) || []).sort().slice(0, 40);
  } catch (e) {
    return [];
  }
}

// Manda la richiesta e riporta indietro il verbale. Se il fornitore rifiuta un parametro
// (succede quando si cambia modello), si riprova con una forma più semplice invece di
// arrendersi: così il giorno in cui si cambia modello non si rompe nulla.
async function chiediIlVerbale(f, chiave, modello, materiale) {
  let ultimoErrore = 'nessun dettaglio';
  for (const corpo of f.corpi(modello, materiale)) {
    let r;
    try {
      r = await fetch(f.urlVerbale, { method: 'POST', headers: f.intestazioni(chiave), body: JSON.stringify(corpo) });
    } catch (e) {
      return { errore: 'Non è stato possibile raggiungere ' + f.nome + ': ' + riassunto(e && e.message), codice: 502 };
    }

    const testo = await r.text();
    let dati = null;
    try { dati = JSON.parse(testo); } catch (e) { /* risposta non in JSON: resta nel messaggio */ }

    if (r.ok) {
      const verbale = f.leggiVerbale(dati);
      if (!verbale) return { errore: f.nome + ' ha risposto senza testo. Riprova fra qualche istante.', codice: 502 };
      return { verbale, uso: f.leggiUso(dati) };
    }

    const messaggio = (dati && dati.error && (dati.error.message || dati.error.type)) || riassunto(testo);
    ultimoErrore = messaggio;
    if (r.status === 400 && /unsupported|unrecognized|not supported|unknown parameter|max_tokens|temperature/i.test(messaggio)) continue;

    if (r.status === 401 || r.status === 403) return { errore: f.nome + ' non riconosce la chiave. Controlla la variabile ' + f.variabileChiave + ' su Vercel.', codice: 401 };
    if (r.status === 404) return { errore: 'Il modello "' + modello + '" non esiste su questo conto ' + f.nome + '. Correggi la variabile VERBALE_MODELLO su Vercel.', codice: 400 };
    if (r.status === 429) return { errore: f.nome + ' ha rifiutato la richiesta: credito esaurito oppure troppe richieste ravvicinate. Dettaglio: ' + riassunto(messaggio), codice: 429 };
    return { errore: f.nome + ' ha risposto con un errore (' + r.status + '): ' + riassunto(messaggio), codice: 502 };
  }
  return { errore: f.nome + ' ha rifiutato la richiesta in tutte le forme provate. Ultimo dettaglio: ' + riassunto(ultimoErrore), codice: 502 };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, errore: 'Metodo non consentito, usa POST.' });
    return;
  }

  const { token, bloccoA, bloccoB } = req.body || {};

  const nomeFornitore = (process.env.VERBALE_FORNITORE || 'anthropic').trim().toLowerCase();
  const f = FORNITORI[nomeFornitore];
  if (!f) {
    res.status(500).json({ ok: false, errore: 'La variabile VERBALE_FORNITORE contiene "' + nomeFornitore + '", che non è un fornitore conosciuto. I valori ammessi sono "anthropic" e "openai".' });
    return;
  }

  const chiave = process.env[f.variabileChiave];
  if (!chiave) {
    res.status(500).json({ ok: false, errore: 'Manca la chiave di ' + f.nome + ' sul server: va creata la variabile ' + f.variabileChiave + ' nelle impostazioni del progetto su Vercel.' });
    return;
  }

  if (!(await bigliettoValido(token))) {
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
    const disponibili = await elencoModelli(f, chiave);
    res.status(500).json({
      ok: false,
      errore: 'Manca la variabile VERBALE_MODELLO su Vercel: va scritto lì il nome del modello da usare.'
        + (disponibili.length ? ' Su questo conto ' + f.nome + ' risultano disponibili, fra gli altri: ' + disponibili.join(', ') + '.' : ''),
      fornitore: nomeFornitore,
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

  const esito = await chiediIlVerbale(f, chiave, modello, materiale);
  if (esito.errore) {
    res.status(esito.codice || 502).json({ ok: false, errore: esito.errore, fornitore: nomeFornitore });
    return;
  }

  res.status(200).json({ ok: true, verbale: esito.verbale, fornitore: nomeFornitore, modello, uso: esito.uso });
}
