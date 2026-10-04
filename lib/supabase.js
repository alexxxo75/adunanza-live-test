// Funzioni di supporto per le funzioni server che parlano con Supabase.
// Questo file gira SOLO sul server (Vercel): la chiave segreta non arriva mai al browser.
import { createClient } from '@supabase/supabase-js';

function errore(stato, messaggio) {
  const e = new Error(messaggio);
  e.stato = stato;
  return e;
}

function variabile(nome) {
  const v = process.env[nome];
  if (!v) throw errore(500, 'Configurazione mancante sul server: ' + nome);
  return v;
}

// Indirizzo pubblico del sito, usato nei link delle email di invito.
function urlSito() {
  return (process.env.SITE_URL || 'https://riunion.it').replace(/\/+$/, '');
}

// Client con la chiave SEGRETA: ignora le regole RLS, quindi va usato con molta cautela
// e solo dopo aver controllato chi sta chiamando.
function clienteServer() {
  return createClient(variabile('SUPABASE_URL'), variabile('SUPABASE_SECRET_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function leggiCorpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { throw errore(400, 'Richiesta non valida.'); }
}

// Controlla che chi chiama abbia fatto login E sia un ADMINISTRATOR attivo.
// Il controllo si basa sul database, non su ciò che dice il browser.
async function richiediAdministrator(req) {
  const intestazione = req.headers['authorization'] || '';
  const token = intestazione.startsWith('Bearer ') ? intestazione.slice(7).trim() : '';
  if (!token) throw errore(401, 'Accesso non effettuato.');

  // Secondo passaggio (2FA): per gli ADMINISTRATOR il codice è obbligatorio. Il token è già
  // verificato da getUser qui sotto; qui se ne legge solo il livello di accesso ("aal2").
  let livello = null;
  try { livello = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).aal; } catch (e) { livello = null; }

  const db = clienteServer();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data || !data.user) throw errore(401, 'Sessione non valida o scaduta. Accedi di nuovo.');

  const { data: profilo, error: errProfilo } = await db
    .from('amministratori')
    .select('id, ruolo, attivo, email')
    .eq('id', data.user.id)
    .maybeSingle();
  if (errProfilo) throw errore(500, 'Errore nel controllo dei permessi.');
  if (!profilo || profilo.ruolo !== 'administrator' || !profilo.attivo) {
    throw errore(403, 'Non hai i permessi per questa operazione.');
  }
  if (livello !== 'aal2') throw errore(403, 'Serve la verifica in due passaggi: esci, accedi di nuovo e inserisci il codice.');
  return { db, utente: data.user, profilo };
}

function rispondiErrore(res, e) {
  const stato = e && e.stato ? e.stato : 500;
  if (!e || !e.stato) console.error('Errore imprevisto:', e);
  res.status(stato).json({ ok: false, errore: stato === 500 && !(e && e.stato) ? 'Errore imprevisto del server.' : e.message });
}

export { errore, urlSito, clienteServer, leggiCorpo, richiediAdministrator, rispondiErrore };
