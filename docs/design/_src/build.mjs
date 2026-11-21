// Builds docs/design/{index.html, concept-a|b|c/index.html, tray SVGs}. Static output, no dependencies.
import { writeFileSync, mkdirSync } from 'node:fs';
import { CONCEPTS, tray, staticSvg, animatedSvg } from './lib.mjs';
import { S, STATE_ORDER, STATE_CAPTION, dropStage, winStage, windows } from './parts.mjs';
import { CSS } from './css.mjs';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// Default output: the folder above this one (docs/design).
const OUT = resolve(process.argv[2] || dirname(dirname(fileURLToPath(import.meta.url))));
const FILE = { lost: 'disconnected' };
const PICK = `<p><strong>Build C · Beacon.</strong> The brief puts the tray mark first, and C is the only set where every state has its own silhouette at 16 px. Its changes are also the easiest to notice from the corner of the eye, and they stop moving once the state settles.</p><p><strong>Borrow from A: the native menu.</strong> Linux needs it anyway, and it makes a cheaper first release. The rows and words match the panel in C, so the mark from C can ship with the menu from A first, and the frosted panel can follow.</p><p><strong>Keep the route from B for Settings.</strong> The hop strip is the best explanation of a failure, but it turns the dropdown into a small dashboard. It fits better as the Connection group in the settings window.</p><p>Main risk: the ring is the least distinctive mark. Use the arch from A as the app icon (Dock, installer, About) so the product still has its own face.</p>`;
const THEMES = ['light', 'dark'];
const pair = (fn) => `<div class="pair">${THEMES.map(fn).join('')}</div>`;

const TXT = {
  a: {
    lede: 'A tunnel mouth in the menu bar. It follows SF Symbols habits: a slash means off, an exclamation mark means it needs you. The dropdown is a real system menu, so the frosted glass, the keyboard and VoiceOver come from the system.',
    tray: 'One arch, four doorways. The doorway is solid when traffic flows. Motion is a fill, a drain and a sweep along the arch.',
    drop: 'A native menu: one line per row. doctor’s fix text is cut to a short form here, and the full result opens in Settings. Grey rows are information and do nothing when clicked.',
    win: 'A classic macOS pair: a three-step setup assistant and a tabbed settings window.',
    reads: { connected: 'Arch with a solid doorway', reconnecting: 'Arch broken into three dashes', lost: 'Empty arch with a slash', blocked: 'Empty arch with an exclamation mark', idle: 'Empty arch' },
    moves: { connected: 'Doorway fills from the ground up, 300 ms', reconnecting: 'Arch dims; a bright segment sweeps left to right, 1.5 s loop', lost: 'Doorway drains, the slash draws across, then one blink, 1 s', blocked: 'The mark drops into the doorway, then one blink, 1 s', idle: 'No motion' },
    strengths: ['Least to build: the native tray menu works on macOS, Windows and Linux.', 'Vibrancy, keyboard and screen reader support come from the system, not from us.', 'The arch is the most ownable mark of the three.'],
    risks: ['Rows cannot wrap. doctor’s fix strings run up to 160 characters today, so each needs a short form of about 44.', 'All four states share one outline; the difference sits inside a 9 px doorway.', 'Native menus dim disabled rows more than this mock shows. Info rows may need to be enabled rows with no action.'],
  },
  b: {
    lede: 'The tray mark is a route from this Mac to the server. The popover draws the same route in full, hop by hop, so a break shows where it is. Reconnecting is a row of dots walking the path.',
    tray: 'Near dot is this Mac, far dot is the server. The line between them is the tunnel. Motion is a line that draws, pulls back, or turns into walking dots.',
    drop: 'A popover with an arrow. The route strip is the centre: solid means reached, dotted means skipped. The failing stop carries doctor’s own detail and fix, and one button.',
    win: 'The route doubles as the setup stepper, then stays on top of Settings as live status.',
    reads: { connected: 'Two solid dots joined by a line', reconnecting: 'Three small dots, far end is a hollow ring', lost: 'Line stops halfway, far end is a cross', blocked: 'Line runs into a wall', idle: 'One solid dot, one hollow ring, no line' },
    moves: { connected: 'Line draws from this Mac to the server, far dot pops in, 600 ms', reconnecting: 'Dots light up in order, near to far, 1.3 s loop', lost: 'Line pulls back, then the cross draws stroke by stroke, 600 ms', blocked: 'Line draws, then a wall rises where the far dot was, 550 ms', idle: 'No motion' },
    strengths: ['Shows which hop failed without opening anything else.', 'Room for the full fix hint and a copy button.', 'One component, the route, is tray mark, status strip and setup stepper.'],
    risks: ['A custom popover window: position, focus, dismissal, keyboard and VoiceOver are ours to build.', 'Linux trays only open menus, so a native menu fallback is still needed.', 'Least legible mark at 16 px: the state lives in the thin middle of the glyph.', 'Closest of the three to a dashboard.'],
  },
  c: {
    lede: 'A tunnel seen head on: a ring with a centre. Each state changes the whole silhouette, and each change has one beat: a ripple when it drops, a turning arc while it retries, a pop when it is back. The dropdown is a small control panel, like the Wi-Fi and Sound menus.',
    tray: 'Solid centre, broken ring, turning arc, no-entry disc. The shapes differ in mass, not in detail, so they hold up at 16 px. Motion is a pulse.',
    drop: 'A frosted panel of tiles. The status tile is the headline; a tinted tile appears only when something needs the user. The rest behaves like menu rows.',
    win: 'No wizard and no tabs: setup is one page of three cards, settings is one page of grouped rows.',
    reads: { connected: 'Ring with a solid centre', reconnecting: 'Open ring, small centre', lost: 'Ring broken in four, empty centre', blocked: 'Solid disc with a bar (no entry)', idle: 'Plain ring' },
    moves: { connected: 'Ring closes, centre pops in, one ripple, 700 ms', reconnecting: 'Arc turns and the centre beats, 1.1 s loop', lost: 'Centre collapses, one ripple, ring breaks in four, 700 ms', blocked: 'Disc grows from the centre, 300 ms', idle: 'No motion' },
    strengths: ['Easiest to read at a glance: each state has its own silhouette.', 'The most visible transitions, and still calm: one beat, then still.', 'Room for cause, fix and a button without drawing a diagram.'],
    risks: ['Least distinctive mark: rings and dots are common in the menu bar, and a solid dot can read as a recording light.', 'Same custom-window cost as B, and the same Linux fallback.', 'Ink buttons ignore the system accent colour.'],
  },
};
const LABEL = { connected: 'Connected', lost: 'Connection lost', reconnecting: 'Reconnecting', blocked: 'Blocked', idle: 'Not set up' };
const SEQ = ['connected', 'lost', 'reconnecting', 'connected', 'blocked'];

