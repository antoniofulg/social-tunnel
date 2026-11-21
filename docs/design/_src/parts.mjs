// Dropdowns, windows and stages. Every function returns static HTML for one theme.
import { D, uid, tray, stat } from './lib.mjs';

const nDom = D.domains.length;
const PAUSED = `${nDom} domains paused. Nothing goes direct.`;
// doctor's own fix strings (src/doctor.ts), shown word for word where there is room.
const FIX_SERVER = 'Check server.host and server.port, that the server is up, and that its firewall allows SSH.';
const FIX_PORT = `Free port ${D.port} on the server and allow it for the tunnel key: permitlisten="127.0.0.1:${D.port}".`;
const FIX_KEY = 'Do not connect until you know why. Compare the server’s fingerprint over a channel you trust, then update server.hostKey only if the server was really re-keyed.';

// One source of truth for what each state says. Used by all three dropdowns.
// json = [state, reason, retryAt] of `social-tunnel status --json`; cause and fix follow doctor's detail and fix;
// short = the two one-line rows a native menu has room for.
export const S = {
  idle: { g: 'idle', tone: 'off', json: null, title: 'Not set up', sub: 'Nothing is routed yet.' },
  connected: { g: 'connected', tone: 'ok', json: ['connected', null, null], title: 'Connected', sub: `Home IP ${D.ip}`, domains: true, hops: ['ok', 'ok', 'ok', 'ok'] },
  reconnecting: { g: 'reconnecting', tone: 'busy', json: ['reconnecting', 'connection_lost', '2026-11-21T09:41:08Z'], title: 'Reconnecting…', sub: 'Next try in 8 s.', paused: true, hops: ['ok', 'busy', 'off', 'off'] },
  lost: { g: 'lost', tone: 'down', json: ['disconnected', 'connection_lost', '2026-11-21T09:41:30Z'], title: 'Disconnected', hop: 'Server', cause: `No TCP connection to ${D.host}:${D.sshPort}.`, fix: FIX_SERVER, short: [`Server: no connection to ${D.host}:${D.sshPort}`, 'Fix: check the server is up and allows SSH'], paused: true, urgent: true, hops: ['ok', 'down', 'off', 'off'] },
  blockedPort: { g: 'blocked', tone: 'warn', json: ['blocked', 'port_blocked', '2026-11-21T09:41:30Z'], title: 'Blocked at the server', hop: 'Tunnel port', cause: `The server refused a remote forward on 127.0.0.1:${D.port}.`, fix: FIX_PORT, short: [`Tunnel port: the server refused port ${D.port}`, `Fix: free port ${D.port}, allow it for the key`], action: 'Copy Fix', paused: true, hops: ['ok', 'ok', 'warn', 'off'] },
  blockedKey: { g: 'blocked', tone: 'down', json: ['blocked', 'host_key_mismatch', null], title: 'Server key changed', hop: 'Server', cause: 'The server’s host key does not match the one saved at setup.', fix: FIX_KEY, short: ['Server: host key does not match the saved one', 'Fix: do not connect until you know why'], action: 'Review Server Key…', paused: true, hops: ['ok', 'down', 'off', 'off'], words: { 1: 'Key changed' } },
  blockedDomain: { g: 'blocked', tone: 'warn', json: ['connected', null, null], title: 'Domain refused', hop: 'Domains', cause: 'cdninstagram.com is not on the allowlist.', fix: 'Add it only if it should use home internet.', short: ['Domains: cdninstagram.com is not on the list', 'Fix: add it only if it should use home'], action: 'Add cdninstagram.com…', sub: `Home IP ${D.ip}`, hops: ['ok', 'ok', 'ok', 'warn'] },
};
export const STATE_ORDER = ['connected', 'reconnecting', 'lost', 'blockedPort', 'blockedKey', 'blockedDomain', 'idle'];
export const STATE_CAPTION = {
  connected: ['Connected', 'Tunnel up. The status row, the home IP and the list are all there is.'],
  reconnecting: ['Reconnecting', 'The tunnel retries by itself (after 1, 2, 4, 8, 16 s, then every 30 s). Neutral tone, no alarm colour. The list folds to one line that states the fail-closed rule.'],
  lost: ['Disconnected', 'Retries are not helping. Shows the failing doctor check with its detail and fix. Reconnect becomes the main action.'],
  blockedPort: ['Blocked: tunnel port', 'The server answers but refuses the tunnel port. The fix happens on the server, so the action copies it.'],
  blockedKey: ['Blocked: server key changed', 'The server’s key no longer matches the one pinned at setup. Red tone, and no one-click trust: the only action opens both fingerprints side by side.'],
  blockedDomain: ['Blocked: domain refused', 'A host that is not on the allowlist. Adding it is always a deliberate step, never automatic.'],
  idle: ['Not set up', 'First run. One action.'],
};

