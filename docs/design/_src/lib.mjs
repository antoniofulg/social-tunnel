// Shared helpers, data, tray glyphs and CSS for the social-tunnel concept pages.
let n = 0;
export const uid = (p = 'u') => `${p}${++n}`;
export const r2 = (v) => Math.round(v * 100) / 100;

export const D = {
  host: 'vps.example.com', sshPort: 22, admin: 'root', port: 8888, ip: '203.0.113.42',
  tunnelUser: 'social-tunnel',
  domains: ['instagram.com', 'facebook.com', 'threads.net', 'linkedin.com'],
  keyFp: 'SHA256:8fK2mQ7vXc1Rt5YhLp9WzJ3nBd6Ga0Es4Uo2TiNfM1k',
  hostFp: 'SHA256:Jq4vT0x9mYb2Rk7LwPz3Ue8NcHs5AdG1FoXi6VtKyM0',
  cmd: 'agentes-runner services allow tcp/8888',
};

export const CONCEPTS = {
  a: { key: 'a', cls: 'cA', name: 'Portal', tag: 'Quiet native', dropdown: 'Native menu' },
  b: { key: 'b', cls: 'cB', name: 'Route', tag: 'Shows the path', dropdown: 'Popover' },
  c: { key: 'c', cls: 'cC', name: 'Beacon', tag: 'Read at a glance', dropdown: 'Control panel' },
};

// ---------- Tray glyphs (18 x 18, one SVG holds every layer; data-state picks) ----------
const ARCH = 'M3.5 14.6V9a5.5 5.5 0 0 1 11 0v5.6';
const SLASH = 'M3.2 3.4l11.6 12';