function player(c) {
  const bar = (t) => `<div class="barstage t-${t}"><div class="menubar" aria-hidden="true"><span class="mb-app">Terminal</span><span class="mb-sp"></span><span class="mb-tray">${tray(c, 'connected')}</span><span class="mb-clock">9:41</span></div></div>`;
  return `<div class="player" data-player data-seq="${SEQ.join(',')}">
<div class="zooms" aria-hidden="true">${THEMES.map((t) => `<div class="zoom t-${t}">${tray(c, 'connected')}</div>`).join('')}</div>
<div><div class="bars">${THEMES.map(bar).join('')}</div>
<ol class="timeline" aria-label="State sequence">${SEQ.map((s) => `<li>${LABEL[s]}</li>`).join('')}</ol>
<div class="ctl"><button type="button" class="pbtn" data-act="toggle">Play</button><button type="button" class="pbtn" data-act="next">Next state</button><span>Now: <strong data-now>Connected</strong></span></div></div>
</div>`;
}
const PLAYER_JS = `<script>
(function(){var L=${JSON.stringify(LABEL)},H={connected:2400,lost:1700,reconnecting:3400,blocked:2600},still=matchMedia('(prefers-reduced-motion: reduce)').matches;
document.querySelectorAll('[data-player]').forEach(function(p){var seq=p.dataset.seq.split(','),trays=p.querySelectorAll('.tray'),steps=p.querySelectorAll('.timeline li'),btn=p.querySelector('[data-act=toggle]'),now=p.querySelector('[data-now]'),i=0,timer=null,on=false;
function show(n){i=(n+seq.length)%seq.length;trays.forEach(function(t){t.dataset.state=seq[i]});steps.forEach(function(s,k){s.toggleAttribute('data-on',k===i)});now.textContent=L[seq[i]]}
function tick(){timer=setTimeout(function(){show(i+1);tick()},H[seq[i]])}
function play(){on=true;btn.textContent='Pause';tick()}
function pause(){on=false;clearTimeout(timer);btn.textContent='Play'}
btn.addEventListener('click',function(){on?pause():play()});
p.querySelector('[data-act=next]').addEventListener('click',function(){pause();show(i+1)});
show(0);if(!still)play()})})();
</script>`;

