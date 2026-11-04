// ReaderCount: the script a website loads. It sets no cookies and stores nothing in the browser.
// Add to a site with: <script defer src="https://STATS-ADDRESS/s.js" data-site="example.com"></script>
// It sends: a page view on load (and on in-page navigation), the time the page was actually on
// screen when the reader leaves (and a short "back" when they return to a hidden tab, for the live view), clicks on links to other sites or to files, goals (anything marked
// data-rc-goal="Name", every form sent, or readercount("Name") from the site's own code), and whether
// the page is a "not found" page (its title says 404 or Page not found, or <meta name="readercount" content="404">).
// With the "leave" message it also sends, as plain numbers for the page: how far down the page the reader got,
// the page's speed (Core Web Vitals: largest paint, worst tap delay, layout shift; first page of the visit only),
// up to three problems seen on the page (a picture or file that didn't load, a script error, and whether any picture
// on the page loaded at all) and the names
// of forms the reader started filling in. Never what anyone typed, where they clicked, or anything about them.
// Plausible's own event code (plausible("Signup") and plausible-event-name= classes) also counts as goals,
// so a website moving from Plausible keeps its events.
// To stop counting your own visits, open any page of your site once with #readercount-ignore on the end of
// the address (#readercount-count undoes it). This is the only thing it ever stores, and only in your browser.

export const TRACKER = `(function(){
var d=document,w=window,l=location,n=navigator,s=d.currentScript;
if(!s||n.webdriver)return;
try{var L=localStorage,K="stats_ignore";if(l.hash=="#readercount-ignore")L.setItem(K,1);if(l.hash=="#readercount-count")L.removeItem(K);if(L.getItem(K))return}catch(x){}
function A(t,f){d.addEventListener(t,f,true)}function W(x){return x.replace(/^www\\./,"")}var site=s.getAttribute("data-site")||W(l.hostname),api=new URL(s.src).origin+"/e",vid,v0,last,prev,ms=0,sh=0,q=0,M=0,P=[],B={},F={},C=0,X=0,I=0,G=0;
function send(o){o.s=site;var b=JSON.stringify(o);if(!(n.sendBeacon&&n.sendBeacon(api,b)))try{fetch(api,{method:"POST",body:b,keepalive:true,credentials:"omit"})}catch(x){}}
function tick(){if(sh){ms+=Date.now()-sh;sh=0}}
function pb(t,u,m){u=(u||"").split(/[?#]/)[0].slice(0,300);var k=t+u+m;if(/^https?:/.test(u)&&!B[k]&&P.length<3){B[k]=1;P.push([t,u,m])}}
function scan(){[].forEach.call(d.images,function(i){var u=i.currentSrc||i.src;i.naturalWidth?G=1:i.complete&&!/\\.svg/i.test(u)&&pb("i",u,"")})}
function deep(){var h=d.documentElement,p=Math.round(100*(w.scrollY+w.innerHeight)/Math.max(1,h.scrollHeight));if(p>M)M=Math.min(p,100)}
function leave(){tick();if(!vid)return;scan();var f=Object.keys(F),o={k:"l",v:vid,d:Math.round(ms/1000),p:M};if(ms>999||P.length||f.length){if(vid==v0){o.c=Math.round(C);o.x=Math.round(X*1000);o.i=Math.round(I)}if(P.length)o.e=P,o.a=G;if(f.length)o.f=f;send(o);P=[];F={};q=1}}
function view(){var h=l.href.split("#")[0];if(h==last)return;if(vid)leave();prev=last;last=h;vid=Math.random().toString(36).slice(2,12);v0=v0||vid;ms=0;q=0;M=0;B={};sh=d.visibilityState=="visible"?Date.now():0;deep();var o={k:"v",u:l.href,r:prev||d.referrer,v:vid},m=d.querySelector("meta[name=readercount]");if(m&&m.content=="404"||/\\b404\\b|not found/i.test(d.title))o.m=1;send(o)}
function g(t){t=(t+"").trim().slice(0,80);t&&vid&&send({k:"g",u:l.href,t:t,v:vid})}
function pl(e){var c=e&&e.getAttribute&&e.getAttribute("class"),m=/plausible-event-name=(\\S+)/.exec(c||"");return m&&m[1].replace(/\\+/g," ")}
function fn(f){return f.dataset.rcGoal||pl(f)||"Form: "+(f.getAttribute("name")||f.id||l.pathname)}
function click(e){var t=e.target,x=t&&t.closest&&t.closest("[data-rc-goal]"),y=t&&t.closest&&t.closest("[class*='plausible-event-name=']"),a=t&&t.closest&&t.closest("a[href]"),u;x&&x.tagName!="FORM"?g(x.dataset.rcGoal):y&&y.tagName!="FORM"&&g(pl(y));if(!a)return;try{u=new URL(a.href)}catch(x){return}
if(!/^https?:$/.test(u.protocol))return;
var k=/\\.(pdf|zip|dmg|exe|msi|pkg|apk|mp3|mp4|mov|epub|docx?|xlsx?|pptx?|csv|rar|7z|gz)$/i.test(u.pathname)?"d":W(u.hostname)!=W(l.hostname)?"o":"";
if(k)send({k:k,u:l.href,t:u.href,v:vid})}
A("submit",function(e){g(fn(e.target))});
A("focusin",function(e){var f=e.target.form;f&&(F[fn(f)]=1)});
A("error",function(e){var t=e.target;t&&t.tagName&&pb(t.tagName=="IMG"?"i":"f",t.currentSrc||t.src||t.href,"")});
w.addEventListener("error",function(e){e.message&&pb("j",e.filename||l.href,(e.message+"").slice(0,150)+":"+e.lineno)});
w.addEventListener("scroll",deep,{passive:true});
try{var O=function(t,f,z){new PerformanceObserver(function(y){y.getEntries().forEach(f)}).observe(z||{type:t,buffered:true})};O("largest-contentful-paint",function(e){C=e.startTime});O("layout-shift",function(e){e.hadRecentInput||(X+=e.value)});O(0,function(e){e.interactionId&&e.duration>I&&(I=e.duration)},{type:"event",buffered:true,durationThreshold:40})}catch(x){}
w.readercount=g;
var o=w.plausible;w.plausible=function(t){g(t);o&&!o.q&&o.apply(this,arguments)};
A("click",click);
A("auxclick",function(e){if(e.button==1)click(e)});
A("visibilitychange",function(){if(d.visibilityState=="hidden")leave();else if(!vid)view();else if(!sh){sh=Date.now();if(q){q=0;send({k:"b",v:vid})}}});
w.addEventListener("pagehide",leave);
var p=history.pushState;if(p){history.pushState=function(){p.apply(this,arguments);view()};w.addEventListener("popstate",view)}
if(d.visibilityState!="prerender")view();
(o&&o.q||[]).forEach(function(a){g(a[0])});
})();`;

