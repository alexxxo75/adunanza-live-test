// /api/email-delega.js — LT-320
//
// Manda l'email di conferma quando un CONDÒMINO concede una delega dalla sua pagina.
//
// PERCHÉ ESISTE: fino alla LT-319 l'email della delega non partiva mai. La pagina del condòmino
// non conosce l'indirizzo dell'amministratore né quello del vicino delegato (giustamente: il
// database non gli manda le email dei vicini), e /api/invia-email accetta solo chi ha fatto
// l'accesso come amministratore. Il risultato era una delega registrata senza nessuna email, e
// una pagina che diceva il contrario.
//
// COME FUNZIONA: la pagina manda soltanto il codice del suo link e i numeri delle assemblee.
// Tutto il resto lo ricava il server dal database, e non si fida di niente di quello che arriva
// dal browser:
//   1. dal codice ricava chi è il condòmino (e il suo amministratore, che deve essere attivo);
//   2. per ogni assemblea controlla che la delega esista DAVVERO nei dati dell'assemblea;
//   3. compone da solo il testo, con nomi, date e luoghi presi dal database;
//   4. manda un'email separata a ciascuno: amministratore, condòmino che delega (copia per sé)
//      e, se la delega va a un altro condòmino, al delegato. Email separate perché nessuno veda
//      l'indirizzo degli altri.
// Mittente visibile: "Nome Cognome (tramite Riunion)". L'indirizzo vero resta quello di Riunion
// (EMAIL_MITTENTE): un'email "dalla casella del condòmino" verrebbe respinta come falsa.
//
// LIMITE ANTI-ABUSO: al massimo 10 invii al giorno per condòmino e uno ogni 30 secondi, registrati
// nella tabella "email_delega_inviate" (va creata una volta sola su Supabase, vedi istruzioni).
// Serve a non far consumare a un singolo link le 300 email giornaliere di Brevo, che servono alle
// convocazioni.
//
// Variabili d'ambiente: SUPABASE_URL, SUPABASE_SECRET_KEY (già usate da /api/amministratori),
// BREVO_API_KEY, EMAIL_MITTENTE (già usate da /api/invia-email).
//
// LT-322 — DELEGATO ESTERNO: se la delega va a una persona esterna, la sua email e il suo link
// personale sono nella tabella "delegati_esterni" (li crea il database quando il condòmino
// concede la delega). Gli arrivano la delega, il link per partecipare, il link "solo voto",
// data, ora e luogo. Se il condòmino cambia delegato o annulla la delega per entrare lui, la
// pagina indica in "precedenti" chi era il delegato esterno di prima: se davvero non è più
// delegato, a lui e all'amministratore arriva un avviso che il suo link non vale più.

import { clienteServer } from '../lib/supabase.js';
import { spedisci, indirizzoPlausibile, testoInHtml, escHtml } from '../lib/posta.js';

const MAX_AL_GIORNO = 10;
const PAUSA_MINIMA_SEC = 30;

function rispondi(res, stato, dati) {
  res.status(stato).json(dati);
}

function dataIt(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? m[3] + '/' + m[2] + '/' + m[1] : 'da definire';
}
function oraIt(t) {
  const m = /^(\d{2}):(\d{2})/.exec(String(t || ''));
  return m ? m[1] + ':' + m[2] : 'da definire';
}
function nomeDi(p) {
  return [p && p.nome, p && p.cognome].map(x => String(x || '').trim()).filter(Boolean).join(' ') || 'Condòmino';
}
function adessoIt() {
  const d = new Date();
  return {
    data: d.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' }),
    ora: d.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' })
  };
}

const MODALITA = { 'in-presenza': 'in presenza', 'mista': 'mista (in presenza e online)', 'online': 'online' };

