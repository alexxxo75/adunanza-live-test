// lib/promemoria.js — LT-327 (spostato qui nella LT-328)
//
// NON è una funzione a sé: il piano gratuito di Vercel ne permette al massimo 12 e Riunion era già
// a 12. La chiama /api/email-delega quando l'indirizzo contiene ?azione=promemoria.
//
// PROMEMORIA AUTOMATICO 30 MINUTI PRIMA DELL'ASSEMBLEA.
// La chiama ogni 5 minuti il "timer" di Supabase (vedi lo script LT-327 per Supabase).
// Chiede al database quali assemblee hanno la casella del promemoria attiva e iniziano
// (seconda convocazione) entro 30 minuti: il database le segna subito come "inviate", così
// ogni promemoria parte UNA volta sola anche se questa funzione venisse chiamata più volte.
// Chiamarla da fuori non serve a nulla: manda solo i promemoria già dovuti e non ancora partiti.
//
// A chi arriva:
//   - ai condòmini convocati (al proprietario principale, con il suo link), TRANNE chi ha delegato;
//   - agli ospiti invitati all'assemblea (con il loro link da ospite);
//   - ai delegati esterni che hanno una delega per quell'assemblea (con il loro link personale).
//
// Variabili d'ambiente: SUPABASE_URL, SUPABASE_SECRET_KEY, BREVO_API_KEY, EMAIL_MITTENTE.

import { clienteServer } from './supabase.js';
import { spedisci, indirizzoPlausibile } from './posta.js';

function dataIt(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? m[3] + '/' + m[2] + '/' + m[1] : String(iso || '');
}
function oraIt(t) {
  const m = /^(\d{2}):(\d{2})/.exec(String(t || ''));
  return m ? m[1] + ':' + m[2] : String(t || '');
}
function nomeDi(p) {
  return [p && p.nome, p && p.cognome].map(x => String(x || '').trim()).filter(Boolean).join(' ');
}
function indirizzoSito(req) {
  const host = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim();
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return 'https://adunanza-live-test-mwbc.vercel.app';
  return 'https://' + host;
}

