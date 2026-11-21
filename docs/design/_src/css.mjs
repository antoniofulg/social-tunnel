// All CSS for the concept pages. Tokens first, then stage, dropdowns, windows, doc chrome.
import { trayCss, trayStaticCss } from './lib.mjs';

const PG_DARK = '--pg:#121214;--pg-card:#1b1b1e;--pg-text:#ececef;--pg-2:#a9a9b1;--pg-line:#2f2f34;--pg-link:#7ab8ff;--focus:#7ab8ff;color-scheme:dark';

const tokens = `
*{box-sizing:border-box}
:root{--sys:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;--round:ui-rounded,"SF Pro Rounded",-apple-system,BlinkMacSystemFont,"Segoe UI Variable Display",system-ui,sans-serif;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
--pg:#f5f5f3;--pg-card:#fff;--pg-text:#1c1c1e;--pg-2:#55555b;--pg-line:#dcdcd8;--pg-link:#0a58b8;--focus:#0a58b8;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${PG_DARK}}}
:root[data-theme=dark]{${PG_DARK}}
/* Semantic roles. Components read these; only the mapping changes per theme. */
.t-light{color-scheme:light;--text:#1c1c1e;--text-2:#46464b;--text-dis:#6c6c72;--bar-text:#111113;
--material:rgba(246,246,248,.6);--material-strong:rgba(244,244,247,.8);--solid:#f2f2f4;--bar:rgba(255,255,255,.5);--bar-open:rgba(0,0,0,.14);
--tile:rgba(255,255,255,.42);--raised:#fff;--well:rgba(0,0,0,.055);--hairline:rgba(0,0,0,.13);--border-control:#86868b;
--btn:#fff;--btn-hover:#f0f0f2;--btn-border:rgba(0,0,0,.2);--hover:rgba(0,0,0,.07);
--ok:#1b7f3b;--warn:#8f5d00;--down:#c4252f;--busy:#46464b;--off:#6b6b70;--stat-ink:#fff;
--ok-bg:rgba(27,127,59,.11);--warn-bg:rgba(214,152,0,.16);--down-bg:rgba(196,37,47,.1);
--shadow-pop:0 0 0 .5px rgba(0,0,0,.22),0 14px 36px rgba(0,0,0,.26),0 2px 6px rgba(0,0,0,.1);
--shadow-win:0 0 0 .5px rgba(0,0,0,.25),0 22px 50px rgba(0,0,0,.3),0 3px 8px rgba(0,0,0,.12);
--glass-edge:inset 0 0 0 .5px rgba(255,255,255,.5),inset 0 1px 0 rgba(255,255,255,.65);
--term-bg:#fbfbfc;--term-fg:#2a2a2e;--term-bar:#e6e6ea}
.t-dark{color-scheme:dark;--text:#f0f0f3;--text-2:#bcbcc4;--text-dis:#9a9aa2;--bar-text:#fff;
--material:rgba(32,32,36,.6);--material-strong:rgba(30,30,34,.78);--solid:#2a2a2e;--bar:rgba(18,18,22,.42);--bar-open:rgba(255,255,255,.22);
--tile:rgba(255,255,255,.08);--raised:#3a3a40;--well:rgba(0,0,0,.3);--hairline:rgba(255,255,255,.15);--border-control:#8a8a93;
--btn:#4a4a51;--btn-hover:#56565e;--btn-border:rgba(255,255,255,.14);--hover:rgba(255,255,255,.1);
--ok:#45c869;--warn:#e4b643;--down:#ff7a72;--busy:#bcbcc4;--off:#a3a3ab;--stat-ink:#17171a;
--ok-bg:rgba(69,200,105,.14);--warn-bg:rgba(228,182,67,.15);--down-bg:rgba(255,113,104,.15);
--shadow-pop:0 0 0 .5px rgba(0,0,0,.7),0 16px 40px rgba(0,0,0,.55);
--shadow-win:0 0 0 .5px rgba(0,0,0,.8),0 24px 56px rgba(0,0,0,.6);
--glass-edge:inset 0 0 0 .5px rgba(255,255,255,.2),inset 0 1px 0 rgba(255,255,255,.14);
--term-bg:#17171b;--term-fg:#c9d1d9;--term-bar:#26262b}
/* Personality per concept: accent, radii. */
.cA{--r-btn:6px;--r-inp:6px;--r-box:8px;--r-win:11px}
.cB{--r-btn:8px;--r-inp:8px;--r-box:10px;--r-win:13px}
.cC{--r-btn:99px;--r-inp:9px;--r-box:12px;--r-win:15px}
.cA .t-light{--accent:#0a64d6;--accent-ink:#fff;--focus:#0a64d6}
.cA .t-dark{--accent:#1f6fde;--accent-ink:#fff;--focus:#7ab8ff}
.cB .t-light{--accent:#5146d8;--accent-ink:#fff;--focus:#5146d8}
.cB .t-dark{--accent:#665ce6;--accent-ink:#fff;--focus:#b3adff}
.cC .t-light{--accent:#1c1c1e;--accent-ink:#fff;--focus:#1c1c1e}
.cC .t-dark{--accent:#f0f0f3;--accent-ink:#1c1c1e;--focus:#f0f0f3}
.tone-ok{color:var(--ok)}.tone-warn{color:var(--warn)}.tone-down{color:var(--down)}.tone-busy{color:var(--busy)}.tone-off{color:var(--off)}
.is-ok{--tone-bg:var(--ok-bg)}.is-warn{--tone-bg:var(--warn-bg)}.is-down{--tone-bg:var(--down-bg)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
`;

