// Dà alla pagina l'indirizzo di Supabase e la chiave PUBBLICA (publishable), fatta apposta per stare nel browser.
// La chiave segreta non compare mai qui.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const url = process.env.SUPABASE_URL;
  const chiavePubblica = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !chiavePubblica) {
    return res.status(500).json({ ok: false, errore: 'Configurazione di Supabase mancante sul server.' });
  }
  res.status(200).json({ ok: true, url, chiavePubblica });
}