// Stessa dichiarazione che la pagina mostra al condòmino prima di confermare.
function dichiarazione({ nomeDelegante, nomeDelegato, stabile, assemblee, indirizzoStudio }) {
  if (assemblee.length === 1) {
    const a = assemblee[0];
    const tipo = a.tipo === 'straordinaria' ? 'straordinaria' : 'ordinaria';
    const luogo = String(a.luogo || '').trim() || '(luogo da definire)';
    const studio = String(indirizzoStudio || '').trim() || '(indirizzo studio non impostato)';
    const rigaLuoghi = a.modalita === 'online'
      ? `in prima convocazione ed in seconda convocazione il giorno ${dataIt(a.data_seconda)} alle ore ${oraIt(a.ora_seconda)}`
      : `in prima convocazione presso lo Studio dell'Amministratore sito in ${studio} ed in seconda convocazione il giorno ${dataIt(a.data_seconda)} alle ore ${oraIt(a.ora_seconda)} presso ${luogo}`;
    return `Io sottoscritto/a ${nomeDelegante} delego a rappresentarmi all'assemblea condominiale ${tipo} del condominio ${stabile.nome}, ${stabile.comune || ''} che si terrà in modalità ${MODALITA[a.modalita] || MODALITA.mista} il giorno ${dataIt(a.data_prima)} alle ore ${oraIt(a.ora_prima)} ${rigaLuoghi}, il Sig. ${nomeDelegato}`;
  }
  const elenco = assemblee.map(a =>
    `- ${a.oggetto || 'Assemblea'} (${a.tipo === 'straordinaria' ? 'straordinaria' : 'ordinaria'}), modalità ${MODALITA[a.modalita] || 'mista'}, prima convocazione il ${dataIt(a.data_prima)} alle ${oraIt(a.ora_prima)}, seconda convocazione il ${dataIt(a.data_seconda)} alle ${oraIt(a.ora_seconda)}`
  ).join('\n');
  return `Io sottoscritto/a ${nomeDelegante} delego a rappresentarmi il Sig. ${nomeDelegato} per le seguenti assemblee condominiali del condominio ${stabile.nome}, ${stabile.comune || ''}:\n\n${elenco}`;
}

// L'email in HTML con la firma in corsivo grassetto (LT-322); il resto è il testo normale.
function htmlConFirma(testo, nomeFirma) {
  const html = testoInHtml(testo);
  const cerca = 'Firma<br>' + escHtml(nomeFirma);
  return html.replace(cerca, 'Firma<br><b><i>' + escHtml(nomeFirma) + '</i></b>');
}

// Indirizzo del sito da cui è partita la richiesta (riunion.it o l'indirizzo di prova di Vercel).
function indirizzoSito(req) {
  const host = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim();
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return 'https://riunion.it';
  return 'https://' + host;
}