const stage = `
.stage{position:relative;overflow:hidden;border-radius:14px;isolation:isolate;min-height:250px;padding-bottom:32px;font:13px/1.38 var(--sys);color:var(--text);-webkit-font-smoothing:antialiased}
.stage.t-light,.barstage.t-light{background:
 radial-gradient(circle 46px at 33% 76px,#ff9a62 0 97%,rgba(255,154,98,0) 100%),
 radial-gradient(55% 45% at 80% 12%,rgba(255,246,222,.95) 0,rgba(255,246,222,0) 70%),
 radial-gradient(120% 78% at -6% 104%,#2f6fb4 0 36%,rgba(47,111,180,0) 36.3%),
 radial-gradient(120% 70% at 104% 110%,#ee8a5f 0 38%,rgba(238,138,95,0) 38.3%),
 radial-gradient(86% 58% at 46% 114%,#f5c468 0 42%,rgba(245,196,104,0) 42.3%),
 radial-gradient(70% 60% at 18% 30%,rgba(120,180,240,.55) 0,rgba(120,180,240,0) 70%),
 linear-gradient(165deg,#86bfee 0%,#bcdcf5 44%,#fbe2c2 100%)}
.stage.t-dark,.barstage.t-dark{background:
 radial-gradient(circle 46px at 33% 76px,#5850b0 0 97%,rgba(88,80,176,0) 100%),
 radial-gradient(55% 45% at 80% 12%,rgba(126,96,255,.42) 0,rgba(126,96,255,0) 70%),
 radial-gradient(120% 78% at -6% 104%,#123c70 0 36%,rgba(18,60,112,0) 36.3%),
 radial-gradient(120% 70% at 104% 110%,#8a3347 0 38%,rgba(138,51,71,0) 38.3%),
 radial-gradient(86% 58% at 46% 114%,#2c2676 0 42%,rgba(44,38,118,0) 42.3%),
 radial-gradient(70% 60% at 18% 30%,rgba(30,90,170,.5) 0,rgba(30,90,170,0) 70%),
 linear-gradient(165deg,#0a0f2e 0%,#161a4c 46%,#2c1d50 100%)}
.stage-tag{position:absolute;left:10px;bottom:8px;z-index:3;font-size:11px;font-weight:600;padding:2px 8px;border-radius:99px;background:rgba(0,0,0,.62);color:#fff}
.term{position:absolute;left:14px;top:112px;width:250px;border-radius:10px;overflow:hidden;background:var(--term-bg);color:var(--term-fg);box-shadow:0 10px 30px rgba(0,0,0,.28),0 0 0 .5px rgba(0,0,0,.3);z-index:0}
.term-bar{height:22px;background:var(--term-bar);display:flex;gap:6px;align-items:center;padding:0 9px}
.term-bar i{width:9px;height:9px;border-radius:50%;background:rgba(128,128,128,.55)}
.term pre{margin:0;padding:8px 11px 12px;font:10.5px/1.55 var(--mono);white-space:pre}
.menubar{position:relative;z-index:2;height:28px;display:flex;align-items:center;gap:14px;padding:0 14px;background:var(--bar);-webkit-backdrop-filter:blur(24px) saturate(1.6);backdrop-filter:blur(24px) saturate(1.6);color:var(--bar-text);font-size:13px;white-space:nowrap}
.mb-app{font-weight:700}.mb-sp{flex:1}
.mb-g{width:17px;height:13px;flex:none}
.mb-tray{display:inline-grid;place-items:center;width:30px;height:22px;border-radius:6px;flex:none;margin:0 -6px}
.mb-tray.is-open{background:var(--bar-open)}
.mb-clock{width:102px;text-align:right;flex:none}
.drop{position:relative;z-index:1;display:flex;justify-content:flex-end;padding:5px 9px 0}
.drop>*{max-width:100%}
.material{background:var(--material);-webkit-backdrop-filter:blur(34px) saturate(1.9);backdrop-filter:blur(34px) saturate(1.9);box-shadow:var(--shadow-pop),var(--glass-edge)}
.win-stage{display:grid;justify-items:center;align-content:start;padding:26px 20px 40px;min-height:0}
@media (max-width:520px){.mb-item{display:none}}
@media (prefers-reduced-transparency:reduce){.material,.menubar,.win{-webkit-backdrop-filter:none!important;backdrop-filter:none!important;background:var(--solid)!important}}
@media (prefers-contrast:more){.material,.win{-webkit-backdrop-filter:none!important;backdrop-filter:none!important;background:var(--solid)!important}.t-light{--hairline:rgba(0,0,0,.45)}.t-dark{--hairline:rgba(255,255,255,.5)}}
`;

