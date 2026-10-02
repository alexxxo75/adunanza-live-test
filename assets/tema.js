// Selettore del tema: Chiaro / Automatico / Scuro. La scelta resta salvata su questo dispositivo.
// "Automatico" segue le impostazioni del telefono o del computer.
(function () {
  var CHIAVE = 'riunion-tema';
  var radice = document.documentElement;

  function leggi() {
    try {
      var v = window.localStorage.getItem(CHIAVE);
      return (v === 'light' || v === 'dark') ? v : 'auto';
    } catch (e) { return 'auto'; }
  }
  function scrivi(scelta) {
    try {
      if (scelta === 'auto') window.localStorage.removeItem(CHIAVE);
      else window.localStorage.setItem(CHIAVE, scelta);
    } catch (e) { /* se il browser non permette di salvare, il tema vale solo per questa visita */ }
  }
  function applica(scelta) {
    if (scelta === 'light' || scelta === 'dark') radice.setAttribute('data-theme', scelta);
    else radice.removeAttribute('data-theme');
  }
  function aggiornaPulsanti() {
    var scelta = leggi();
    var pulsanti = document.querySelectorAll('[data-tema]');
    for (var i = 0; i < pulsanti.length; i++) {
      pulsanti[i].setAttribute('aria-pressed', pulsanti[i].getAttribute('data-tema') === scelta ? 'true' : 'false');
    }
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('[data-tema]') : null;
    if (!b) return;
    var scelta = b.getAttribute('data-tema');
    scrivi(scelta);
    applica(scelta);
    aggiornaPulsanti();
  });

  applica(leggi()); // subito, prima che la pagina venga disegnata: niente "lampo" di tema sbagliato
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', aggiornaPulsanti);
  else aggiornaPulsanti();
})();