function quandoDove(a, indirizzoStudio) {
  const righe = [];
  righe.push(`Prima convocazione: ${dataIt(a.data_prima)} alle ore ${oraIt(a.ora_prima)}` +
    (a.modalita === 'online' ? ' (online)' : `, presso lo Studio dell'Amministratore${String(indirizzoStudio || '').trim() ? ' in ' + String(indirizzoStudio).trim() : ''}`));
  righe.push(`Seconda convocazione: ${dataIt(a.data_seconda)} alle ore ${oraIt(a.ora_seconda)}` +
    (a.modalita === 'online' ? ' (online)' : `, presso ${String(a.luogo || '').trim() || '(luogo da definire)'}`) +
    (a.modalita === 'mista' ? ', oppure online' : ''));
  return righe.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return rispondi(res, 405, { ok: false, errore: 'Metodo non consentito, usa POST.' });

  const { codice, assemblee, precedenti } = req.body || {};
  const esterniPrecedenti = (Array.isArray(precedenti) ? precedenti : [])
    .map(x => String(x)).filter(x => /^ext-[0-9a-z-]{1,40}$/i.test(x)).slice(0, 5);
  if (typeof codice !== 'string' || codice.length < 6 || codice.length > 200) {
    return rispondi(res, 400, { ok: false, errore: 'Link non valido.' });
  }
  const numeri = (Array.isArray(assemblee) ? assemblee : [])
    .map(x => String(x)).filter(x => /^\d{1,20}$/.test(x));
  if (numeri.length === 0 || numeri.length > 20) {
    return rispondi(res, 400, { ok: false, errore: 'Nessuna assemblea indicata.' });
  }

  let db;
  try { db = clienteServer(); } catch (e) { return rispondi(res, 500, { ok: false, errore: e.message }); }

  try {
    // 1. chi è, e di chi è il condominio
    const { data: c } = await db.from('condomini')
      .select('id, id_app, nome, cognome, email, stabile_id, unificato_con').eq('token', codice).maybeSingle();
    if (!c) return rispondi(res, 403, { ok: false, errore: 'Link non valido o non più attivo.' });

    const { data: stabile } = await db.from('stabili')
      .select('id, nome, comune, amministratore_id').eq('id', c.stabile_id).maybeSingle();
    if (!stabile) return rispondi(res, 403, { ok: false, errore: 'Link non valido o non più attivo.' });

    const { data: adm } = await db.from('amministratori')
      .select('attivo, email, email_contatto, ragione_sociale, nome, cognome, indirizzo_studio')
      .eq('id', stabile.amministratore_id).maybeSingle();
    if (!adm || !adm.attivo) return rispondi(res, 403, { ok: false, errore: 'Link non valido o non più attivo.' });

    // La delega è registrata sul proprietario principale, se le sue unità sono unite.
    let primario = null;
    if (c.unificato_con) {
      const r = await db.from('condomini').select('id_app, nome, cognome, email').eq('id', c.unificato_con).maybeSingle();
      primario = r.data || null;
    }
    const deleganteIdApp = String(primario ? primario.id_app : c.id_app);
    const nomeDelegante = nomeDi(c);
    const emailDelegante = indirizzoPlausibile(c.email) ? c.email : (primario && indirizzoPlausibile(primario.email) ? primario.email : null);

    // 2. limite anti-abuso
    const daIeri = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: recenti, error: errRecenti } = await db.from('email_delega_inviate')
      .select('inviata_il').eq('condomino_id', c.id).gte('inviata_il', daIeri).order('inviata_il', { ascending: false });
    if (errRecenti) {
      console.error('Tabella email_delega_inviate non disponibile:', errRecenti);
      return rispondi(res, 500, { ok: false, errore: 'Configurazione incompleta sul server (manca la tabella email_delega_inviate).' });
    }
    if ((recenti || []).length >= MAX_AL_GIORNO) {
      return rispondi(res, 429, { ok: false, errore: 'Troppe email di delega oggi da questo link. La delega resta comunque registrata.' });
    }
    if (recenti && recenti[0] && (Date.now() - new Date(recenti[0].inviata_il).getTime()) < PAUSA_MINIMA_SEC * 1000) {
      return rispondi(res, 429, { ok: false, errore: 'Email già inviata pochi secondi fa.' });
    }

    // 3. le deleghe che esistono davvero, assemblea per assemblea
    const gruppi = new Map();   // delegato -> { delegato, assemblee: [] }
    const assembleeValide = [];
    for (const n of numeri) {
      const { data: a } = await db.from('assemblee')
        .select('id, id_app, oggetto, tipo, modalita, data_prima, ora_prima, data_seconda, ora_seconda, luogo, stato')
        .eq('id_app', n).eq('stabile_id', stabile.id).maybeSingle();
      if (!a || a.stato === 'conclusa') continue;
      const { data: sv } = await db.from('stato_vivo').select('dati').eq('assemblea_id', a.id).maybeSingle();
      const dati = (sv && sv.dati) || {};
      const deleghe = (dati.appello && dati.appello.deleghe) || {};
      assembleeValide.push(a);
      if (!(deleganteIdApp in deleghe)) continue;
      const delegato = deleghe[deleganteIdApp];
      const chiave = String(delegato);
      if (!gruppi.has(chiave)) gruppi.set(chiave, { delegato, assemblee: [], esterni: dati.deleghiEsterni || [] });
      gruppi.get(chiave).assemblee.push(a);
    }
    // delegati esterni di prima che ora NON sono più delegati da questo condòmino
    const delegatiOra = new Set([...gruppi.keys()]);
    const daAvvisare = esterniPrecedenti.filter(x => !delegatiOra.has(x));
    if (gruppi.size === 0 && (daAvvisare.length === 0 || assembleeValide.length === 0)) {
      return rispondi(res, 404, { ok: false, errore: 'Non risulta nessuna delega registrata da questo link per le assemblee indicate.' });
    }

    // 4. composizione e invio
    const quando = adessoIt();
    const emailAmm = indirizzoPlausibile(adm.email_contatto) ? adm.email_contatto : (indirizzoPlausibile(adm.email) ? adm.email : null);
    const nomeMittente = nomeDelegante + ' (tramite Riunion)';
    const esiti = [];

    for (const g of gruppi.values()) {
      let nomeDelegato = 'persona delegata';
      let emailDelegato = null;
      let esterno = null;          // LT-322: riga di delegati_esterni, se il delegato è esterno
      if (typeof g.delegato === 'number' || /^\d+$/.test(String(g.delegato))) {
        const { data: dc } = await db.from('condomini').select('nome, cognome, email')
          .eq('id_app', String(g.delegato)).eq('stabile_id', stabile.id).maybeSingle();
        if (dc) { nomeDelegato = nomeDi(dc); emailDelegato = indirizzoPlausibile(dc.email) ? dc.email : null; }
      } else {
        const est = (g.esterni || []).find(e => e && e.id === g.delegato);
        if (est && est.nome) nomeDelegato = String(est.nome).trim();
        const { data: de } = await db.from('delegati_esterni').select('nome, email, token')
          .eq('stabile_id', stabile.id).eq('ext_id', String(g.delegato)).maybeSingle();
        if (de) {
          esterno = de;
          if (de.nome) nomeDelegato = String(de.nome).trim();
          emailDelegato = indirizzoPlausibile(de.email) ? de.email : null;
        }
      }

      const testoDelega = dichiarazione({ nomeDelegante, nomeDelegato, stabile, assemblee: g.assemblee, indirizzoStudio: adm.indirizzo_studio });
      const piede = `\n\nFirma\n${nomeDelegante}\n\n---\nDelega concessa tramite il link personale di ${nomeDelegante} sulla piattaforma Riunion il ${quando.data} alle ore ${quando.ora}.`;
      const oggetto = (g.assemblee.length === 1 ? `Delega - ${g.assemblee[0].oggetto || 'Assemblea'} - ` : 'Delega - ') + stabile.nome;

      const invii = [];
      if (emailAmm) invii.push({ ruolo: 'amministratore', a: emailAmm, rispondiA: emailDelegante,
        apertura: `Il condòmino ${nomeDelegante} ha concesso la seguente delega:\n\n` });
      if (emailDelegante) invii.push({ ruolo: 'delegante', a: emailDelegante, rispondiA: emailAmm,
        apertura: `Questa è la copia della delega che hai appena concesso. Se non l'hai concessa tu, avvisa subito l'amministratore rispondendo a questa email.\n\n` });
      if (emailDelegato && !esterno) invii.push({ ruolo: 'delegato', a: emailDelegato, rispondiA: emailDelegante,
        apertura: `Sei stato indicato come delegato da ${nomeDelegante}. Per partecipare all'assemblea usa il tuo link personale, che hai già ricevuto con la convocazione: con quello voterai anche per conto di chi ti ha delegato.\n\n` });
      if (emailDelegato && esterno && esterno.token) {
        // LT-322: la persona esterna riceve il SUO link personale
        const prima = g.assemblee.slice().sort((x, y) => Number(x.id_app) - Number(y.id_app))[0];
        const base = indirizzoSito(req) + '/?token=' + encodeURIComponent(esterno.token) + '&assemblea=' + encodeURIComponent(String(prima.id_app));
        const elencoQuando = g.assemblee.map(a => (g.assemblee.length > 1 ? `${a.oggetto || 'Assemblea'}\n` : '') + quandoDove(a, adm.indirizzo_studio)).join('\n\n');
        const online = g.assemblee.some(a => a.modalita !== 'in-presenza');
        invii.push({ ruolo: 'delegato', a: emailDelegato, rispondiA: emailAmm || emailDelegante,
          apertura: `Gentile ${nomeDelegato},\n${nomeDelegante} ti ha delegato a rappresentarlo/a all'assemblea del condominio ${stabile.nome}${stabile.comune ? ', ' + stabile.comune : ''}.\n\n` +
            `QUANDO E DOVE\n${elencoQuando}\n\n` +
            (online
              ? `PER PARTECIPARE ONLINE (video e voto)\n${base}\n\nSOLO PER VOTARE, senza video\n${base}&modo=voto\n\n` +
                `Questi link sono personali: non inoltrarli. Valgono solo per questa assemblea e smettono di funzionare se la delega viene annullata o quando l'assemblea termina. Se ${nomeDelegante} decide di partecipare di persona, la delega si annulla e riceverai un avviso.\n\n`
              : `L'assemblea si svolge in presenza: porta con te questa email come promemoria della delega.\n\n`) +
            `PRIVACY\nI dati del delegato saranno trattati dal Condominio (Titolare) e dall'Amministratore (Responsabile) esclusivamente per le finalità legate alla verifica della regolare costituzione dell'assemblea e alla redazione del verbale, ai sensi dell'art. 6 par. 1 lett. c/f del GDPR.\n\n` +
            `TESTO DELLA DELEGA\n` });
      }

      const giaFatti = new Set();
      for (const inv of invii) {
        const k = inv.a.trim().toLowerCase();
        if (giaFatti.has(k)) continue;
        giaFatti.add(k);
        const testoCompleto = inv.apertura + testoDelega + piede;
        const esito = await spedisci({ a: inv.a, oggetto, testo: testoCompleto, html: htmlConFirma(testoCompleto, nomeDelegante), nomeMittente, rispondiA: inv.rispondiA });
        esiti.push({ ruolo: inv.ruolo, ok: !!esito.ok, errore: esito.errore || null });
        if (esito.errore) console.error('Email delega non inviata a', inv.ruolo, esito.errore);
      }
    }

    // LT-322: avviso ai delegati esterni di prima (delega cambiata o annullata)
    for (const extId of daAvvisare) {
      const { data: de } = await db.from('delegati_esterni').select('nome, email')
        .eq('stabile_id', stabile.id).eq('ext_id', extId).maybeSingle();
      if (!de) continue;
      const nomeEst = String(de.nome || 'persona delegata').trim();
      const elenco = assembleeValide.map(a => `- ${a.oggetto || 'Assemblea'} del ${dataIt(a.data_seconda)}`).join('\n');
      const oggettoAvviso = 'Delega annullata - ' + stabile.nome;
      const testoEst = `Gentile ${nomeEst},\n${nomeDelegante} ha annullato la delega che ti aveva dato per:\n${elenco}\n\nIl link personale che avevi ricevuto per queste assemblee non è più attivo.\n\nPer qualsiasi chiarimento puoi rispondere a questa email.`;
      const testoAmm = `Il condòmino ${nomeDelegante} ha annullato la delega a ${nomeEst} (persona esterna) per:\n${elenco}\n\nIl link personale di ${nomeEst} non è più attivo.`;
      const avvisi = [];
      if (indirizzoPlausibile(de.email)) avvisi.push({ ruolo: 'avviso_delegato', a: de.email, testo: testoEst, rispondiA: emailDelegante || emailAmm });
      if (emailAmm) avvisi.push({ ruolo: 'avviso_amministratore', a: emailAmm, testo: testoAmm, rispondiA: emailDelegante });
      for (const av of avvisi) {
        const esito = await spedisci({ a: av.a, oggetto: oggettoAvviso, testo: av.testo, nomeMittente, rispondiA: av.rispondiA });
        esiti.push({ ruolo: av.ruolo, ok: !!esito.ok, errore: esito.errore || null });
        if (esito.errore) console.error('Avviso delega annullata non inviato a', av.ruolo, esito.errore);
      }
    }

    const riusciti = esiti.filter(e => e.ok).length;
    if (riusciti > 0) {
      const { error: errReg } = await db.from('email_delega_inviate').insert({ condomino_id: c.id, destinatari: riusciti });
      if (errReg) console.error('Registro email delega non aggiornato:', errReg);
    }
    return rispondi(res, riusciti > 0 ? 200 : 502, {
      ok: riusciti > 0,
      esiti: esiti.map(e => ({ ruolo: e.ruolo, ok: e.ok })),
      errore: riusciti > 0 ? null : (esiti[0] && esiti[0].errore) || 'Nessun indirizzo a cui scrivere.'
    });
  } catch (e) {
    console.error('Errore email-delega:', e);
    return rispondi(res, 500, { ok: false, errore: 'Errore imprevisto del server.' });
  }
}