const atoms = `
.stat{display:block;width:16px;height:16px;flex:none}
.spin{animation:spin 1.1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
code,.fp{font:11.5px/1.4 var(--mono);overflow-wrap:anywhere}
kbd{font:inherit}
.sp{flex:1}
.btn{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 12px;border-radius:var(--r-btn);border:.5px solid var(--btn-border);background:var(--btn);color:var(--text);font:inherit;white-space:nowrap;cursor:pointer;box-shadow:0 .5px 1.5px rgba(0,0,0,.12);transition:background-color .12s}
.btn:hover{background:var(--btn-hover)}
.btn:active{filter:brightness(.94)}
.btn.primary{background:var(--accent);border-color:transparent;color:var(--accent-ink);font-weight:500}
.btn.primary:hover{background:var(--accent);filter:brightness(1.08)}
.btn.sm{height:24px;padding:0 9px;font-size:12px}
.btn.quiet{background:none;border-color:transparent;box-shadow:none;color:var(--text-2)}
.btn.quiet:hover{background:var(--hover)}
.btn[aria-disabled=true],.btn.primary[aria-disabled=true]{background:var(--hover);border-color:transparent;box-shadow:none;color:var(--text-dis);cursor:default;filter:none}
.btn svg{width:7px;height:11px;margin-right:5px}
.link{height:24px;padding:0 6px;border:0;border-radius:6px;background:none;color:var(--text);font:inherit;cursor:pointer}
.link:hover{background:var(--hover)}
.inp{height:28px;width:100%;min-width:0;padding:0 8px;border-radius:var(--r-inp);border:1px solid var(--border-control);background:var(--raised);color:var(--text);font:inherit}
.inp.mono{font:12px var(--mono)}
.inp.short{width:84px}
.inp::placeholder{color:var(--text-2);opacity:1}
.inp:disabled{background:var(--well);border-color:var(--hairline);color:var(--text-2)}
.inp[aria-invalid=true]{border-color:var(--down);box-shadow:0 0 0 1px var(--down)}
.hint{margin:8px 0 0;font-size:12px;color:var(--text-2)}
.form{display:grid;grid-template-columns:92px 1fr;gap:9px 12px;align-items:center}
.form label{text-align:right}
.form .hint{grid-column:2;margin:-4px 0 0}
.alert{display:grid;grid-template-columns:16px 1fr;gap:9px;margin:12px 0 0;padding:10px 12px;border-radius:var(--r-box);background:var(--tone-bg);box-shadow:inset 0 0 0 .5px var(--hairline)}
.alert p{margin:2px 0 0;color:var(--text-2)}
.alert>span{margin-top:1px}
.cmd{display:flex;align-items:center;gap:8px;margin-top:8px;padding:4px 4px 4px 9px;border-radius:8px;background:var(--well)}
.cmd code{flex:1;min-width:0}
.steps{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:10px}
.steps li{display:grid;grid-template-columns:16px 1fr;gap:10px}
.steps p{margin:1px 0 0;font-size:12px;color:var(--text-2)}
.steps .todo strong{font-weight:400;color:var(--text-2)}
.add{display:grid;gap:5px;margin:0 0 10px}
.add label{font-weight:500}
.add-row{display:flex;gap:8px}
.err{display:flex;gap:6px;align-items:flex-start;margin:1px 0 0;font-size:12px}
.suggest{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:3px;font-size:12px;color:var(--text-2)}
.list,.hoplist,.inset{list-style:none;margin:0;padding:0;border-radius:var(--r-box);background:var(--tile);box-shadow:inset 0 0 0 .5px var(--hairline)}
.list{margin-bottom:12px}
.list li,.inset li{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:32px;padding:3px 6px 3px 11px}
.list li+li,.hoplist li+li,.inset li+li{border-top:.5px solid var(--hairline)}
.hoplist li{display:flex;align-items:center;gap:8px;min-height:30px;padding:0 11px}
.hop-word{color:var(--text-2)}
.hoplist .hop-word{margin-left:auto}
.check{display:flex;gap:7px;align-items:center;margin:4px 0}
.check input{width:15px;height:15px;margin:0;accent-color:var(--accent)}
.switch{flex:none;width:38px;height:24px;padding:2px;border:0;border-radius:99px;background:var(--border-control);cursor:pointer}
.switch i{display:block;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s}
.switch[aria-checked=true]{background:var(--accent)}
.switch[aria-checked=true] i{transform:translateX(14px);background:var(--accent-ink)}
.note{margin:12px 0 0;padding-top:10px;border-top:.5px solid var(--hairline);font-size:12px;color:var(--text-2)}
.kv{display:grid;grid-template-columns:92px 1fr;gap:5px 12px;margin:0}
.kv dt{text-align:right;color:var(--text-2)}
.kv dd{margin:0;min-width:0}
.group{margin:16px 0 6px;font-size:12px;font-weight:600;color:var(--text-2)}
.win-body>.group:first-child{margin-top:2px}
.row-end{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
.seg{display:inline-flex;padding:2px;border-radius:8px;background:var(--well)}
.seg button{height:24px;padding:0 14px;border:0;border-radius:6px;background:none;color:var(--text);font:inherit;cursor:pointer}
.seg button[aria-selected=true],.seg button[aria-pressed=true]{background:var(--btn);box-shadow:0 .5px 2px rgba(0,0,0,.25);font-weight:500}
.seg.sm button{height:22px;padding:0 10px;font-size:12px}
.log{margin:10px 0 0;padding:9px 11px;height:186px;overflow:auto;border-radius:var(--r-box);background:var(--well);color:var(--text);font:11px/1.65 var(--mono);white-space:pre}
.sec-label{font-size:11px;font-weight:600;color:var(--text-2)}
.paused{margin:0;color:var(--text-2)}
.issue p{margin:0}
.issue-fix{color:var(--text-2)}
.issue .btn{margin-top:8px}
.issue .cmd .btn{margin-top:0}
.chips{list-style:none;display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0;padding:0}
.chips li{padding:3px 9px;border-radius:99px;background:var(--tile);box-shadow:inset 0 0 0 .5px var(--hairline);font-size:12px}
.chips.big{margin:0 0 12px}
.chips.big li{display:inline-flex;align-items:center;gap:2px;padding:1px 2px 1px 11px;font-size:13px}
.x{display:grid;place-items:center;width:24px;height:24px;border:0;border-radius:50%;background:none;color:var(--text-2);cursor:pointer}
.x:hover{background:var(--hover)}
.x svg{width:10px;height:10px}
/* Route strip: concept B signature. Solid = reached, dotted = not reached. */
.route{list-style:none;display:grid;grid-template-columns:repeat(4,1fr);margin:0;padding:0}
.hop{position:relative;display:grid;justify-items:center;gap:2px;text-align:center;font-size:11px;line-height:1.3}
.hop::before{content:"";position:absolute;top:7px;right:calc(50% + 12px);width:calc(100% - 24px);height:2px;border-radius:2px}
.hop:first-child::before{display:none}
.hop.seg-ok::before{background:var(--ok)}
.hop.seg-off::before{height:0;border-top:2px dotted var(--off)}
.hop.seg-busy::before{background:radial-gradient(circle,var(--text) 0 1.2px,transparent 1.6px) 0 0/8px 2px repeat-x;height:3px;top:6.5px;animation:march .5s linear infinite}
@keyframes march{to{background-position:8px 0}}
.hop-name{margin-top:3px;font-weight:500}
`;