// The dropdown groups doctor's checks into four stops. Settings lists every check.
const HOPS = ['This Mac', 'Server', 'Tunnel port', 'Domains'];
const HOPWORD = { ok: 'OK', busy: 'Trying', down: 'No answer', warn: 'Refused', off: 'Skipped' };
const DOCTOR = ['Config file', 'Tunnel key', 'Server reachable', 'SSH sign-in', 'Tunnel port', 'Lock-down', 'Internet from this Mac'];
const mark = (tone) => `<span class="tone-${tone}">${stat(tone)}</span>`;
const animated = (s) => (s.g === 'reconnecting' ? '' : 'is-static');

// ---------- Route / hop strip (concept B signature, reused as stepper) ----------
export function route(hops, words = {}, label = 'Doctor checks, from this Mac outward', names = HOPS) {
  return `<ol class="route" aria-label="${label}">${hops.map((t, i) => {
    const seg = i === 0 ? '' : (t === 'ok' || t === 'warn') ? ' seg-ok' : t === 'busy' ? ' seg-busy' : ' seg-off';
    return `<li class="hop${seg}">${mark(t)}<span class="hop-name">${names[i]}</span><span class="hop-word">${words[i] || HOPWORD[t]}</span></li>`;
  }).join('')}</ol>`;
}
const doctorList = (failAt, tone = 'warn') => `<ul class="hoplist" aria-label="Doctor checks">${DOCTOR.map((name, i) => { const t = i < failAt ? 'ok' : i === failAt ? tone : 'off'; return `<li>${mark(t)}<span>${name}</span><span class="hop-word">${{ ok: 'OK', warn: 'Failed', down: 'Failed', off: 'Skipped' }[t]}</span></li>`; }).join('')}</ul>`;

// ---------- A · native menu ----------
function menuA(key) {
  const s = S[key]; const row = (cls, html, ic = '') => `<li class="mi ${cls}"><span class="ic">${ic}</span>${html}</li>`;
  const sep = '<li class="sep" aria-hidden="true"></li>';
  let h = row('head', `<span>${s.title}</span>`, `<span class="tone-${s.tone}">${tray('a', s.g, animated(s))}</span>`);
  if (key === 'idle') return `<div class="menu material"><ul>${h}${row('info', s.sub)}${sep}${row('is-hover', 'Set Up…')}${sep}${row('', 'Quit social-tunnel<kbd>⌘Q</kbd>')}</ul></div>`;
  if (s.hop) h += row('info', s.short[0]) + row('info', s.short[1]);
  if (s.sub) h += row('info', s.sub);
  if (s.paused) h += row('info', PAUSED);
  h += sep;
  if (s.domains) h += row('label', 'Through home') + D.domains.map((d) => row('dom', d)).join('') + row('', 'Edit Domains…') + sep;
  if (s.action) h += row('', s.action);
  h += row(s.urgent ? 'is-hover' : '', 'Reconnect') + row('', 'Logs') + row('', 'Settings…<kbd>⌘,</kbd>') + sep + row('', 'Quit social-tunnel<kbd>⌘Q</kbd>');
  return `<div class="menu material"><ul>${h}</ul></div>`;
}

