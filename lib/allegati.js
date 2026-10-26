// lib/allegati.js — allegati della convocazione (LT-345, LT-346).
//
// I file stanno nello spazio file privato "allegati" di Supabase, in una cartella per
// assemblea: "<id assemblea>/<nome>". Dalla LT-346 nelle email non viaggia il file ma un LINK
// per scaricarlo: la pagina dell'amministratore scrive nel testo dell'email
//     <a href="riunion-allegato:<percorso del file>">Scarica</a>
// e qui il server sostituisce quell'indirizzo con un link firmato di Supabase, valido fino alla
// fine del 5° giorno dopo la seconda convocazione. Poi il link scade e il file viene cancellato
// (pulisciAllegatiScaduti, chiamata dal timer ogni 5 minuti).
// Così il file esce dal server solo quando qualcuno lo scarica davvero.

const BUCKET = 'allegati';
const GIORNI_DOPO_ASSEMBLEA = 5;
const RE_LINK = /riunion-allegato:([A-Za-z0-9._\/-]+)/g;

// Percorsi dei file citati nel testo dell'email (senza doppioni, solo forme sicure).
export function trovaLinkAllegati(html) {
  const out = new Set();
  for (const m of String(html || '').matchAll(RE_LINK)) {
    const p = m[1];
    if (!p.includes('..') && /^[0-9a-f-]{36}\/[^/]+$/i.test(p)) out.add(p);
  }
  return [...out];
}
export function assembleaDelPercorso(path) { return String(path).split('/')[0]; }

// Fine del giorno (ora di Roma) "data_seconda + 5 giorni", in secondi da adesso.
function secondiAllaScadenza(dataSecondaIso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dataSecondaIso || ''));
  const adesso = Date.now();
  if (!m) return 30 * 86400;   // data mancante: 30 giorni (non dovrebbe capitare: senza date non si invia)
  // mezzanotte (Roma) del giorno dopo la scadenza ≈ UTC 22:00/23:00 del giorno di scadenza
  const fine = Date.UTC(+m[1], +m[2] - 1, +m[3] + GIORNI_DOPO_ASSEMBLEA + 1, 0, 0, 0) - 60 * 60 * 1000;
  return Math.max(3600, Math.floor((fine - adesso) / 1000));
}

// Sostituisce i link "riunion-allegato:" con link firmati veri.
// consentita(idAssemblea) -> true/false: chi chiama può usare i file di quell'assemblea?
// cache (Map, facoltativa): percorso -> link firmato, per non rifirmare a ogni destinatario.
// Restituisce { html } oppure { errore }.
export async function sostituisciLinkAllegati(db, html, consentita, cache) {
  const percorsi = trovaLinkAllegati(html);
  if (!percorsi.length) return { html };
  const date = new Map();
  for (const p of percorsi) {
    const aid = assembleaDelPercorso(p);
    if (!(await consentita(aid))) return { errore: 'Gli allegati non appartengono a questa assemblea.' };
    if (!date.has(aid)) {
      const { data } = await db.from('assemblee').select('data_seconda').eq('id', aid).maybeSingle();
      date.set(aid, data ? data.data_seconda : null);
    }
  }
  let out = String(html);
  for (const p of percorsi) {
    let url = cache && cache.get(p);
    if (!url) {
      const nome = p.split('/').pop().replace(/^\d+-[a-z0-9]{1,8}-/i, '') || 'allegato';
      const { data, error } = await db.storage.from(BUCKET)
        .createSignedUrl(p, secondiAllaScadenza(date.get(assembleaDelPercorso(p))), { download: nome });
      if (error || !data || !data.signedUrl) return { errore: 'Un allegato non è più disponibile sul server: toglilo e caricalo di nuovo nella pagina dell\'assemblea.' };
      url = data.signedUrl;
      if (cache) cache.set(p, url);
    }
    out = out.split('riunion-allegato:' + p).join(url);
  }
  return { html: out };
}

// Cancella i file delle assemblee finite da più di 5 giorni (e di quelle eliminate).
export async function pulisciAllegatiScaduti(db) {
  const { data, error } = await db.rpc('allegati_scaduti', { p_limite: 100 });
  if (error) return { errore: 'funzione non pronta (manca lo script LT-346?)' };
  const nomi = (data || []).map(x => (typeof x === 'string' ? x : (x && (x.allegati_scaduti || x.name)))).filter(Boolean);
  if (!nomi.length) return { cancellati: 0 };
  const { error: e2 } = await db.storage.from(BUCKET).remove(nomi);
  if (e2) { console.error('Pulizia allegati:', e2); return { errore: 'cancellazione non riuscita' }; }
  return { cancellati: nomi.length };
}