const windows = `
.win{width:min(468px,100%);border-radius:var(--r-win);overflow:hidden;background:var(--material-strong);-webkit-backdrop-filter:blur(40px) saturate(1.7);backdrop-filter:blur(40px) saturate(1.7);box-shadow:var(--shadow-win),var(--glass-edge);color:var(--text)}
.titlebar{position:relative;display:flex;align-items:center;height:38px;padding:0 13px}
.lights{display:flex;gap:8px}
.lights i{width:12px;height:12px;border-radius:50%;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.22)}
.lights i:nth-child(1){background:#ff5f57}.lights i:nth-child(2){background:#febc2e}.lights i:nth-child(3){background:#28c840}
.ttl{position:absolute;left:0;right:0;text-align:center;font-weight:600;pointer-events:none}
.win-body{padding:4px 22px 18px}
.win-foot{display:flex;align-items:center;gap:8px;padding:12px 22px 14px;border-top:.5px solid var(--hairline)}
.win-foot .hint,.win-foot .check{margin:0}
.win-tabs{display:flex;justify-content:center;padding:0 22px 12px}
.win-route{margin-bottom:10px;padding:6px 22px 12px;border-bottom:.5px solid var(--hairline)}
.route-sum{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;font-size:12px;color:var(--text-2)}
.step-count{margin:0;font-size:12px;color:var(--text-2)}
.step-title{margin:2px 0 3px;font-size:16px;font-weight:600;letter-spacing:-.01em}
.step-desc{margin:0 0 14px;color:var(--text-2)}
/* C: one page of cards and grouped rows */
.cC .step-title,.cC .card h3,.cC .st-title{font-family:var(--round)}
.card{margin-top:10px;padding:11px 14px;border-radius:14px;background:var(--tile);box-shadow:inset 0 0 0 .5px var(--hairline)}
.card:first-child{margin-top:2px}
.card h3{display:flex;align-items:center;gap:9px;margin:0;font-size:14px;font-weight:600}
.card h3 .btn{margin-left:auto}
.num{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--text);color:var(--solid);font:600 11px var(--sys)}
.card.done .num{background:none;color:var(--ok)}
.card.next .num{background:none;color:var(--text-2);box-shadow:inset 0 0 0 1px var(--border-control)}
.card.next h3{color:var(--text-2)}
.sum{margin:3px 0 0 29px;font-size:12px;color:var(--text-2)}
.card.open .step-desc{margin:6px 0 12px}
.cC .inset li{min-height:36px;padding:4px 8px 4px 13px}
.cC .inset li>span:first-child{white-space:nowrap}
.cC .inset .fp{text-align:right}
.add.inline{display:flex;align-items:center;gap:10px;width:100%;margin:0}
.add.inline label{font-weight:400;white-space:nowrap}
.add.inline .add-row{flex:1}
.with-mark{display:flex;align-items:center;gap:8px}
.back-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.back-row .step-title{margin:0}
`;