// ---------- B · popover with the route ----------
function issue(s, btnCls = 'btn sm') {
  if (!s.hop) return '';
  return `<div class="issue is-${s.tone}"><p class="issue-what"><strong>${s.hop}.</strong> ${s.cause}</p><p class="issue-fix">${s.fix}</p>${s.action ? `<button type="button" class="${btnCls}">${s.action}</button>` : ''}</div>`;
}
function popB(key) {
  const s = S[key];
  const head = `<div class="pop-head"><span class="tone-${s.tone}">${tray('b', s.g, `big ${animated(s)}`)}</span><div><div class="pop-title">${s.title}</div>${s.sub ? `<div class="pop-sub">${s.sub}</div>` : ''}</div></div>`;
  if (key === 'idle') return `<div class="pop material">${head}<div class="pop-foot"><button type="button" class="btn primary">Set Up…</button><span class="sp"></span><button type="button" class="link">Quit</button></div></div>`;
  const doms = s.paused ? `<p class="paused">${PAUSED}</p>` : `<div class="sec-label">Through home</div><ul class="chips">${D.domains.map((d) => `<li>${d}</li>`).join('')}</ul>`;
  return `<div class="pop material">${head}${route(s.hops, s.words)}${issue(s)}${doms}<div class="pop-foot"><button type="button" class="btn ${s.urgent ? 'primary' : ''}">Reconnect</button><span class="sp"></span><button type="button" class="link">Logs</button><button type="button" class="link">Settings…</button><button type="button" class="link">Quit</button></div></div>`;
}

// ---------- C · control panel ----------
function panelC(key) {
  const s = S[key];
  const status = `<div class="tile status"><span class="chip chip-${s.tone}">${tray('c', s.g, animated(s))}</span><div><div class="st-title">${s.title}</div>${s.sub ? `<div class="st-sub">${s.sub}</div>` : ''}</div></div>`;
  const rows = (items) => `<ul class="rows">${items.map((i) => `<li class="row${i[1] ? ' ' + i[1] : ''}">${i[0]}</li>`).join('')}</ul>`;
  if (key === 'idle') return `<div class="panel material">${status}${rows([['Set Up…', 'is-hover'], ['Quit social-tunnel<kbd>⌘Q</kbd>']])}</div>`;
  const doms = s.paused ? `<div class="tile"><p class="paused">${PAUSED}</p></div>` : `<div class="tile"><div class="sec-label">Through home</div><ul class="doms">${D.domains.map((d) => `<li>${d}</li>`).join('')}</ul></div>`;
  const iss = s.hop ? `<div class="tile tint is-${s.tone}">${issue(s, 'btn sm')}</div>` : '';
  return `<div class="panel material">${status}${iss}${doms}${rows([['Reconnect', s.urgent ? 'is-hover' : ''], ['Logs'], ['Settings…<kbd>⌘,</kbd>'], ['Quit social-tunnel<kbd>⌘Q</kbd>', 'top-line']])}</div>`;
}
export const dropdown = (c, key) => ({ a: menuA, b: popB, c: panelC }[c])(key);