async function promemoriaAssemblea(db, idAssemblea, base) {
  const { data: a } = await db.from('assemblee')
    .select('id, id_app, stabile_id, oggetto, modalita, data_seconda, ora_seconda, luogo')
    .eq('id', idAssemblea).maybeSingle();
  if (!a) return 0;
  const { data: stabile } = await db.from('stabili').select('id, nome, comune, amministratore_id').eq('id', a.stabile_id).maybeSingle();
  if (!stabile) return 0;
  const { data: adm } = await db.from('amministratori')
    .select('attivo, email, email_contatto, ragione_sociale, nome, cognome').eq('id', stabile.amministratore_id).maybeSingle();
  if (!adm || !adm.attivo) return 0;

  const emailAmm = indirizzoPlausibile(adm.email_contatto) ? adm.email_contatto : (indirizzoPlausibile(adm.email) ? adm.email : null);
  const nomeAmm = String(adm.ragione_sociale || '').trim() || nomeDi(adm) || 'L\'Amministratore';
  const { data: sv } = await db.from('stato_vivo').select('dati').eq('assemblea_id', a.id).maybeSingle();
  const deleghe = (sv && sv.dati && sv.dati.appello && sv.dati.appello.deleghe) || {};

  const ora = oraIt(a.ora_seconda);
  const online = a.modalita !== 'in-presenza';
  const presenza = a.modalita !== 'online';
  const oggetto = `Promemoria: assemblea alle ${ora} - ${a.oggetto || 'Assemblea'} - ${stabile.nome}`;
  const corpo = (saluto, link) =>
    `Gentile ${saluto},\n\nti ricordiamo che l'assemblea del condominio ${stabile.nome}${stabile.comune ? ', ' + stabile.comune : ''}` +
    `${a.oggetto ? ' ("' + a.oggetto + '")' : ''} inizia oggi, ${dataIt(a.data_seconda)}, alle ore ${ora} (seconda convocazione).\n\n` +
    (online && link ? `Per partecipare online:\n${link}\n\nL'ingresso alla videochiamata si apre qualche minuto prima dell'inizio.\n\n` : '') +
    (presenza ? `Luogo: ${String(a.luogo || '').trim() || 'come indicato nella convocazione'}\n\n` : '') +
    `Cordiali saluti\n${nomeAmm}`;

  const invii = [];
  const giaVisti = new Set();
  const aggiungi = (email, saluto, link) => {
    if (!indirizzoPlausibile(email)) return;
    const k = email.trim().toLowerCase() + '|' + (link || '');
    if (giaVisti.has(k)) return;
    giaVisti.add(k);
    invii.push({ a: email.trim(), testo: corpo(saluto, link) });
  };

  // 1. condòmini convocati (al proprietario principale), tranne chi ha delegato
  const { data: conv } = await db.from('convocati_selezionati').select('condomino_id').eq('assemblea_id', a.id);
  const idsConv = (conv || []).map(r => r.condomino_id);
  if (idsConv.length) {
    const { data: tutti } = await db.from('condomini').select('id, id_app, nome, cognome, email, token, unificato_con').eq('stabile_id', stabile.id);
    const perId = new Map((tutti || []).map(c => [c.id, c]));
    const proprietari = new Map();
    for (const id of idsConv) {
      const c = perId.get(id); if (!c) continue;
      const p = (c.unificato_con && perId.get(c.unificato_con)) || c;
      proprietari.set(p.id, p);
    }
    for (const p of proprietari.values()) {
      if (String(p.id_app) in deleghe) continue;            // ha delegato: il promemoria va al suo delegato
      const link = p.token ? `${base}/?token=${encodeURIComponent(p.token)}&assemblea=${a.id_app}` : null;
      aggiungi(p.email, nomeDi(p) || 'condòmino', link);
    }
  }

  // 2. ospiti
  const { data: ospiti } = await db.from('ospiti').select('nome, email, token').eq('assemblea_id', a.id);
  for (const o of (ospiti || [])) {
    aggiungi(o.email, String(o.nome || '').trim() || 'ospite', o.token ? `${base}/?ospite=${encodeURIComponent(o.token)}` : null);
  }

  // 3. delegati esterni con una delega per questa assemblea
  const esterni = [...new Set(Object.values(deleghe).filter(v => typeof v === 'string' && v.startsWith('ext-')))];
  if (esterni.length) {
    const { data: de } = await db.from('delegati_esterni').select('ext_id, nome, email, token').eq('stabile_id', stabile.id).in('ext_id', esterni);
    for (const e of (de || [])) {
      aggiungi(e.email, String(e.nome || '').trim() || 'delegato', e.token ? `${base}/?token=${encodeURIComponent(e.token)}&assemblea=${a.id_app}` : null);
    }
  }

  let riusciti = 0;
  for (const inv of invii) {
    const esito = await spedisci({ a: inv.a, oggetto, testo: inv.testo, nomeMittente: nomeAmm + ' (tramite Riunion)', rispondiA: emailAmm });
    if (esito.ok) riusciti++; else console.error('Promemoria non inviato a', inv.a, esito.errore);
  }
  await db.from('promemoria_inviati').update({ destinatari: riusciti }).eq('assemblea_id', a.id);
  return riusciti;
}

export async function gestisciPromemoria(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  let db;
  try { db = clienteServer(); } catch (e) { return res.status(500).json({ ok: false, errore: e.message }); }
  try {
    const { data, error } = await db.rpc('promemoria_da_inviare');
    if (error) { console.error('promemoria_da_inviare:', error); return res.status(500).json({ ok: false, errore: 'Database non pronto (manca lo script LT-327?).' }); }
    const ids = (data || []).map(x => (typeof x === 'string' ? x : (x && (x.promemoria_da_inviare || x.assemblea_id)))).filter(Boolean);
    const base = indirizzoSito(req);
    const esiti = [];
    for (const id of ids) {
      try { esiti.push({ assemblea: id, inviati: await promemoriaAssemblea(db, id, base) }); }
      catch (e) { console.error('Promemoria assemblea', id, e); esiti.push({ assemblea: id, errore: true }); }
    }
    return res.status(200).json({ ok: true, assemblee: esiti.length, esiti });
  } catch (e) {
    console.error('Errore promemoria:', e);
    return res.status(500).json({ ok: false, errore: 'Errore imprevisto del server.' });
  }
}
