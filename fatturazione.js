// © 2026 Alessandro Castiglioni. Tutti i diritti riservati.
// POST /api/amministratori/fatturazione
//   corpo: { assemblea_id, stato, numero_fattura?, data_fattura?, data_pagamento? }
// Solo un ADMINISTRATOR. Imposta lo stato di fatturazione di UNA assemblea conclusa.
// Stati: 'in-prova' (gratuita: è la situazione di partenza, equivale a nessuna riga),
//        'da-fatturare', 'fatturata' (numero e data fattura), 'pagata' (anche data del pagamento).
// I dati stanno nella tabella "fatturazione_assemblee", separata da "assemblee" di proposito:
// l'app principale riscrive la tabella delle assemblee quando salva, e non deve poter cancellare questi dati.
import { errore, leggiCorpo, richiediAdministrator, rispondiErrore } from '../supabase.js';

const STATI = ['in-prova', 'da-fatturare', 'fatturata', 'pagata'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dataValida(testo) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(testo)) return false;
  const d = new Date(testo + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === testo;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw errore(405, 'Metodo non consentito.');
    const { db, profilo } = await richiediAdministrator(req);

    const corpo = leggiCorpo(req);
    const assembleaId = String(corpo.assemblea_id || '');
    const stato = String(corpo.stato || '');
    const numero = String(corpo.numero_fattura || '').trim().slice(0, 60);
    const dataFattura = String(corpo.data_fattura || '').trim();
    const dataPagamento = String(corpo.data_pagamento || '').trim();

    if (!UUID.test(assembleaId)) throw errore(400, 'Assemblea non valida.');
    if (!STATI.includes(stato)) throw errore(400, 'Stato di fatturazione non valido.');

    if (stato === 'fatturata' || stato === 'pagata') {
      if (!numero) throw errore(400, 'Inserisci il numero della fattura.');
      if (!dataValida(dataFattura)) throw errore(400, 'Inserisci la data della fattura.');
    }
    if (stato === 'pagata' && !dataValida(dataPagamento)) throw errore(400, 'Inserisci la data del pagamento.');
    if (stato === 'pagata' && dataPagamento < dataFattura) throw errore(400, 'Il pagamento non può essere precedente alla fattura.');

    const { data: ass, error: errAss } = await db
      .from('assemblee').select('id, stato, stabile_id').eq('id', assembleaId).maybeSingle();
    if (errAss) throw errore(500, 'Errore nella lettura dell\'assemblea.');
    if (!ass) throw errore(404, 'Assemblea non trovata.');
    if (ass.stato !== 'conclusa') throw errore(409, 'Lo stato di fatturazione si imposta solo quando l\'assemblea è conclusa.');

    const { data: prima, error: errPrima } = await db
      .from('fatturazione_assemblee').select('stato, numero_fattura, data_fattura, data_pagamento')
      .eq('assemblea_id', assembleaId).maybeSingle();
    if (errPrima) {
      console.error('Lettura fatturazione non riuscita:', errPrima);
      throw errore(500, 'La tabella della fatturazione non è pronta: esegui lo script SQL fornito e riprova.');
    }

    const nuovo = {
      stato: stato,
      numero_fattura: stato === 'fatturata' || stato === 'pagata' ? numero : null,
      data_fattura: stato === 'fatturata' || stato === 'pagata' ? dataFattura : null,
      data_pagamento: stato === 'pagata' ? dataPagamento : null
    };

    if (stato === 'in-prova') {
      const { error } = await db.from('fatturazione_assemblee').delete().eq('assemblea_id', assembleaId);
      if (error) throw errore(500, 'Salvataggio non riuscito. Riprova.');
    } else {
      const { error } = await db.from('fatturazione_assemblee').upsert(
        Object.assign({ assemblea_id: assembleaId, aggiornato_da: profilo.id, aggiornato_il: new Date().toISOString() }, nuovo),
        { onConflict: 'assemblea_id' });
      if (error) {
        console.error('Salvataggio fatturazione non riuscito:', error);
        throw errore(500, 'Salvataggio non riuscito. Riprova.');
      }
    }

    // L'amministratore a cui appartiene l'assemblea (per il registro delle operazioni).
    let suAmm = null;
    const { data: st } = await db.from('stabili').select('amministratore_id').eq('id', ass.stabile_id).maybeSingle();
    if (st) suAmm = st.amministratore_id;
    const { error: errReg } = await db.from('registro_operazioni').insert({
      eseguita_da: profilo.id,
      operazione: 'fatturazione_assemblea',
      su_amministratore: suAmm,
      dettagli: { assemblea_id: assembleaId, prima: prima || { stato: 'in-prova' }, dopo: nuovo }
    });
    if (errReg) console.error('Registro operazioni non aggiornato:', errReg);

    res.status(200).json({ ok: true, fatturazione: nuovo });
  } catch (e) {
    rispondiErrore(res, e);
  }
}
