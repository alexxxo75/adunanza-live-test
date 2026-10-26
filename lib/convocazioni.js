// lib/convocazioni.js — LT-344: INVIO PIANIFICATO DELLE CONVOCAZIONI
//
// NON è una funzione a sé (su Vercel siamo al limite di 12): la chiama lib/promemoria.js, cioè
// lo stesso timer di Supabase che ogni 5 minuti manda il promemoria.
//
// Le email le prepara la pagina dell'amministratore quando pianifica l'invio (una per
// condòmino, con i suoi link personali) e le mette nella tabella "convocazioni_programmate".
// Qui si prendono quelle arrivate all'ora d'invio e si spediscono.
//
// Controlli prima di spedire (il testo arriva dalla pagina, quindi non ci si fida alla cieca):
//   - l'amministratore dell'assemblea deve essere attivo;
//   - il destinatario deve essere davvero un condòmino di quel condominio, con quella email;
//   - nome del mittente e indirizzo per le risposte si prendono dal profilo nel database.

import { spedisci, indirizzoPlausibile } from './posta.js';
import { sostituisciLinkAllegati } from './allegati.js';   // LT-346: allegati come link

function nomeDi(p) {
  return [p && p.nome, p && p.cognome].map(x => String(x || '').trim()).filter(Boolean).join(' ');
}

// Stesse trasformazioni di /api/invia-email.js, così l'email pianificata è identica a quella
// mandata a mano.
function versioneTestoSemplice(html) {
  return String(html || '')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, testo) => {
      const pulito = testo.replace(/<[^>]*>/g, '').trim();
      return pulito && pulito !== url ? `${pulito}: ${url}` : url;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/tr>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function corpoHtml(testoHtml) {
  const conACapo = String(testoHtml || '').replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2B2E33;max-width:600px;">'
    + conACapo + '</div>';
}

export async function inviaConvocazioniProgrammate(db) {
  const { data: righe, error } = await db.rpc('convocazioni_da_inviare', { p_limite: 60 });
  if (error) {
    // Script LT-344 non ancora eseguito: il promemoria deve continuare a funzionare lo stesso.
    console.error('convocazioni_da_inviare:', error);
    return { errore: 'tabella non pronta' };
  }
  if (!righe || !righe.length) return { inviate: 0 };

  const cacheAss = new Map();
  async function contesto(idAssemblea) {
    if (cacheAss.has(idAssemblea)) return cacheAss.get(idAssemblea);
    let ctx = null;
    const { data: a } = await db.from('assemblee').select('id, stabile_id').eq('id', idAssemblea).maybeSingle();
    if (a) {
      const { data: s } = await db.from('stabili').select('id, amministratore_id').eq('id', a.stabile_id).maybeSingle();
      const { data: adm } = s ? await db.from('amministratori').select('*').eq('id', s.amministratore_id).maybeSingle() : { data: null };
      if (s && adm) {
        const { data: cond } = await db.from('condomini').select('id, email').eq('stabile_id', s.id);
        ctx = {
          attivo: !!adm.attivo,
          nomeMittente: String(adm.nome_studio || '').trim() || String(adm.ragione_sociale || '').trim() || nomeDi(adm) || 'Riunion',
          rispondiA: [adm.email_contatto, adm.indirizzo_mittente, adm.email].find(indirizzoPlausibile) || null,
          email: new Map((cond || []).map(c => [c.id, String(c.email || '').trim().toLowerCase()]))
        };
      }
    }
    cacheAss.set(idAssemblea, ctx);
    return ctx;
  }

  let inviate = 0;
  const cacheLink = new Map();   // LT-346: ogni link di allegato si firma una volta sola per giro
  const toccate = new Map();   // assemblea -> condòmini raggiunti
  for (const r of righe) {
    let esito;
    try {
      const ctx = await contesto(r.assemblea_id);
      if (!ctx) esito = { errore: 'Assemblea o amministratore non trovati.' };
      else if (!ctx.attivo) esito = { errore: 'Amministratore non attivo.' };
      else if (!r.condomino_id || ctx.email.get(r.condomino_id) !== String(r.destinatario || '').trim().toLowerCase())
        esito = { errore: 'Il destinatario non è un condòmino di questo condominio (o la sua email è cambiata).' };
      else {
        // LT-346: i link agli allegati (solo file della cartella di questa assemblea)
        const prep = await sostituisciLinkAllegati(db, r.corpo, async aid => aid === r.assemblea_id, cacheLink);
        if (prep.errore) esito = { errore: prep.errore };
        else esito = await spedisci({
          a: r.destinatario, oggetto: r.oggetto,
          html: corpoHtml(prep.html), testo: versioneTestoSemplice(prep.html),
          nomeMittente: ctx.nomeMittente, rispondiA: ctx.rispondiA
        });
      }
    } catch (e) {
      esito = { errore: String(e && e.message || e).slice(0, 300) };
    }
    if (esito && esito.ok) {
      inviate++;
      await db.from('convocazioni_programmate').update({ stato: 'inviata', inviata_il: new Date().toISOString(), errore: null }).eq('id', r.id);
      if (!toccate.has(r.assemblea_id)) toccate.set(r.assemblea_id, []);
      toccate.get(r.assemblea_id).push(r.condomino_id);
    } else {
      console.error('Convocazione pianificata non inviata a', r.destinatario, esito && esito.errore);
      await db.from('convocazioni_programmate').update({ stato: 'errore', errore: String((esito && esito.errore) || 'errore').slice(0, 500) }).eq('id', r.id);
    }
  }

  // Come nell'invio a mano: l'assemblea risulta "convocazioni inviate" e i condòmini "invitati".
  for (const [idA, idsC] of toccate) {
    await db.from('assemblee').update({ inviti_inviati: true }).eq('id', idA);
    const ids = idsC.filter(Boolean);
    if (ids.length) await db.from('condomini').update({ invitato: true }).in('id', ids);
  }
  return { inviate, totale: righe.length };
}