const drops = `
/* A · native menu */
.cA .menu{width:max-content;min-width:250px;padding:5px;border-radius:10px;white-space:nowrap}
.cA .menu ul{list-style:none;margin:0;padding:0}
.cA .mi{display:flex;align-items:center;gap:7px;min-height:24px;padding:2px 9px;border-radius:6px}
.cA .mi .ic{display:grid;place-items:center;flex:none;width:18px;height:18px}
.cA .mi.head{font-weight:600}
.cA .mi.info{color:var(--text-2)}
.cA .mi.label{min-height:21px;padding-top:5px;font-size:11px;font-weight:600;color:var(--text-2)}
.cA .mi kbd{margin-left:auto;color:var(--text-2)}
.cA .mi.is-hover{background:var(--accent);color:var(--accent-ink)}
.cA .mi.is-hover kbd{color:inherit}
.cA .sep{height:1px;margin:5px 9px;background:var(--hairline)}
/* B · popover */
.cB .pop{position:relative;width:340px;margin-top:7px;padding:14px;border-radius:15px}
.cB .pop::before{content:"";position:absolute;top:-6.5px;right:129px;width:14px;height:14px;border-radius:3px 0 0;transform:rotate(45deg);background:inherit;-webkit-backdrop-filter:inherit;backdrop-filter:inherit;clip-path:polygon(0 0,100% 0,0 100%)}
.cB .pop-head{display:flex;align-items:center;gap:11px;margin-bottom:14px}
.cB .tray.big{width:30px;height:30px}
.cB .pop-title{font-size:15px;font-weight:600;letter-spacing:-.01em}
.cB .pop-sub{color:var(--text-2)}
.cB .issue{margin:12px 0 0;padding:9px 11px;border-radius:10px;background:var(--tone-bg);box-shadow:inset 0 0 0 .5px var(--hairline)}
.cB .pop .sec-label,.cB .pop .paused{margin-top:12px}
.cB .pop-foot{display:flex;align-items:center;gap:2px;margin:14px -4px -4px;padding-top:10px;border-top:.5px solid var(--hairline)}
.cB .pop-foot .btn{margin-left:4px}
.cB .pop-head:last-of-type{margin-bottom:0}
/* C · control panel */
.cC .panel{display:grid;gap:8px;width:318px;padding:9px;border-radius:19px}
.cC .tile{padding:10px 12px;border-radius:12px;background:var(--tile);box-shadow:inset 0 0 0 .5px var(--hairline)}
.cC .tile.tint{background:var(--tone-bg)}
.cC .status{display:flex;align-items:center;gap:11px}
.cC .chip{display:grid;place-items:center;flex:none;width:38px;height:38px;border-radius:50%;background:var(--well);box-shadow:inset 0 0 0 .5px var(--hairline)}
.cC .chip .tray{width:24px;height:24px}
.cC .chip-ok{background:var(--ok);color:var(--stat-ink)}
.cC .chip-busy{color:var(--busy)}.cC .chip-down{color:var(--down)}.cC .chip-warn{color:var(--warn)}.cC .chip-off{color:var(--off)}
.cC .st-title{font-size:15px;font-weight:600;line-height:1.25}
.cC .st-sub{font-size:12px;color:var(--text-2)}
.cC .doms{list-style:none;margin:4px 0 0;padding:0;line-height:1.7}
.cC .rows{list-style:none;margin:0;padding:0 0 1px}
.cC .row{display:flex;align-items:center;min-height:26px;padding:2px 12px;border-radius:9px}
.cC .row kbd{margin-left:auto;color:var(--text-2)}
.cC .row.is-hover{background:var(--hover)}
.cC .row.top-line{margin-top:9px;position:relative}
.cC .row.top-line::before{content:"";position:absolute;left:12px;right:12px;top:-5px;height:.5px;background:var(--hairline)}
`;