// ---------- Menu bar + stage ----------
const WIFI = '<svg class="mb-g" viewBox="0 0 18 14" aria-hidden="true"><path d="M2 5.2a10 10 0 0 1 14 0M4.6 7.9a6.3 6.3 0 0 1 8.8 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="9" cy="11" r="1.5" fill="currentColor"/></svg>';
const BATT = '<svg class="mb-g" viewBox="0 0 26 14" aria-hidden="true" style="width:24px"><rect x="1" y="2" width="21" height="10" rx="3" fill="none" stroke="currentColor" stroke-opacity=".55"/><rect x="2.6" y="3.6" width="14" height="6.8" rx="1.6" fill="currentColor"/><path d="M23.6 5.3v3.4" stroke="currentColor" stroke-opacity=".55" stroke-width="1.6" stroke-linecap="round"/></svg>';
export function menubar(c, state, open = true) {
  return `<div class="menubar" aria-hidden="true"><span class="mb-app">Terminal</span><span class="mb-item">Shell</span><span class="mb-item">Edit</span><span class="mb-item">View</span><span class="mb-sp"></span>${WIFI}${BATT}<span class="mb-tray${open ? ' is-open' : ''}">${tray(c, state, state === 'reconnecting' ? '' : 'is-static')}</span><span class="mb-clock">Sat 21 Nov&nbsp; 9:41</span></div>`;
}
// Background terminal: the CLI output the dropdown is drawn from (shape of src/cli.ts status --json).
const terminal = (s) => `<div class="term" aria-hidden="true"><div class="term-bar"><i></i><i></i><i></i></div><pre>$ social-tunnel status --json
${s.json ? `{
  "ok": ${s.json[0] === 'connected'},
  "command": "status",
  "state": "${s.json[0]}",
  "reason": ${s.json[1] ? `"${s.json[1]}"` : 'null'},
  "since": "2026-11-21T09:40:52Z",
  "retryAt": ${s.json[2] ? `"${s.json[2]}"` : 'null'},
  "pid": ${s.json[1] === 'host_key_mismatch' ? 'null' : 4127},
  "remotePort": ${D.port},
  "domains": ${nDom}
}` : `{
  "ok": false,
  "command": "status",
  "error": {
    "code": "config_invalid",
    "message": "no config file"
  }
}`}
$ ▍</pre></div>`;
export function dropStage(c, key, theme) {
  const s = S[key];
  return `<div class="stage t-${theme}" role="group" aria-label="${theme === 'light' ? 'Light' : 'Dark'} theme, ${s.title}"><span class="stage-tag">${theme === 'light' ? 'Light' : 'Dark'}</span>${terminal(s)}${menubar(c, s.g)}<div class="drop">${dropdown(c, key)}</div></div>`;
}
export const winStage = (html, theme) => `<div class="stage win-stage t-${theme}" role="group" aria-label="${theme === 'light' ? 'Light' : 'Dark'} theme"><span class="stage-tag">${theme === 'light' ? 'Light' : 'Dark'}</span>${html}</div>`;

// ---------- Window fragments ----------
const win = (title, body, foot = '', cls = '') => `<div class="win ${cls}"><div class="titlebar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="ttl">${title}</span></div>${body}${foot ? `<div class="win-foot">${foot}</div>` : ''}</div>`;
const fp = (v) => `<code class="fp">${v}</code>`;

