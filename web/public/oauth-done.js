// The platform sent the pop-up back here after "Connect with ...". Tell the console window (BroadcastChannel,
// because the platform's pages cut the window.opener link) and close; without a console window, go to Accounts.
(function () {
  var query = location.search;
  var nl = (navigator.language || '').toLowerCase().indexOf('nl') === 0;
  var ok = new URLSearchParams(query).has('connected');
  document.getElementById('msg').textContent = ok
    ? (nl ? 'Account gekoppeld. Dit venster sluit vanzelf.' : 'Account connected. This window closes by itself.')
    : (nl ? 'Koppelen is niet gelukt. Dit venster sluit vanzelf.' : 'Connecting did not work. This window closes by itself.');
  var back = document.getElementById('back');
  back.href = '/accounts' + query;
  back.textContent = nl ? 'Terug naar Accounts' : 'Back to Accounts';
  try { new BroadcastChannel('restream-oauth').postMessage({ query: query }); } catch (e) { /* old browser */ }
  try { localStorage.setItem('restream-oauth', JSON.stringify({ query: query, t: Date.now() })); } catch (e) { /* storage blocked */ }
  setTimeout(function () { window.close(); }, 400);
  // Still open (not opened as a pop-up, or the browser refuses to close it): show the result on the Accounts page.
  setTimeout(function () { location.replace('/accounts' + query); }, 1500);
})();