const doc = `
body{margin:0;background:var(--pg);color:var(--pg-text);font:14px/1.5 var(--sys);-webkit-font-smoothing:antialiased}
a{color:var(--pg-link);text-underline-offset:2px}
.wrap{max-width:1240px;margin:0 auto;padding:0 28px 96px}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:6px 22px;padding:16px 0;border-bottom:1px solid var(--pg-line);font-size:13px}
.brand{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--pg-text);text-decoration:none}
.brand span{font-weight:400;color:var(--pg-2)}
.top nav{display:flex;flex-wrap:wrap;gap:4px;margin-left:auto}
.top nav a{padding:4px 10px;border-radius:7px;color:var(--pg-text);text-decoration:none}
.top nav a:hover{background:var(--pg-line)}
.top nav a[aria-current=page]{background:var(--pg-text);color:var(--pg)}
h1{margin:34px 0 8px;font-size:30px;line-height:1.15;letter-spacing:-.022em;text-wrap:balance}
.lede{max-width:66ch;margin:0;font-size:16px;color:var(--pg-2);text-wrap:pretty}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1px;margin:22px 0 0;padding:0;list-style:none;border:1px solid var(--pg-line);border-radius:12px;overflow:hidden;background:var(--pg-line)}
.facts li{padding:11px 14px;background:var(--pg-card);font-size:13px}
.facts b{display:block;font-size:12px;font-weight:600;color:var(--pg-2)}
h2{margin:56px 0 4px;font-size:20px;letter-spacing:-.012em}
h2+p{max-width:72ch;margin:0 0 18px;color:var(--pg-2)}
.fig{display:grid;grid-template-columns:220px minmax(0,1fr);gap:22px;padding:18px 0;border-top:1px solid var(--pg-line);margin:0}
.fig.wide{grid-template-columns:minmax(0,1fr);gap:10px}
.cap h3{margin:0 0 4px;font-size:14px}
.cap p{margin:0;font-size:13px;color:var(--pg-2);text-wrap:pretty}
.fig.wide .cap{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px}
.fig.wide .cap h3{margin:0}
.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
.tbl-wrap{overflow-x:auto;border:1px solid var(--pg-line);border-radius:12px;background:var(--pg-card)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:10px 14px;border-top:1px solid var(--pg-line);text-align:left;vertical-align:middle}
thead th{border-top:0;font-size:12px;font-weight:600;color:var(--pg-2);white-space:nowrap}
tbody th{font-weight:600;white-space:nowrap}
.tray-tbl td:nth-child(2),.tray-tbl td:nth-child(3){white-space:nowrap}
#compare td{vertical-align:top;width:30%}
#compare tbody th{vertical-align:top}
.sw{display:inline-grid;place-items:center;width:58px;height:58px;border-radius:12px;vertical-align:middle}
.sw+.sw{margin-left:6px}
.sw .tray{width:40px;height:40px}
.sw.t-light,.zoom.t-light{background:#e8e8eb;color:#111113}
.sw.t-dark,.zoom.t-dark{background:#222226;color:#fff}
.barchip{display:inline-flex;align-items:center;gap:9px;height:26px;padding:0 10px;border-radius:7px;font-size:12px;vertical-align:middle;white-space:nowrap}
.barchip+.barchip{margin-left:6px}
.barchip.t-light{background:linear-gradient(90deg,#cfe3f6,#f6e6d2);color:#111113}
.barchip.t-dark{background:linear-gradient(90deg,#161b46,#34224f);color:#fff}
.taskbar{display:inline-flex;align-items:center;gap:13px;height:34px;padding:0 13px;border-radius:8px;vertical-align:middle}
.taskbar+.taskbar{margin-left:8px}
.taskbar .tray{width:16px;height:16px}
.taskbar.t-dark{background:#1c1c1f;color:#fff}.taskbar.t-light{background:#eeeef0;color:#111113;box-shadow:inset 0 0 0 1px var(--pg-line)}
.other-os{margin:14px 0 0;font-size:13px;color:var(--pg-2)}
.player{display:grid;grid-template-columns:auto minmax(0,1fr);gap:20px;align-items:center;margin:0 0 16px;padding:16px;border:1px solid var(--pg-line);border-radius:14px;background:var(--pg-card)}
.zooms{display:flex;gap:10px}
.zoom{display:grid;place-items:center;width:108px;height:108px;border-radius:18px}
.zoom .tray{width:72px;height:72px}
.bars{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.barstage{border-radius:9px;overflow:hidden;font:13px/1.38 var(--sys)}
.barstage .menubar{gap:12px;padding:0 12px}
.barstage .mb-clock{width:auto}
.timeline{list-style:none;display:flex;flex-wrap:wrap;gap:5px;margin:12px 0 10px;padding:0;font-size:12.5px}
.timeline li{padding:3px 10px;border-radius:99px;border:1px solid var(--pg-line);color:var(--pg-2)}
.timeline li[data-on]{background:var(--pg-text);border-color:transparent;color:var(--pg)}
.ctl{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;color:var(--pg-2)}
.pbtn{height:28px;min-width:64px;padding:0 12px;border-radius:7px;border:1px solid var(--pg-line);background:var(--pg-card);color:var(--pg-text);font:inherit;cursor:pointer}
.pbtn:hover{border-color:var(--pg-2)}
.two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}
.two h3{margin:0 0 6px;font-size:14px}
.two ul{margin:0;padding-left:18px;color:var(--pg-2)}
.two li{margin:4px 0}
/* overview */
.cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin-top:26px}
.col{display:grid;gap:12px;align-content:start;padding:16px;border:1px solid var(--pg-line);border-radius:16px;background:var(--pg-card)}
.col h2{margin:0;font-size:19px}
.col .tagline{margin:0;color:var(--pg-2);min-height:4.5em}
.col .player{grid-template-columns:minmax(0,1fr);gap:12px;margin:0;padding:0;border:0}
.col .zoom{width:84px;height:84px;border-radius:15px}
.col .zoom .tray{width:54px;height:54px}
.col .stage{min-height:0}
.col .term{display:none}
.col .mb-item,.col .mb-g{display:none}
.col .win-stage{padding:18px 12px 34px}
.col .win{zoom:.72}
.col h3{margin:6px 0 -4px;font-size:12px;font-weight:600;color:var(--pg-2)}
.open-link{display:inline-flex;align-items:center;justify-content:center;height:34px;padding:0 14px;border-radius:9px;background:var(--pg-text);color:var(--pg);font-weight:600;text-decoration:none}
.open-link:hover{filter:brightness(1.15)}
.pick{margin:18px 0 0;padding:18px 20px;border:1px solid var(--pg-line);border-radius:14px;background:var(--pg-card);max-width:82ch}
.pick p{margin:0 0 8px}.pick p:last-child{margin:0}
@media (max-width:1100px){.cols{grid-template-columns:minmax(0,1fr)}.col .tagline{min-height:0}}
@media (max-width:960px){.fig{grid-template-columns:minmax(0,1fr);gap:10px}.two{grid-template-columns:minmax(0,1fr)}}
@media (max-width:820px){.pair{grid-template-columns:minmax(0,1fr)}.player{grid-template-columns:minmax(0,1fr)}.wrap{padding:0 16px 72px}}
@media (max-width:480px){.bars{grid-template-columns:minmax(0,1fr)}h1{font-size:25px}.cC .panel,.cB .pop,.cA .menu{width:100%}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}.btn,.switch i{transition:none}}
`;

export const CSS = [tokens, stage, trayCss, trayStaticCss, atoms, windows, drops, doc].join('\n');