function serverForm(error) {
  const u = uid('f');
  return `<div class="form">
<label for="${u}h">Server</label><input id="${u}h" class="inp mono" type="text" value="${D.host}" autocomplete="off" spellcheck="false">
<label for="${u}p">SSH port</label><input id="${u}p" class="inp mono short" type="text" inputmode="numeric" value="${D.sshPort}">
<label for="${u}u">Admin user</label><input id="${u}u" class="inp mono" type="text" value="${D.admin}" autocomplete="username" spellcheck="false" aria-describedby="${u}uh">
<p class="hint" id="${u}uh">Signs in with your SSH agent or default key.</p>
</div>${error
    ? `<div class="alert is-down" role="alert">${mark('down')}<div><strong>Can’t sign in as ${D.admin}.</strong><p>The server refused your SSH key. Add the key to your agent with <code>ssh-add</code>, or use another admin user.</p></div></div>`
    : `<div class="alert is-ok" role="status">${mark('ok')}<div><strong>Signed in as ${D.admin}.</strong><p>Server key ${fp(D.hostFp)}</p><p>Check it matches your server before you continue.</p></div></div>`}`;
}
const keySteps = () => `<ol class="steps">
<li>${mark('ok')}<div><strong>Key created on this Mac</strong><p>It stays here, readable only by you. Fingerprint ${fp(D.keyFp)}</p></div></li>
<li>${mark('ok')}<div><strong>Tunnel user added</strong><p><code>${D.tunnelUser}</code>, no shell. It may open 127.0.0.1:${D.port} and nothing else.</p></div></li>
<li aria-current="step">${mark('busy')}<div><strong>Setting the server browser’s rule…</strong><p>Only your domains will use the tunnel.</p></div></li>
<li class="todo">${mark('off')}<div><strong>Test the tunnel and its lock-down</strong></div></li>
</ol>`;
function portField(disabled) {
  const u = uid('f');
  return `<div class="form"><label for="${u}">Server port</label><input id="${u}" class="inp mono short" type="text" inputmode="numeric" value="${D.port}"${disabled ? ' disabled' : ''} aria-describedby="${u}h"><p class="hint" id="${u}h">Opened on the server’s loopback only.</p></div>`;
}
function addDomain({ value = '', invalid = false, suggest = false } = {}) {
  const u = uid('f');
  return `<div class="add"><label for="${u}">Add domain</label><div class="add-row"><input id="${u}" class="inp" type="text" inputmode="url" autocomplete="off" spellcheck="false" value="${value}"${invalid ? ` aria-invalid="true" aria-describedby="${u}e"` : ' placeholder="example.com"'}><button type="button" class="btn">Add</button></div>${invalid ? `<p class="err" id="${u}e">${mark('down')}<span>Local and private addresses can’t be added. Use a public domain, like example.com.</span></p>` : ''}${suggest ? `<div class="suggest"><span>Common</span>${['linkedin.com', 'x.com', 'tiktok.com'].map((d) => `<button type="button" class="btn sm">Add ${d}</button>`).join('')}</div>` : ''}</div>`;
}
const domList = (list = D.domains) => `<ul class="list" aria-label="Domains that use home internet">${list.map((d) => `<li><span>${d}</span><button type="button" class="btn sm quiet" aria-label="Remove ${d}">Remove</button></li>`).join('')}</ul>`;
const domChips = (list = D.domains) => `<ul class="chips big" aria-label="Domains that use home internet">${list.map((d) => `<li><span>${d}</span><button type="button" class="x" aria-label="Remove ${d}"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></li>`).join('')}</ul>`;
function check(label, checked = true) { const u = uid('f'); return `<div class="check"><input id="${u}" type="checkbox"${checked ? ' checked' : ''}><label for="${u}">${label}</label></div>`; }
const sw = (label, on = true) => `<button type="button" class="switch" role="switch" aria-checked="${on}" aria-label="${label}"><i></i></button>`;
const YOU = '<p class="note">You sign in to each site yourself in the server’s browser. social-tunnel never sees passwords or codes.</p>';
const tabs = (items, cur) => `<div class="seg" role="tablist" aria-label="Settings sections">${items.map((t) => `<button type="button" role="tab" aria-selected="${t === cur}" tabindex="${t === cur ? 0 : -1}">${t}</button>`).join('')}</div>`;
const logView = () => `<div class="seg sm" role="group" aria-label="Show">${['All', 'Tunnel', 'Proxy'].map((t, i) => `<button type="button" aria-pressed="${i === 0}">${t}</button>`).join('')}</div>
<pre class="log" role="log" tabindex="0" aria-label="Recent log lines">09:41:02 tunnel  connected to ${D.host}:${D.sshPort}
09:41:02 tunnel  listening on server 127.0.0.1:${D.port}
09:41:07 proxy   allow   instagram.com:443
09:41:07 proxy   allow   facebook.com:443
09:41:09 proxy   refuse  cdninstagram.com:443 (not on list)
09:52:30 tunnel  keepalive timed out
09:52:30 tunnel  reconnecting, attempt 1
09:52:41 tunnel  connected to ${D.host}:${D.sshPort}
09:52:44 proxy   allow   linkedin.com:443
09:58:13 proxy   refuse  192.168.1.1:80 (private address)</pre>`;
const logFoot = '<span class="hint">Keys, passwords and cookies are never logged.</span><span class="sp"></span><button type="button" class="btn">Copy</button><button type="button" class="btn">Show in Finder</button>';
const stepHead = (n, title, desc) => `<p class="step-count">Step ${n} of 3</p><h3 class="step-title">${title}</h3><p class="step-desc">${desc}</p>`;
const T_SERVER = ['Connect to your server', 'Used once to add a locked-down tunnel user. Your login is not saved.'];
const T_KEY = ['Create the tunnel key', 'A new key just for the tunnel. It never leaves this Mac.'];
const T_DOM = ['Choose domains', 'Only these use your home internet. Everything else goes out from the server.'];
const serverSummary = () => `<dl class="kv"><dt>Server</dt><dd><code>${D.host}:${D.sshPort}</code></dd><dt>Tunnel user</dt><dd><code>${D.tunnelUser}</code>, port ${D.port} only</dd><dt>Key</dt><dd>${fp(D.keyFp)}</dd></dl>`;
const portAlert = () => `<div class="alert is-warn" role="status">${mark('warn')}<div><strong>${S.blockedPort.cause}</strong><p>${FIX_PORT}</p><div class="row-end" style="justify-content:flex-start;margin-top:8px"><button type="button" class="btn sm">Copy Fix</button></div></div></div>`;