// Route curve for concept B.
const P = [[4, 5], [10.5, 5], [7.5, 13], [14, 13]];
const bz = (t) => { const u = 1 - t; return [0, 1].map((k) => u * u * u * P[0][k] + 3 * u * u * t * P[1][k] + 3 * u * t * t * P[2][k] + t * t * t * P[3][k]); };
const N = 800; const pts = [...Array(N + 1)].map((_, i) => bz(i / N));
const LEN = [0]; for (let i = 1; i <= N; i++) LEN.push(LEN[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
const tAt = (f) => LEN.findIndex((v) => v >= f * LEN[N]) / N;
export const B_DOTS = [0.29, 0.5, 0.71].map((f) => bz(tAt(f)).map(r2));
const B_PATH = `M${P[0]}C${P[1]} ${P[2]} ${P[3]}`.replace(/,/g, ' ');
const splitAt = (t) => { const l = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; const a = l(P[0], P[1]), b = l(P[1], P[2]), c = l(P[2], P[3]), d = l(a, b), e = l(b, c), f = l(d, e); return [P[0], a, d, f].map((p) => p.map(r2)); };
const B_STUB = (() => { const s = splitAt(tAt(0.46)); return `M${s[0].join(' ')}C${s[1].join(' ')} ${s[2].join(' ')} ${s[3].join(' ')}`; })();

const SVG_OPEN = '<svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">';

export function glyph(c) {
  if (c === 'a') {
    const m = uid('m');
    return `${SVG_OPEN}<mask id="${m}" maskUnits="userSpaceOnUse" x="-2" y="-2" width="22" height="22"><rect x="-2" y="-2" width="22" height="22" fill="#fff"/><path class="a-cut" d="${SLASH}" pathLength="100" stroke="#000" stroke-width="4.6" stroke-linecap="butt"/></mask><g mask="url(#${m})"><path class="a-arch" d="${ARCH}"/><path class="a-sweep" d="${ARCH}" pathLength="100"/><path class="a-fill" d="M6.9 15.5V9.3a2.1 2.1 0 0 1 4.2 0v6.2z"/><g class="a-bang"><path d="M9 7.5v3.9"/><circle cx="9" cy="14.2" r="1.05"/></g></g><path class="a-slash" d="${SLASH}" pathLength="100"/></svg>`;
  }
  if (c === 'b') {
    return `${SVG_OPEN}<path class="b-path" d="${B_PATH}" pathLength="100"/>${B_DOTS.map((p, i) => `<circle class="b-d b-d${i + 1}" cx="${p[0]}" cy="${p[1]}" r=".95"/>`).join('')}<circle class="b-start" cx="4" cy="5" r="2.3"/><circle class="b-end" cx="14" cy="13" r="2.3"/><circle class="b-ring" cx="14" cy="13" r="1.6"/><path class="b-x b-x1" d="M12.1 11.1l3.8 3.8" pathLength="10"/><path class="b-x b-x2" d="M15.9 11.1l-3.8 3.8" pathLength="10"/><path class="b-wall" d="M14 9.4v7.2"/></svg>`;
  }
  const m = uid('m');
  return `${SVG_OPEN}<mask id="${m}" maskUnits="userSpaceOnUse" x="0" y="0" width="18" height="18"><rect width="18" height="18" fill="#fff"/><rect x="5.1" y="7.9" width="7.8" height="2.2" rx="1.1" fill="#000"/></mask><circle class="c-ripple" cx="9" cy="9" r="5.6"/><circle class="c-ring" cx="9" cy="9" r="5.6" pathLength="100"/><circle class="c-dot" cx="9" cy="9" r="2.4"/><circle class="c-disc" cx="9" cy="9" r="6.5" mask="url(#${m})"/></svg>`;
}

export const tray = (c, state, cls = '') => `<span class="tray ${cls}" data-state="${state}">${glyph(c)}</span>`;

// ---------- Static, export-ready SVG files (black + alpha only: macOS template rule) ----------
const fileOpen = (title) => `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">\n  <title>${title}</title>\n`;
const arc = (cx, cy, r, a0, a1) => { // degrees, clockwise from 3 o'clock
  const p = (a) => [r2(cx + r * Math.cos(a * Math.PI / 180)), r2(cy + r * Math.sin(a * Math.PI / 180))];
  const [s, e] = [p(a0), p(a1)]; return `M${s[0]} ${s[1]}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${e[0]} ${e[1]}`;
};
export function staticSvg(c, state) {
  const t = `social-tunnel ${state === 'lost' ? 'disconnected' : state}`;
  const body = {
    a: {
      idle: `  <path d="${ARCH}"/>`,
      connected: `  <path d="${ARCH}"/>\n  <path d="M6.9 15.5V9.3a2.1 2.1 0 0 1 4.2 0v6.2z" fill="#000" stroke="none"/>`,
      reconnecting: `  <path d="M3.5 14.6v-4.27"/>\n  <path d="M3.64 7.77A5.5 5.5 0 0 1 14.36 7.77"/>\n  <path d="M14.5 10.33v4.27"/>`,
      lost: `  <mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="18" height="18"><rect width="18" height="18" fill="#fff" stroke="none"/><path d="${SLASH}" stroke="#000" stroke-width="4.6" stroke-linecap="butt"/></mask>\n  <path d="${ARCH}" mask="url(#cut)"/>\n  <path d="${SLASH}"/>`,
      blocked: `  <path d="${ARCH}"/>\n  <path d="M9 7.5v3.9"/>\n  <circle cx="9" cy="14.2" r="1.05" fill="#000" stroke="none"/>`,
    },
    b: {
      idle: `  <circle cx="4" cy="5" r="2.3" fill="#000" stroke="none"/>\n  <circle cx="14" cy="13" r="1.6" stroke-width="1.5"/>`,
      connected: `  <path d="${B_PATH}"/>\n  <circle cx="4" cy="5" r="2.3" fill="#000" stroke="none"/>\n  <circle cx="14" cy="13" r="2.3" fill="#000" stroke="none"/>`,
      reconnecting: `  <circle cx="4" cy="5" r="2.3" fill="#000" stroke="none"/>\n${B_DOTS.map((p) => `  <circle cx="${p[0]}" cy="${p[1]}" r=".95" fill="#000" stroke="none"/>`).join('\n')}\n  <circle cx="14" cy="13" r="1.6" stroke-width="1.5"/>`,
      lost: `  <path d="${B_STUB}"/>\n  <circle cx="4" cy="5" r="2.3" fill="#000" stroke="none"/>\n  <path d="M12.1 11.1l3.8 3.8M15.9 11.1l-3.8 3.8"/>`,
      blocked: `  <path d="${B_PATH}"/>\n  <circle cx="4" cy="5" r="2.3" fill="#000" stroke="none"/>\n  <path d="M14 9.4v7.2" stroke-width="2.3"/>`,
    },
    c: {
      idle: `  <circle cx="9" cy="9" r="5.6"/>`,
      connected: `  <circle cx="9" cy="9" r="5.6"/>\n  <circle cx="9" cy="9" r="2.4" fill="#000" stroke="none"/>`,
      reconnecting: `  <path d="${arc(9, 9, 5.6, -27, 225)}"/>\n  <circle cx="9" cy="9" r="1.2" fill="#000" stroke="none"/>`,
      lost: [0, 90, 180, 270].map((a) => `  <path d="${arc(9, 9, 5.6, a - 27, a + 27)}"/>`).join('\n'),
      blocked: `  <path fill="#000" stroke="none" fill-rule="evenodd" d="M9 2.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13zM6.2 7.9h5.6a1.1 1.1 0 0 1 0 2.2H6.2a1.1 1.1 0 0 1 0-2.2z"/>`,
    },
  }[c][state];
  return `${fileOpen(t)}${body}\n</svg>\n`;
}

// Stand-alone animated SVG of the reconnecting loop (browser preview; the app swaps PNG frames).
export function animatedSvg(c) {
  const css = trayCss.replace(/\s+/g, ' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 18 18" class="${CONCEPTS[c].cls}">\n  <title>social-tunnel reconnecting (animated preview)</title>\n  <style>.tray{color:#000}@media (prefers-color-scheme:dark){.tray{color:#fff}} g.tray{fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round} ${css}</style>\n  <g class="tray" data-state="reconnecting">${glyph(c).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</g>\n</svg>\n`;
}

// ---------- Small status marks used inside dropdowns and windows ----------
export const stat = (tone) => ({
  ok: '<svg class="stat" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.9 8.3l2.1 2.1 4.2-4.6" fill="none" stroke="var(--stat-ink)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: '<svg class="stat" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" fill="none" stroke="var(--stat-ink)" stroke-width="1.7" stroke-linecap="round"/></svg>',
  warn: '<svg class="stat" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.4c.52 0 1 .28 1.26.74l5.5 9.7c.54.96-.15 2.16-1.26 2.16h-11c-1.1 0-1.8-1.2-1.26-2.16l5.5-9.7c.26-.46.74-.74 1.26-.74z" fill="currentColor"/><path d="M8 5.4v3.7" fill="none" stroke="var(--stat-ink)" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".95" fill="var(--stat-ink)"/></svg>',
  busy: '<svg class="stat spin" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-dasharray="26 11.7" stroke-linecap="round"/></svg>',
  off: '<svg class="stat" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 3.08"/></svg>',
}[tone]);

// ---------- CSS ----------
export const trayCss = `
.tray{display:inline-block;width:18px;height:18px;flex:none;vertical-align:middle}
.tray svg{display:block;width:100%;height:100%;overflow:visible;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
/* A · Portal: fill, drain, sweep */
.cA .tray .a-fill{fill:currentColor;stroke:none;transform-box:fill-box;transform-origin:50% 100%;transform:scaleY(0);opacity:0;transition:transform .3s cubic-bezier(.3,.7,.2,1),opacity .18s}
.cA .tray[data-state=connected] .a-fill{transform:none;opacity:1;transition-delay:.16s}
.cA .tray .a-slash,.cA .tray .a-cut{stroke-dasharray:100 200;stroke-dashoffset:105;transition:stroke-dashoffset .32s cubic-bezier(.3,.7,.2,1)}
.cA .tray[data-state=lost] .a-slash,.cA .tray[data-state=lost] .a-cut{stroke-dashoffset:0;transition-delay:.14s}
.cA .tray .a-arch{transition:opacity .25s}
.cA .tray .a-sweep{opacity:0;stroke-dasharray:24 200;stroke-dashoffset:24}
.cA .tray[data-state=reconnecting] .a-arch{opacity:.3}
.cA .tray[data-state=reconnecting] .a-sweep{opacity:1;animation:a-sweep 1.5s cubic-bezier(.5,0,.5,1) infinite}
@keyframes a-sweep{from{stroke-dashoffset:24}to{stroke-dashoffset:-100}}
.cA .tray .a-bang{opacity:0;transform:translateY(-2.5px);transition:opacity .2s,transform .3s cubic-bezier(.3,1.4,.5,1)}
.cA .tray .a-bang circle{fill:currentColor;stroke:none}
.cA .tray[data-state=blocked] .a-bang{opacity:1;transform:none;transition-delay:.12s}
.cA .tray[data-state=lost] svg{animation:a-blink .5s ease-in-out .55s 1}
.cA .tray[data-state=blocked] svg{animation:a-blink2 .5s ease-in-out .5s 1}
@keyframes a-blink{50%{opacity:.3}}
@keyframes a-blink2{50%{opacity:.3}}
/* B · Route: draw, retract, dot progression */
.cB .tray .b-start,.cB .tray .b-end,.cB .tray .b-d{fill:currentColor;stroke:none}
.cB .tray .b-path{stroke-dasharray:0 300;transition:stroke-dasharray .38s cubic-bezier(.3,.7,.2,1)}
.cB .tray[data-state=connected] .b-path,.cB .tray[data-state=blocked] .b-path{stroke-dasharray:100 300}
.cB .tray[data-state=lost] .b-path{stroke-dasharray:46 300}
.cB .tray .b-end{transform-box:fill-box;transform-origin:center;transform:scale(0);transition:transform .3s cubic-bezier(.3,1.5,.5,1)}
.cB .tray[data-state=connected] .b-end{transform:none;transition-delay:.3s}
.cB .tray .b-ring{stroke-width:1.5;opacity:0;transition:opacity .2s}
.cB .tray[data-state=reconnecting] .b-ring,.cB .tray[data-state=idle] .b-ring{opacity:1;transition-delay:.2s}
.cB .tray .b-x{stroke-dasharray:10 20;stroke-dashoffset:10.6;transition:stroke-dashoffset .2s ease-out}
.cB .tray[data-state=lost] .b-x{stroke-dashoffset:0;transition-delay:.3s}
.cB .tray[data-state=lost] .b-x2{transition-delay:.42s}
.cB .tray .b-wall{stroke-width:2.3;transform-box:fill-box;transform-origin:center;transform:scaleY(0);opacity:0;transition:transform .26s cubic-bezier(.3,1.5,.5,1),opacity .1s}
.cB .tray[data-state=blocked] .b-wall{transform:none;opacity:1;transition-delay:.3s}
.cB .tray .b-d{opacity:0;transition:opacity .2s}
.cB .tray[data-state=reconnecting] .b-d{opacity:.28;animation:b-dot 1.26s ease-in-out infinite}
.cB .tray[data-state=reconnecting] .b-d2{animation-delay:.2s}
.cB .tray[data-state=reconnecting] .b-d3{animation-delay:.4s}
@keyframes b-dot{0%,60%,100%{opacity:.28}20%{opacity:1}}
/* C · Beacon: pulse, spin, ripple */
.cC .tray .c-ring{stroke-dasharray:25 0;stroke-dashoffset:7.5;transform-box:fill-box;transform-origin:center;transition:stroke-dasharray .35s ease,opacity .2s}
.cC .tray[data-state=lost] .c-ring{stroke-dasharray:15 10}
.cC .tray[data-state=reconnecting] .c-ring{stroke-dasharray:70 30;animation:c-spin 1.1s linear infinite}
.cC .tray[data-state=blocked] .c-ring{opacity:0}
@keyframes c-spin{to{transform:rotate(360deg)}}
.cC .tray .c-dot{fill:currentColor;stroke:none;transform-box:fill-box;transform-origin:center;transform:scale(0);transition:transform .32s cubic-bezier(.3,1.5,.5,1)}
.cC .tray[data-state=connected] .c-dot{transform:none;transition-delay:.12s}
.cC .tray[data-state=reconnecting] .c-dot{transform:scale(.5);animation:c-beat 1.1s ease-in-out infinite}
@keyframes c-beat{0%,100%{transform:scale(.38)}50%{transform:scale(.62)}}
.cC .tray .c-disc{fill:currentColor;stroke:none;transform-box:fill-box;transform-origin:center;transform:scale(.3);opacity:0;transition:transform .3s cubic-bezier(.3,1.4,.5,1),opacity .12s}
.cC .tray[data-state=blocked] .c-disc{transform:none;opacity:1}
.cC .tray .c-ripple{opacity:0;stroke-width:1.2;transform-box:fill-box;transform-origin:center}
.cC .tray[data-state=connected] .c-ripple{animation:c-ripple-in .7s ease-out 1}
.cC .tray[data-state=lost] .c-ripple{animation:c-ripple-out .7s ease-out 1}
@keyframes c-ripple-in{0%{opacity:.7;transform:scale(1)}100%{opacity:0;transform:scale(1.46)}}
@keyframes c-ripple-out{0%{opacity:.7;transform:scale(1)}100%{opacity:0;transform:scale(1.46)}}
`;

// Static frames: used for .is-static glyphs and for prefers-reduced-motion.
const staticRules = (t) => `
${t} *{transition:none!important;animation:none!important}
.cA ${t}[data-state=reconnecting] .a-arch{opacity:0}
.cA ${t}[data-state=reconnecting] .a-sweep{opacity:1;stroke-dasharray:15 9 52 9 15 200;stroke-dashoffset:0}
.cB ${t}[data-state=reconnecting] .b-d{opacity:1}
.cC ${t}[data-state=reconnecting] .c-dot{transform:scale(.5)}
.cC ${t} .c-ripple{opacity:0}`;
export const trayStaticCss = `${staticRules('.tray.is-static')}
@media (prefers-reduced-motion:reduce){${staticRules('.tray')}
.spin,.seg-busy::before{animation:none!important}}
`;
