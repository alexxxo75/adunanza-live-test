// POST /api/amministratori/statistiche   (nessun corpo)
// Con corpo { cosa: '2fa' } risponde invece con l'elenco degli account che hanno il 2FA attivo
// (serve all'icona "azzera 2FA" di /gestione): sta qui per tenere il numero di funzioni sotto il limite di Vercel.
// Solo un ADMINISTRATOR. Per ogni amministratore di condominio: quanti e quali condomini gestisce,
// quante unità sono registrate in ciascuno, quante assemblee ha concluse / in corso / pianificate e,
// per le concluse, durata e partecipanti. Restituisce SOLO numeri: mai i nomi dei condòmini.
import { errore, leggiCorpo, richiediAdministrator, rispondiErrore } from '../supabase.js';

// Supabase restituisce al massimo 1000 righe per richiesta: si legge a pagine.
async function leggiTutto(costruisci) {
  let tutte = [];
  for (let da = 0; ; da += 1000) {
    const { data, error } = await costruisci().range(da, da + 999);
    if (error) throw errore(500, 'Errore nella lettura dei dati: ' + error.message);
    tutte = tutte.concat(data || []);
    if (!data || data.length < 1000) break;
  }
  return tutte;
}
const distinti = (lista) => new Set((Array.isArray(lista) ? lista : []).map((r) => r && r.condominoId).filter((x) => x !== undefined && x !== null)).size;

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw errore(405, 'Metodo non consentito.');
    const { db } = await richiediAdministrator(req);

    if (leggiCorpo(req).cosa === '2fa') {
      const { data: righe2, error: err2 } = await db.from('amministratori').select('id');
      if (err2) throw errore(500, 'Impossibile leggere l\'elenco degli amministratori.');
      const attivi = [];
      await Promise.all((righe2 || []).map(async (r) => {
        const { data, error } = await db.auth.admin.mfa.listFactors({ userId: r.id });
        if (error) return;   // in dubbio: non lo segno come attivo
        if (((data && data.factors) || []).some((f) => f.status === 'verified')) attivi.push(r.id);
      }));
      return res.status(200).json({ ok: true, con_2fa: attivi });
    }

    const [amm, stabili, unita, assemblee, vivi] = await Promise.all([
      leggiTutto(() => db.from('amministratori').select('id, nome, cognome, email, attivo, ruolo').eq('ruolo', 'amministratore').order('id')),
      leggiTutto(() => db.from('stabili').select('id, nome, amministratore_id, attivo').order('id')),
      leggiTutto(() => db.from('condomini').select('id, stabile_id').order('id')),
      leggiTutto(() => db.from('assemblee').select('id, stabile_id, oggetto, tipo, stato, data_prima, data_seconda, ora_inizio, extra').order('id')),
      leggiTutto(() => db.from('stato_vivo').select('assemblea_id, appello:dati->appello').order('assemblea_id'))
    ]);

    // Stato di fatturazione: nessuna riga = "in prova". Se la tabella non esiste ancora, si procede senza.
    const fattPer = new Map();
    let fattPronta = true;
    try {
      const f = await leggiTutto(() => db.from('fatturazione_assemblee').select('assemblea_id, stato, numero_fattura, data_fattura, data_pagamento').order('assemblea_id'));
      f.forEach((r) => fattPer.set(String(r.assemblea_id), r));
    } catch (e) {
      fattPronta = false;
      console.error('Tabella fatturazione_assemblee non disponibile:', e && e.message);
    }

    const appelloDi = new Map(vivi.map((v) => [v.assemblea_id, v.appello || {}]));
    const unitaPer = new Map();
    unita.forEach((u) => unitaPer.set(u.stabile_id, (unitaPer.get(u.stabile_id) || 0) + 1));

    let durateNote = 0;
    const assPer = new Map();
    assemblee.forEach((a) => {
      const conclusa = a.stato === 'conclusa';
      const inCorso = a.stato === 'in-corso';
      const pianificata = !conclusa && !inCorso && !!(a.data_seconda || a.data_prima);
      const ap = appelloDi.get(a.id) || {};
      let durata = null;
      const fine = a.extra && Number(a.extra.oraFineEpoch);
      if (conclusa && a.ora_inizio && fine) {
        const min = Math.round((fine - new Date(a.ora_inizio).getTime()) / 60000);
        if (min >= 0 && min < 24 * 60) { durata = min; durateNote++; }
      }
      const riga = {
        id: a.id, oggetto: a.oggetto || '', tipo: a.tipo || 'ordinaria',
        stato: conclusa ? 'conclusa' : (inCorso ? 'in-corso' : (pianificata ? 'pianificata' : 'bozza')),
        data: a.data_seconda || a.data_prima || null,
        durata_min: durata,
        remoto: (conclusa || inCorso) ? distinti(ap.online) : null,
        presenza: (conclusa || inCorso) ? distinti(ap.presenzeFisiche) : null,
        fatturazione: null
      };
      if (conclusa || inCorso) {
        const f = fattPer.get(String(a.id));
        riga.fatturazione = f
          ? { stato: f.stato, numero_fattura: f.numero_fattura || '', data_fattura: f.data_fattura || '', data_pagamento: f.data_pagamento || '' }
          : { stato: 'in-prova', numero_fattura: '', data_fattura: '', data_pagamento: '' };
      }
      if (!assPer.has(a.stabile_id)) assPer.set(a.stabile_id, []);
      assPer.get(a.stabile_id).push(riga);
    });

    const condPer = new Map();
    stabili.forEach((s) => {
      const lista = (assPer.get(s.id) || []).filter((x) => x.stato !== 'bozza');
      lista.sort((x, y) => String(y.data || '').localeCompare(String(x.data || '')));
      const c = {
        id: s.id, nome: s.nome || '(senza nome)', attivo: s.attivo !== false,
        unita: unitaPer.get(s.id) || 0,
        concluse: lista.filter((x) => x.stato === 'conclusa').length,
        in_corso: lista.filter((x) => x.stato === 'in-corso').length,
        pianificate: lista.filter((x) => x.stato === 'pianificata').length,
        assemblee: lista
      };
      if (!condPer.has(s.amministratore_id)) condPer.set(s.amministratore_id, []);
      condPer.get(s.amministratore_id).push(c);
    });

    const elenco = amm.map((u) => ({
      id: u.id, nome: u.nome || '', cognome: u.cognome || '', email: u.email, attivo: !!u.attivo,
      condomini: (condPer.get(u.id) || []).sort((x, y) => x.nome.localeCompare(y.nome, 'it'))
    }));
    res.status(200).json({ ok: true, amministratori: elenco, durate_disponibili: durateNote, fatturazione_pronta: fattPronta });
  } catch (e) {
    rispondiErrore(res, e);
  }
}
