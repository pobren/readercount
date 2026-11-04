// ReaderCount as an app: the web app manifest and a small service worker, so people can add their
// stats to a phone home screen or Mac Dock and open them full-screen like any other app.

export const MANIFEST = JSON.stringify({
	name: "ReaderCount",
	short_name: "ReaderCount",
	description: "Private, cookie-free stats for your websites.",
	id: "/",
	start_url: "/",
	scope: "/",
	display: "standalone",
	background_color: "#f6f5f2",
	theme_color: "#f6f5f2",
	icons: [
		// iPhones read "any" icons; Android also picks the "maskable" one. Each purpose gets its own entry, as some browsers drop an icon whose purpose list has a word they don't know.
		{ src: "/apple-touch-icon.png?v=2", sizes: "180x180", type: "image/png", purpose: "any" },
		{ src: "/icon-192.png?v=2", sizes: "192x192", type: "image/png", purpose: "any" },
		{ src: "/icon.png?v=2", sizes: "512x512", type: "image/png", purpose: "any" },
		{ src: "/icon.png?v=2", sizes: "512x512", type: "image/png", purpose: "maskable" },
	],
});

const OFFLINE = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline · ReaderCount</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5f2;color:#1b1b1d;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;padding:24px}@media (prefers-color-scheme:dark){body{background:#121214;color:#ececee}}h1{font-size:22px;margin:0 0 8px}button{margin-top:16px;font:inherit;padding:10px 20px;border-radius:999px;border:0;background:#2f6fec;color:#fff}</style></head><body><main><h1>You're offline</h1><p>Your stats will be here as soon as you're back online.</p><button onclick="location.reload()">Try again</button></main></body></html>`;

/** Only page loads go through it: if there's no connection, show a friendly page instead of the browser's error. */
export const SERVICE_WORKER = `self.addEventListener("install",function(){self.skipWaiting()});
self.addEventListener("activate",function(e){e.waitUntil(self.clients.claim())});
self.addEventListener("fetch",function(e){if(e.request.mode!=="navigate")return;e.respondWith(fetch(e.request).catch(function(){return new Response(${JSON.stringify(OFFLINE)},{headers:{"Content-Type":"text/html; charset=utf-8"}})}))});`;

/** One-click install. Chrome, Edge and Android hand us an install prompt, so
 * the "Get the app" link and the Install button install straight away; Safari on a Mac, iPhone and iPad can't be asked,
 * so they show the two steps for that browser instead. Nothing shows inside the app itself, or where there's no way to install. */
const INSTALL = `(function(){
var prompt=null;
function installed(){return matchMedia("(display-mode: standalone)").matches||navigator.standalone===true}
function steps(){var ua=navigator.userAgent;
if(/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1))return "Tap the Share button in Safari, then Add to Home Screen. ReaderCount then opens from your home screen like any other app.";
if(/Android/.test(ua))return "Open your browser's menu (the three dots) and choose Install app or Add to home screen.";
if(/Edg\\//.test(ua))return "Click the app button at the right of the address bar, or open the \u22ef menu and choose Apps, then Install ReaderCount.";
if(/Chrome\\//.test(ua))return "Click the install button at the right of the address bar, or open the \u22ee menu and choose Cast, save and share, then Install page as app.";
if(/Mac OS X/.test(ua)&&/Safari\\//.test(ua))return "In Safari, open the File menu and choose Add to Dock. ReaderCount then opens in its own window, like any other app.";
return null}
function draw(done){
var how=steps(),can=!!prompt;
document.querySelectorAll("[data-rc-get]").forEach(function(b){b.hidden=installed()||done||(!can&&!how)});
document.querySelectorAll("[data-rc-install]").forEach(function(b){b.hidden=installed()||done||!can});
document.querySelectorAll("[data-rc-here]").forEach(function(p){p.textContent=installed()?"ReaderCount is installed on this device. Open it from your Dock, Start menu or home screen.":done?"Done. ReaderCount is on this device: open it from your Dock, Start menu or home screen.":can?"This browser can install ReaderCount in one click.":how?"On this device: "+how:"This browser can't install apps. Open ReaderCount in Chrome, Edge or Safari, or follow the steps for your device below."});
document.querySelectorAll("[data-rc-how]").forEach(function(p){if(can||!how||done)p.hidden=true;else p.textContent=how})}
function install(){if(!prompt)return;var e=prompt;e.prompt();e.userChoice.then(function(c){prompt=null;draw(c.outcome==="accepted")},function(){})}
addEventListener("beforeinstallprompt",function(e){e.preventDefault();prompt=e;draw()});
addEventListener("appinstalled",function(){prompt=null;draw(true)});
document.addEventListener("click",function(e){var t=e.target.closest&&e.target.closest("[data-rc-get],[data-rc-install]");if(!t)return;
if(prompt)return install();
document.querySelectorAll("[data-rc-how]").forEach(function(p){p.hidden=!p.hidden;t.setAttribute("aria-expanded",String(!p.hidden))})});
document.addEventListener("DOMContentLoaded",function(){draw()});
if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js").catch(function(){});
})()`;

/** Tags for the <head> of every signed-in page. */
export const APP_HEAD = `<link rel="manifest" href="/manifest.webmanifest?v=2"><meta name="theme-color" content="#f6f5f2" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#121214" media="(prefers-color-scheme: dark)"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="ReaderCount"><meta name="apple-mobile-web-app-status-bar-style" content="default"><script>${INSTALL}</script>`;