// Added to the script only for websites that have connected an affiliate network and haven't turned tagging off
// (src/index.ts decides from the page asking for it). Just before a reader follows a link to a network we know, it adds
// the page's address as that network's own sub-ID (Awin clickref, CJ sid, Impact subId1, Rakuten u1, Skimlinks xcust,
// Sovrn cuid, Partnerize pubref), so the network reports each sale with the post it came from. Links that already
// carry one are left alone. Only the page's address goes in, never anything about the reader.
export const TAGGER = `(function(){
var d=document,l=location,p=l.pathname.slice(0,200),N=[["awin1.com","clickref"],["linksynergy.com","u1"],["skimresources.com","xcust"],["viglink.com","cuid"],["anrdoezrs.net","sid"],["dpbolvw.net","sid"],["jdoqocy.com","sid"],["kqzyfj.com","sid"],["tkqlhce.com","sid"]];
function on(h,x){return h==x||h.slice(-x.length-1)=="."+x}
function t(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]"),u,h,i,k;if(!a)return;try{u=new URL(a.href)}catch(x){return}h=u.hostname;if(h==l.hostname)return;
if(on(h,"prf.hn")){if(!/\\/pubref:/.test(u.pathname)){u.pathname=u.pathname.replace(/\\/destination:|$/,function(m){return"/pubref:"+encodeURIComponent(p)+m});a.href=u}return}
k=/^\\/c\\/\\d+\\/\\d+\\/\\d+/.test(u.pathname)?"subId1":"";for(i=0;i<N.length&&!k;i++)if(on(h,N[i][0]))k=N[i][1];
if(k&&!u.searchParams.has(k)){u.searchParams.set(k,p);a.href=u}}
d.addEventListener("mousedown",t,true);d.addEventListener("touchstart",t,{capture:true,passive:true});d.addEventListener("keydown",function(e){e.key=="Enter"&&t(e)},true);
})();`;