const page = ({ title, bodyCls = '', nav, body }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script>try{var t=new URLSearchParams(location.search).get('theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}</script>
<style>${CSS}</style>
</head>
<body class="${bodyCls}">
<div class="wrap">
${nav}
<main>
${body}
</main>
</div>
${PLAYER_JS}
</body>
</html>
`;
const nav = (cur, up) => `<header class="top"><a class="brand" href="${up}index.html">social-tunnel <span>tray app concepts</span></a><nav aria-label="Concepts"><a href="${up}index.html"${cur === 'o' ? ' aria-current="page"' : ''}>Overview</a>${Object.values(CONCEPTS).map((k) => `<a href="${up}concept-${k.key}/index.html"${cur === k.key ? ' aria-current="page"' : ''}>${k.key.toUpperCase()} · ${k.name}</a>`).join('')}</nav></header>`;

function trayTable(c) {
  const T = TXT[c];
  const rows = [['connected', 'Connected'], ['reconnecting', 'Reconnecting'], ['lost', 'Disconnected'], ['blocked', 'Blocked'], ['idle', 'Not set up']];
  return `<div class="tbl-wrap"><table class="tray-tbl"><thead><tr><th scope="col">State</th><th scope="col">Glyph</th><th scope="col">In the menu bar</th><th scope="col">Reads without colour as</th><th scope="col">How it arrives</th><th scope="col">File</th></tr></thead><tbody>${rows.map(([s, name]) => `<tr><th scope="row">${name}</th><td>${THEMES.map((t) => `<span class="sw t-${t}">${tray(c, s, 'is-static')}</span>`).join('')}</td><td>${THEMES.map((t) => `<span class="barchip t-${t}">${tray(c, s, 'is-static')}<span>9:41</span></span>`).join('')}</td><td>${T.reads[s]}</td><td>${T.moves[s]}</td><td><code>tray-${FILE[s] || s}.svg</code></td></tr>`).join('')}</tbody></table></div>
<p class="other-os">Windows and Linux, 16 px, drawn light or dark to match the taskbar: ${THEMES.slice().reverse().map((t) => `<span class="taskbar t-${t}">${['connected', 'reconnecting', 'lost', 'blocked'].map((s) => tray(c, s, 'is-static')).join('')}</span>`).join('')}</p>`;
}

function conceptPage(c) {
  const K = CONCEPTS[c], T = TXT[c];
  const drops = STATE_ORDER.map((key) => `<figure class="fig" id="menu-${key}"><figcaption class="cap"><h3>${STATE_CAPTION[key][0]}</h3><p>${STATE_CAPTION[key][1]}</p></figcaption>${pair((t) => dropStage(c, key, t))}</figure>`).join('\n');
  // windows(c) builds unique ids per call, so call once per theme.
  const wl = windows(c), wd = windows(c);
  const wins = wl.map((w, i) => `<figure class="fig wide" id="win-${w[0]}"><figcaption class="cap"><h3>${w[1]}</h3><p>${w[2]}</p></figcaption><div class="pair">${winStage(w[3], 'light')}${winStage(wd[i][3], 'dark')}</div></figure>`).join('\n');
  const body = `<h1>${c.toUpperCase()} · ${K.name}</h1>
<p class="lede">${T.lede}</p>
<ul class="facts"><li><b>Tray mark</b>${T.reads.connected}, ${T.reads.lost.toLowerCase()}</li><li><b>Motion</b>${{ a: 'Fill, drain, sweep', b: 'Draw, pull back, walking dots', c: 'Pop, ripple, turning arc' }[c]}</li><li><b>Dropdown</b>${K.dropdown}</li><li><b>Windows</b>${{ a: 'Assistant and tabs', b: 'Route stepper and tabs', c: 'One page each' }[c]}</li></ul>

<section id="tray"><h2>Tray icon and state changes</h2><p>${T.tray} Each change plays once and then holds still; only Reconnecting loops. With Reduce Motion on, states swap with no animation and Reconnecting shows its still frame.</p>
${player(c)}
${trayTable(c)}</section>

<section id="dropdown"><h2>Dropdown in every state</h2><p>${T.drop} The blur is real: <code>backdrop-filter</code> over a wallpaper and a terminal window.</p>
${drops}</section>

<section id="windows"><h2>Setup and settings</h2><p>${T.win} No field ever asks for a social platform password or code, and the private key is never shown.</p>
${wins}</section>

<section id="notes"><h2>Strengths and risks</h2><p>Compare with the other two on the <a href="../index.html#compare">overview</a>.</p>
<div class="two"><div><h3>Strengths</h3><ul>${T.strengths.map((x) => `<li>${x}</li>`).join('')}</ul></div><div><h3>Risks</h3><ul>${T.risks.map((x) => `<li>${x}</li>`).join('')}</ul></div></div></section>`;
  return page({ title: `${c.toUpperCase()} · ${K.name} · social-tunnel tray concept`, bodyCls: K.cls, nav: nav(c, '../'), body });
}

function overview() {
  const col = (c) => {
    const K = CONCEPTS[c], T = TXT[c]; const w = windows(c);
    const pick = { a: 1, b: 3, c: 3 }[c];
    return `<article class="col ${K.cls}"><h2>${c.toUpperCase()} · ${K.name}</h2><p class="tagline">${T.lede}</p>
${player(c)}
<h3>Connected, light</h3>${dropStage(c, 'connected', 'light')}
<h3>Disconnected, dark</h3>${dropStage(c, 'lost', 'dark')}
<h3>${w[pick][1]}</h3>${winStage(w[pick][3], c === 'b' ? 'dark' : 'light')}
<a class="open-link" href="concept-${c}/index.html">Open concept ${c.toUpperCase()}</a></article>`;
  };
  const row = (h, f) => `<tr><th scope="row">${h}</th>${['a', 'b', 'c'].map((c) => `<td>${f(c)}</td>`).join('')}</tr>`;
  const ul = (a) => `<ul style="margin:0;padding-left:16px">${a.map((x) => `<li>${x}</li>`).join('')}</ul>`;
  const body = `<h1>Three concepts for the social-tunnel tray app</h1>
<p class="lede">Same product, same words, same states. What changes is the tray mark and its motion, the kind of dropdown, and how setup and settings are laid out. All three are native macOS in feel, with frosted glass over the desktop. Press Play under each mark to watch connected, lost, reconnecting, connected, blocked.</p>
<div class="cols">${['a', 'b', 'c'].map(col).join('\n')}</div>

<section id="compare"><h2>Compare</h2><p>The state to compare first is Disconnected: it is where the three differ most.</p>
<div class="tbl-wrap"><table><thead><tr><th scope="col"></th>${['a', 'b', 'c'].map((c) => `<th scope="col">${c.toUpperCase()} · ${CONCEPTS[c].name}</th>`).join('')}</tr></thead><tbody>
${row('Direction', (c) => ({ a: 'Quiet native. SF Symbols habits, system menu.', b: 'Shows the path. The route is the whole interface.', c: 'Read at a glance. One silhouette per state.' }[c]))}
${row('Tray mark', (c) => `<span class="${CONCEPTS[c].cls}">${['connected', 'reconnecting', 'lost', 'blocked'].map((s) => `<span class="sw t-light" style="width:38px;height:38px;border-radius:9px;margin:0 4px 0 0">${tray(c, s, 'is-static')}</span>`).join('')}</span>`.replace(/class="tray is-static"/g, 'class="tray is-static" style="width:24px;height:24px"'))}
${row('Motion', (c) => ({ a: 'Fill, drain, sweep', b: 'Draw, pull back, walking dots', c: 'Pop, ripple, turning arc' }[c]))}
${row('Dropdown', (c) => ({ a: 'Native menu. One line per row.', b: 'Popover with the hop route.', c: 'Panel of tiles plus menu rows.' }[c]))}
${row('Setup and settings', (c) => ({ a: 'Three-step assistant, tabbed settings', b: 'Route as stepper, route on top of tabs', c: 'One page of cards, one page of rows' }[c]))}
${row('Strengths', (c) => ul(TXT[c].strengths))}
${row('Risks', (c) => ul(TXT[c].risks))}
</tbody></table></div></section>

<section id="pick"><h2>Recommendation</h2><p>One concept to build, one thing to borrow.</p>
<div class="pick">__PICK__</div></section>`;
  return page({ title: 'social-tunnel tray app: three concepts', nav: nav('o', ''), body });
}

mkdirSync(OUT, { recursive: true });
for (const c of ['a', 'b', 'c']) {
  const dir = `${OUT}/concept-${c}`; mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/index.html`, conceptPage(c));
  for (const s of ['idle', 'connected', 'reconnecting', 'lost', 'blocked']) writeFileSync(`${dir}/tray-${FILE[s] || s}.svg`, staticSvg(c, s));
  writeFileSync(`${dir}/tray-reconnecting-animated.svg`, animatedSvg(c));
}
writeFileSync(`${OUT}/index.html`, overview().replace('__PICK__', PICK));
console.log('built', OUT);
