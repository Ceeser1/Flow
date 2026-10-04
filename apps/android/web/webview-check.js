// Runs before anything else of Flow's, and is written to run anywhere (no
// newer JavaScript): Flow's page needs Android System WebView 108 or later
// (2022; Android 8 phones get it from the Play Store). An older one would
// stop at the first newer line with a message nobody can act on, so this says
// what to update and stops the page here.
(function () {
  var MIN = 108;
  var m = /Chrome\/(\d+)/.exec(navigator.userAgent || '');
  var version = m ? Number(m[1]) : 0;
  if (version >= MIN) return;
  // Nothing after this script is read: no other script runs.
  document.write('<plaintext style="display:none">');
  var store = 'https://play.google.com/store/apps/details?id=com.google.android.webview';
  var box = document.createElement('div');
  box.setAttribute('style', 'position:fixed;top:0;left:0;width:100vw;height:100vh;box-sizing:border-box;overflow:auto;'
    + 'background:#1e1e22;color:#e8e8ea;font:16px/1.5 sans-serif;padding:48px 24px;z-index:9');
  box.innerHTML = '<h1 style="font-size:24px;margin:0 0 16px">Flow needs a newer WebView</h1>'
    + '<p>Flow shows its screens with Android System WebView, which is version ' + (version || 'unknown')
    + ' on this phone. Flow needs version ' + MIN + ' or later.</p>'
    + '<p>Update <b>Android System WebView</b> (and Chrome) in the Play Store, then open Flow again.</p>'
    + '<p><a href="' + store + '" style="display:inline-block;margin-top:12px;padding:12px 20px;border-radius:8px;'
    + 'background:#5a8cdc;color:#fff;text-decoration:none">Open in the Play Store</a></p>';
  // The page's own (wider) layout would widen the screen: it is not shown.
  if (document.body) document.body.style.display = 'none';
  document.documentElement.appendChild(box);
}());