// ---------- Windows per concept: [id, caption title, caption text, html] ----------
export function windows(c) {
  if (c === 'a') return [
    ['setup-server', 'Setup 1: server', 'Three short steps in one window. This one shows a good connection test, with the server key to compare.',
      win('Set Up social-tunnel', `<div class="win-body">${stepHead(1, ...T_SERVER)}${serverForm(false)}</div>`, '<button type="button" class="btn">Test Again</button><span class="sp"></span><button type="button" class="btn primary">Continue</button>')],
    ['setup-key', 'Setup 2: tunnel key (running)', 'Each line says what is being changed, so nothing happens on the server without the user reading it. The private key is never shown, only its fingerprint.',
      win('Set Up social-tunnel', `<div class="win-body">${stepHead(2, ...T_KEY)}${portField(true)}${keySteps()}</div>`, '<button type="button" class="btn" aria-disabled="true">Back</button><span class="sp"></span><button type="button" class="btn primary" aria-disabled="true">Setting Up…</button>')],
    ['setup-domains', 'Setup 3: domains', 'The allowlist, start at login, and the reminder that logins stay with the user.',
      win('Set Up social-tunnel', `<div class="win-body">${stepHead(3, ...T_DOM)}${addDomain({ suggest: true })}${domList(D.domains.slice(0, 3))}${check('Start at login')}${YOU}</div>`, '<button type="button" class="btn">Back</button><span class="sp"></span><button type="button" class="btn primary">Connect</button>')],
    ['settings-domains', 'Settings: Domains (invalid entry)', 'Classic tabbed settings. The error state shows the allowlist rule in the user’s words.',
      win('social-tunnel Settings', `<div class="win-tabs">${tabs(['Domains', 'General', 'Logs'], 'Domains')}</div><div class="win-body">${addDomain({ value: '192.168.1.10', invalid: true })}${domList()}<p class="hint">Saved on this Mac and on the server together.</p></div>`)],
    ['settings-general', 'Settings: General (tunnel port refused)', 'The full doctor result lives here: every check, the fix text word for word, and a copy button. The menu only has room for one line.',
      win('social-tunnel Settings', `<div class="win-tabs">${tabs(['Domains', 'General', 'Logs'], 'General')}</div><div class="win-body"><h4 class="group">Connection</h4>${doctorList(4)}${portAlert()}<div class="row-end"><button type="button" class="btn">Check Again</button></div><h4 class="group">Startup</h4>${check('Start at login')}<h4 class="group">Server</h4>${serverSummary()}<div class="row-end"><button type="button" class="btn">Run Setup Again…</button></div></div>`)],
    ['settings-logs', 'Settings: Logs', 'The menu’s Logs item opens this tab.',
      win('social-tunnel Settings', `<div class="win-tabs">${tabs(['Domains', 'General', 'Logs'], 'Logs')}</div><div class="win-body">${logView()}</div>`, logFoot)],
  ];
  const stepper = (st) => route(st, { 0: st[0] === 'ok' ? 'Done' : st[0] === 'down' ? 'Fix this' : 'Now', 1: st[1] === 'ok' ? 'Done' : st[1] === 'busy' ? 'Now' : 'Next', 2: st[2] === 'ok' ? 'Done' : st[2] === 'busy' ? 'Now' : 'Next', 3: 'Last' }, 'Setup steps', ['Server', 'Tunnel key', 'Domains', 'Connected']);
  if (c === 'b') return [
    ['setup-server', 'Setup: server (sign-in failed)', 'The route is the stepper: each stop is a setup step, then it becomes the live status strip. This frame shows the error state.',
      win('Set Up social-tunnel', `<div class="win-route">${stepper(['down', 'off', 'off', 'off'])}</div><div class="win-body"><h3 class="step-title">${T_SERVER[0]}</h3><p class="step-desc">${T_SERVER[1]}</p>${serverForm(true)}</div>`, '<button type="button" class="btn">Test Again</button><span class="sp"></span><button type="button" class="btn primary" aria-disabled="true">Continue</button>')],
    ['setup-key', 'Setup: tunnel key (running)', 'Same content as the other concepts; the stepper shows where setup is.',
      win('Set Up social-tunnel', `<div class="win-route">${stepper(['ok', 'busy', 'off', 'off'])}</div><div class="win-body"><h3 class="step-title">${T_KEY[0]}</h3><p class="step-desc">${T_KEY[1]}</p>${portField(true)}${keySteps()}</div>`, '<button type="button" class="btn" aria-disabled="true">Back</button><span class="sp"></span><button type="button" class="btn primary" aria-disabled="true">Setting Up…</button>')],
    ['setup-domains', 'Setup: domains', 'Domains as removable chips.',
      win('Set Up social-tunnel', `<div class="win-route">${stepper(['ok', 'ok', 'busy', 'off'])}</div><div class="win-body"><h3 class="step-title">${T_DOM[0]}</h3><p class="step-desc">${T_DOM[1]}</p>${addDomain({ suggest: true })}${domChips(D.domains.slice(0, 3))}${check('Start at login')}${YOU}</div>`, '<button type="button" class="btn">Back</button><span class="sp"></span><button type="button" class="btn primary">Connect</button>')],
    ['settings-domains', 'Settings: Domains', 'The live route stays on top of every tab. Start at login sits in the footer so it is always one click away.',
      win('social-tunnel', `<div class="win-route">${route(S.connected.hops)}<div class="route-sum"><span>All checks OK. Home IP ${D.ip}</span><button type="button" class="btn sm">Check Again</button></div></div><div class="win-tabs">${tabs(['Domains', 'Server', 'Logs'], 'Domains')}</div><div class="win-body">${addDomain()}${domChips()}<p class="hint">Saved on this Mac and on the server together.</p></div>`, `${check('Start at login')}`)],
    ['settings-logs', 'Settings: Logs', 'Logs under the same route header.',
      win('social-tunnel', `<div class="win-route">${route(S.connected.hops)}<div class="route-sum"><span>All checks OK. Home IP ${D.ip}</span><button type="button" class="btn sm">Check Again</button></div></div><div class="win-tabs">${tabs(['Domains', 'Server', 'Logs'], 'Logs')}</div><div class="win-body">${logView()}</div>`, logFoot)],
  ];
  const card = (n, title, state, body, summary = '') => `<section class="card ${state}"><h3><span class="num">${state === 'done' ? stat('ok') : n}</span>${title}${state === 'done' ? '<button type="button" class="btn sm quiet">Edit</button>' : ''}</h3>${state === 'open' ? body : summary ? `<p class="sum">${summary}</p>` : ''}</section>`;
  const group = (title, rows) => `<h4 class="group">${title}</h4><ul class="inset">${rows.map((r) => `<li>${r}</li>`).join('')}</ul>`;
  return [
    ['setup-server', 'Setup: one page, server open', 'No wizard. Three cards on one page; the next card opens when the one above is done.',
      win('Set Up social-tunnel', `<div class="win-body">${card(1, 'Server', 'open', `<p class="step-desc">${T_SERVER[1]}</p>${serverForm(false)}<div class="row-end"><button type="button" class="btn">Test Again</button><button type="button" class="btn primary">Continue</button></div>`)}${card(2, 'Tunnel key', 'next', '', 'A new key just for the tunnel. Made in the next step.')}${card(3, 'Domains', 'next', '', 'Choose which sites use your home internet.')}</div>`)],
    ['setup-key', 'Setup: tunnel key running', 'Finished cards fold to one line with Edit.',
      win('Set Up social-tunnel', `<div class="win-body">${card(1, 'Server', 'done', '', `<code>${D.admin}@${D.host}:${D.sshPort}</code>`)}${card(2, 'Tunnel key', 'open', `<p class="step-desc">${T_KEY[1]}</p>${keySteps()}`)}${card(3, 'Domains', 'next', '', 'Choose which sites use your home internet.')}</div>`)],
    ['setup-domains', 'Setup: domains', 'Last card, then Connect.',
      win('Set Up social-tunnel', `<div class="win-body">${card(1, 'Server', 'done', '', `<code>${D.admin}@${D.host}:${D.sshPort}</code>`)}${card(2, 'Tunnel key', 'done', '', `Key ${fp(D.keyFp)}`)}${card(3, 'Domains', 'open', `<p class="step-desc">${T_DOM[1]}</p>${addDomain({ suggest: true })}${domList(D.domains.slice(0, 3))}${YOU}<div class="row-end"><button type="button" class="btn primary">Connect</button></div>`)}</div>`)],
    ['settings', 'Settings: one page', 'Grouped rows like System Settings. Start at login is a switch. Logs open from the last row.',
      win('social-tunnel', `<div class="win-body">${group('Domains', [...D.domains.map((d) => `<span>${d}</span><button type="button" class="btn sm quiet" aria-label="Remove ${d}">Remove</button>`), addDomain().replace('class="add"', 'class="add inline"')])}${group('General', [`<span>Start at login</span>${sw('Start at login')}`, `<span>Server</span><code>${D.host}:${D.sshPort}</code>`, `<span>Tunnel key</span>${fp(D.keyFp)}`, '<span>Change server or key</span><button type="button" class="btn sm">Run Setup Again…</button>'])}${group('Connection', [`<span class="with-mark">${mark('ok')}All checks OK. Home IP ${D.ip}</span><button type="button" class="btn sm">Check Again</button>`, '<span>Logs</span><button type="button" class="btn sm">Show Logs</button>'])}</div>`)],
    ['settings-logs', 'Settings: Logs', 'Logs replace the page, with a way back.',
      win('social-tunnel', `<div class="win-body"><div class="back-row"><button type="button" class="btn sm quiet"><svg viewBox="0 0 8 12" aria-hidden="true"><path d="M6.5 1.5L2 6l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>Settings</button><h3 class="step-title">Logs</h3></div>${logView()}</div>`, logFoot)],
  ];
}
