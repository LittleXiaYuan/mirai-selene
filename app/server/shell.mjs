/**
 * H5 游戏壳生成器（galgame 方向）。
 *
 * 输入一份 World-Spec，输出一个可直接打开的单文件视觉小说：
 *   开场标题（点击开始）→ 章节卡 + 双背景交叉淡入 + 名字牌 + 逐字台词
 *   → 选项 / AUTO / LOG / SAVE / LOAD / 2×5 存档页 → 世界线画廊。
 *
 * 壳子只带 UI、演出与 localStorage 存档；推演仍调用 /mirai-api（window.MIRAI_API_BASE 可改）。
 */

const THEMES = {
  cream: {
    page: "oklch(95.5% .015 20)",
    ink: "oklch(29% .03 15)",
    muted: "oklch(50% .04 15)",
    rose: "oklch(34% .06 12)",
    accent: "oklch(40% .09 12)",
    wineA: "oklch(40% .06 30 / .96)",
    wineB: "oklch(50% .05 30 / .6)",
    deep: "oklch(24% .02 45)",
  },
  warm: {
    page: "oklch(95.5% .015 20)",
    ink: "oklch(30% .03 15)",
    muted: "oklch(50% .04 15)",
    rose: "oklch(34% .06 12)",
    accent: "oklch(40% .09 12)",
    wineA: "oklch(37% .075 12 / .96)",
    wineB: "oklch(48% .06 12 / .6)",
    deep: "oklch(21% .018 20)",
  },
  noir: {
    page: "oklch(95.5% .01 280)",
    ink: "oklch(28% .02 280)",
    muted: "oklch(50% .03 280)",
    rose: "oklch(34% .05 285)",
    accent: "oklch(40% .08 285)",
    wineA: "oklch(25% .03 285 / .96)",
    wineB: "oklch(32% .03 285 / .6)",
    deep: "oklch(17% .012 285)",
  },
  cold: {
    page: "oklch(95.5% .012 240)",
    ink: "oklch(29% .02 240)",
    muted: "oklch(50% .03 240)",
    rose: "oklch(34% .05 240)",
    accent: "oklch(40% .07 240)",
    wineA: "oklch(28% .04 240 / .96)",
    wineB: "oklch(36% .04 240 / .6)",
    deep: "oklch(20% .015 240)",
  },
};

const STANCE = {
  empathetic: { label: "信了一点", emotion: "warm" },
  neutral: { label: "平视", emotion: "neutral" },
  probe_blindspot: { label: "追问底牌", emotion: "tense" },
  skeptical_push: { label: "听出心虚", emotion: "cold" },
  counter_bluff: { label: "反将一军", emotion: "tense" },
  rupture: { label: "谈崩", emotion: "broken" },
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function renderShell(spec, options = {}) {
  const theme = THEMES[spec?.ui?.palette] ?? THEMES.warm;
  const entry = spec.logic_nodes.find((node) => node.id === spec.entry) ?? spec.logic_nodes[0];
  const cover =
    spec.assets_manifest.cover?.path ??
    (entry?.scene?.background ? spec.assets_manifest.backgrounds[entry.scene.background]?.path : null) ??
    spec.assets_manifest.portraits[spec.cast[0]?.portrait]?.base ??
    "";
  const json = JSON.stringify(spec).replace(/</g, "\\u003c");
  const apiBase = options.apiBase ?? "/mirai-api";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(spec.title)} · Mirai Selene</title>
<style>
  :root{
    --page:${theme.page}; --ink:${theme.ink}; --muted:${theme.muted}; --rose:${theme.rose};
    --accent:${theme.accent}; --wine-a:${theme.wineA}; --wine-b:${theme.wineB}; --deep:${theme.deep};
    --serif:"Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,serif;
    --sans:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;overflow:hidden;background:var(--deep);font-family:var(--sans);color:var(--ink);-webkit-font-smoothing:antialiased}
  button,input{font:inherit;color:inherit;border:0;background:none}
  button{cursor:pointer}
  ::selection{background:oklch(40% .09 12 / .2)}
  #petals{position:fixed;inset:0;z-index:9;pointer-events:none}
  .screen{position:fixed;inset:0;display:none}
  .screen.active{display:block}

  /* ---------- 开场 ---------- */
  #title{background:var(--page);cursor:pointer}
  .cover{position:absolute;inset:0;background-position:center 26%;background-size:cover;filter:blur(1.5px) saturate(.92);transform:scale(1.03)}
  #title::after{position:absolute;inset:0;content:"";background:
    radial-gradient(1000px 620px at 70% 24%,oklch(100% 0 0 / .3),transparent 66%),
    linear-gradient(to top,oklch(96% .015 20 / .96) 0%,oklch(96% .015 20 / .55) 26%,oklch(100% 0 0 / .04) 62%),
    linear-gradient(to bottom,oklch(12% .02 20 / .3),transparent 32%)}
  .title-wrap{position:absolute;left:0;right:0;bottom:0;z-index:2;display:flex;align-items:flex-end;justify-content:space-between;gap:36px;padding:46px 6vw 40px;background:linear-gradient(to top,oklch(97% .012 20 / .95),oklch(97% .012 20 / .5) 60%,transparent)}
  .title-copy h1{margin:0;font-family:var(--serif);font-size:clamp(2.4rem,4.2vw,4rem);font-weight:600;letter-spacing:.08em;color:var(--rose);text-shadow:0 2px 0 oklch(100% 0 0 / .65)}
  .title-copy .sub{margin:10px 0 0;font-size:13px;font-weight:600;letter-spacing:.16em;color:var(--muted)}
  .menu{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-bottom:4px}
  .menu button{padding:10px 18px;border-radius:999px;font-size:15px;font-weight:600;letter-spacing:.04em;color:var(--rose);transition:.18s}
  .menu button:hover{background:oklch(46% .08 12 / .12);transform:translateY(-1px)}
  .menu .dot{color:oklch(78% .06 12)}
  .start-hint{position:absolute;left:50%;top:57%;z-index:2;transform:translateX(-50%);font-size:13px;font-weight:600;letter-spacing:.28em;color:oklch(45% .06 15 / .82);animation:pulse 2.2s ease-in-out infinite;text-shadow:0 1px 8px oklch(100% 0 0 / .8)}
  .start-hint small{display:block;margin-top:8px;font-size:10px;letter-spacing:.16em;color:oklch(52% .04 15 / .7);text-align:center}
  @keyframes pulse{0%,100%{opacity:.55;transform:translateX(-50%) translateY(0)}50%{opacity:1;transform:translateX(-50%) translateY(-3px)}}
  .brand-foot{position:absolute;left:6vw;top:26px;z-index:2;font-size:11px;font-weight:600;letter-spacing:.2em;color:oklch(46% .07 12 / .8)}

  /* ---------- 舞台 ---------- */
  #stage{background:var(--deep)}
  .bg{position:absolute;inset:0;background-position:center;background-size:cover;opacity:0;transition:opacity .65s ease;mix-blend-mode:screen;pointer-events:none}
  #stage::before{position:absolute;inset:0;z-index:1;content:"";background:
    radial-gradient(120% 90% at 72% 18%,var(--wine-b),transparent 62%),
    linear-gradient(to top,oklch(18% .02 15 / .9),transparent 52%);opacity:.55;pointer-events:none}
  .figure{position:absolute;inset:0;z-index:2;display:flex;align-items:flex-end;justify-content:center;pointer-events:none}
  .figure img{height:90vh;max-height:920px;aspect-ratio:2/3;object-fit:cover;object-position:center top;border-radius:26px 26px 0 0;
    -webkit-mask-image:linear-gradient(to bottom,#000 72%,transparent 100%);mask-image:linear-gradient(to bottom,#000 72%,transparent 100%);
    filter:saturate(.94);opacity:0;transform:translateY(10px) scale(.995);transition:opacity .45s ease,transform .45s cubic-bezier(.22,1,.36,1),filter .35s ease}
  .figure img.in{opacity:1;transform:none}
  .figure img[data-emotion="warm"]{filter:saturate(1.08) brightness(1.04)}
  .figure img[data-emotion="cold"]{filter:saturate(.76) contrast(1.1)}
  .figure img[data-emotion="tense"]{filter:saturate(.88) contrast(1.08) hue-rotate(-4deg)}
  .figure img[data-emotion="broken"]{filter:grayscale(.45) contrast(1.15) brightness(.84)}
  .chapter{position:absolute;left:max(4vw,calc((100% - min(72rem,90vw))/2));top:12%;z-index:7;font-family:var(--serif);font-size:15px;letter-spacing:.22em;color:oklch(98% .01 20 / .86);text-shadow:0 2px 10px oklch(10% .02 15 / .5);opacity:0;transform:translateY(6px);transition:.4s ease}
  .chapter.show{opacity:1;transform:none}
  .choices{position:absolute;left:50%;bottom:30%;z-index:8;display:flex;flex-direction:column;gap:12px;width:min(34rem,86vw);transform:translateX(-50%);transition:.2s}
  .choices[hidden]{display:none}
  .choice{width:100%;padding:14px 24px;border-radius:999px;background:oklch(99% .008 20 / .93);border:1.5px solid oklch(72% .05 15 / .42);color:var(--rose);font-size:15px;font-weight:600;text-align:center;box-shadow:0 10px 28px oklch(20% .05 15 / .24);backdrop-filter:blur(12px);transition:.16s}
  .choice:hover{background:#fff;transform:scale(1.012)}
  .ending{position:absolute;inset:0;z-index:9;display:flex;align-items:center;justify-content:center;padding:24px;background:oklch(10% .02 15 / .38);backdrop-filter:blur(5px)}
  .ending[hidden]{display:none}
  .endCard{width:min(520px,92vw);padding:32px;border:1px solid oklch(100% 0 0 / .16);border-radius:28px;background:oklch(18% .02 15 / .78);color:oklch(98% .01 20);box-shadow:0 30px 80px oklch(5% 0 0 / .45);backdrop-filter:blur(28px) saturate(1.2);display:flex;flex-direction:column;gap:12px}
  .endKicker{font-size:11px;letter-spacing:.2em;color:oklch(88% .04 20 / .7)}
  .endCard h2{margin:0;font-family:var(--serif);font-size:32px;font-weight:600;letter-spacing:.04em}
  .endCard p{margin:0;font-size:14px;line-height:1.8;color:oklch(92% .01 20 / .78);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
  .endActions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .endActions button{padding:8px 14px;border-radius:999px;background:oklch(100% 0 0 / .12);color:oklch(98% .01 20);font-size:12.5px;font-weight:600;border:1px solid oklch(100% 0 0 / .14)}
  .endActions button:hover{background:oklch(100% 0 0 / .2)}
  .textbox{position:absolute;left:0;right:0;bottom:0;z-index:6;padding:44px 0 14px;background:linear-gradient(to top,var(--wine-a) 0%,var(--wine-a) 54%,var(--wine-b) 84%,transparent);cursor:pointer}
  .nameplate{position:absolute;top:-15px;left:max(4vw,calc((100% - min(72rem,90vw))/2));display:inline-flex;align-items:baseline;gap:10px;padding:6px 16px;border-radius:999px;background:oklch(99% .008 20 / .95);box-shadow:0 8px 22px oklch(18% .04 15 / .28);color:var(--rose)}
  .nameplate b{font-size:15px;font-weight:700;letter-spacing:.04em}
  .nameplate .sub{font-size:11px;color:var(--muted)}
  .nameplate .stance{margin-left:4px;padding:1px 8px;border-radius:999px;background:oklch(46% .08 12 / .1);font-size:10px;font-weight:600;color:var(--rose)}
  .dialogue{width:min(72rem,90vw);margin:0 auto}
  .line{margin:0;min-height:3.6em;font-size:clamp(17px,.55vw + 14px,21px);line-height:1.7;letter-spacing:.03em;color:#fff;text-shadow:0 2px 6px oklch(22% .05 15 / .55)}
  .cursor{display:inline-block;margin-left:6px;font-size:13px;opacity:.9;animation:nudge 1s infinite}
  @keyframes nudge{50%{transform:translateY(4px)}}
  .hud{display:flex;align-items:center;justify-content:flex-end;gap:2px;flex-wrap:wrap;width:min(82rem,94vw);margin:12px auto 0;cursor:default}
  .hud button{padding:4px 10px;border-radius:999px;color:oklch(96% .02 20 / .82);font-size:12px;font-weight:600;letter-spacing:.05em;transition:.15s}
  .hud button:hover,.hud button.on{background:oklch(100% 0 0 / .16);color:#fff}
  .hud .sep{width:1px;height:14px;margin:0 4px;background:oklch(100% 0 0 / .22)}
  .reply{display:flex;gap:8px;width:min(52rem,90vw);margin:0 auto 12px;cursor:default}
  .reply input{flex:1;min-width:0;padding:10px 16px;border-radius:999px;background:oklch(99% .008 20 / .95);color:oklch(32% .04 15);font-size:13.5px;outline:none}
  .reply button{padding:10px 18px;border-radius:999px;background:oklch(99% .008 20 / .95);color:var(--rose);font-size:12.5px;font-weight:600}

  /* ---------- 存档 / 画廊 ---------- */
  #gallery{background:var(--page);display:none;flex-direction:column;padding:26px clamp(16px,4vw,48px) 20px}
  #gallery.active{display:flex}
  .gallery-head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;padding-bottom:14px;border-bottom:1px solid oklch(80% .03 15 / .38);flex-wrap:wrap}
  .gallery-title{display:flex;align-items:baseline;gap:14px}
  .gallery-title h2{margin:0;font-family:var(--serif);font-size:28px;font-weight:600;letter-spacing:.08em;color:var(--rose)}
  .gallery-title .count{font-size:13px;color:var(--muted);letter-spacing:.06em}
  .tabs{display:flex;gap:4px;padding:3px;border-radius:999px;background:oklch(88% .02 15 / .5)}
  .tabs button{padding:6px 16px;border-radius:999px;font-size:13px;font-weight:600;color:var(--muted)}
  .tabs button.on{background:oklch(99% .006 20);color:var(--rose);box-shadow:0 2px 8px oklch(30% .04 15 / .1)}
  .gallery-tools{display:flex;gap:8px;flex-wrap:wrap}
  .ghost{padding:7px 16px;border-radius:999px;background:oklch(100% 0 0 / .7);border:1px solid oklch(80% .03 15 / .4);color:var(--rose);font-size:13px;font-weight:600;transition:.15s}
  .ghost:hover{background:#fff;transform:translateY(-1px)}
  .grid{flex:1;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:16px;padding:18px 0;min-height:0}
  .slot{display:flex;flex-direction:column;gap:8px;padding:10px;border:1.5px solid oklch(80% .03 15 / .4);border-radius:14px;background:oklch(99.4% .006 20);text-align:left;overflow:hidden;transition:.16s}
  .slot:hover{border-color:var(--accent);box-shadow:0 10px 24px oklch(30% .05 15 / .12);transform:translateY(-2px)}
  .slot .no{font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.05em}
  .slot .thumb{width:100%;aspect-ratio:16/9;border-radius:9px;background:oklch(90% .02 15);object-fit:cover;display:block}
  .slot .quote{font-size:12.5px;line-height:1.5;color:var(--ink);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.9em}
  .slot .foot{margin-top:auto;padding-top:6px;border-top:1px dashed oklch(80% .03 15 / .4);display:flex;justify-content:space-between;font-size:11px;color:var(--muted);gap:6px;white-space:nowrap;overflow:hidden}
  .slot .foot span:first-child{overflow:hidden;text-overflow:ellipsis;font-weight:600;color:var(--ink)}
  .slot.empty{border-style:dashed;background:oklch(96% .01 20 / .5);align-items:center;justify-content:center;color:oklch(58% .03 15 / .7);font-size:12px}
  .slot.empty b{font-family:var(--serif);font-size:22px;font-weight:500;opacity:.6}
  .gallery-foot{display:flex;justify-content:center;gap:20px;padding-top:12px;border-top:1px solid oklch(80% .03 15 / .38);flex-wrap:wrap}

  /* ---------- 覆盖层 ---------- */
  .overlay{position:fixed;inset:0;z-index:40;display:none;place-items:center;padding:20px;background:oklch(12% .02 15 / .52);backdrop-filter:blur(6px)}
  .overlay.open{display:grid}
  .log-card{width:min(640px,92vw);max-height:82vh;overflow-y:auto;padding:24px 28px;border-radius:20px;background:var(--page);color:var(--ink);box-shadow:0 24px 60px oklch(10% .02 15 / .35)}
  .log-card h3{margin:0 0 12px;font-family:var(--serif);font-size:20px;color:var(--rose)}
  .log-entry{padding:10px 0;border-bottom:1px dashed oklch(80% .03 15 / .4)}
  .log-entry strong{font-size:13px;color:var(--rose)}
  .log-entry p{margin:4px 0 0;font-size:14px;line-height:1.65}
  .toast{position:fixed;top:24px;left:50%;z-index:60;transform:translate(-50%,-8px);padding:9px 20px;border-radius:999px;background:oklch(99% .008 20 / .96);border:1px solid oklch(78% .06 12 / .5);color:var(--rose);font-size:13px;font-weight:600;box-shadow:0 10px 28px oklch(30% .05 15 / .2);opacity:0;pointer-events:none;transition:.22s}
  .toast.show{opacity:1;transform:translate(-50%,0)}

  @media (max-width:1024px){
    .grid{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:none;grid-auto-rows:min-content;overflow-y:auto}
    .title-wrap{flex-direction:column;align-items:flex-start;padding:26px 24px}
    .start-hint{top:52%}
  }
  @media (max-width:640px){
    .figure img{height:54vh;margin-bottom:24vh}
    .choices{bottom:25%;width:88vw}
    .dialogue,.reply{width:92vw}
    .line{font-size:16px}
    .textbox{padding-top:34px}
    .nameplate{left:16px}
    .chapter{left:16px;top:8%}
    .hud{justify-content:space-between;width:94vw}
    .hud .sep{display:none}
    .gallery{padding:16px}
    #gallery{padding:16px}
    .title-copy h1{font-size:2.1rem}
  }
  @media (prefers-reduced-motion:reduce){
    .start-hint,.cursor{animation:none}
    .bg,.figure img{transition:none}
  }
</style>
</head>
<body>
<canvas id="petals" aria-hidden="true"></canvas>

<section id="title" class="screen active" onclick="startGame()">
  <div class="cover" id="cover"></div>
  <div class="brand-foot">MIRAI · SELENE</div>
  <div class="start-hint" id="startHint">点 击 开 始<small>SPACE / ENTER</small></div>
  <div class="title-wrap">
    <div class="title-copy">
      <h1 id="titleText"></h1>
      <p class="sub" id="titleSub"></p>
    </div>
    <nav class="menu" onclick="event.stopPropagation()">
      <button onclick="startGame()">开始</button><span class="dot">·</span>
      <button onclick="continueGame()">继续</button><span class="dot">·</span>
      <button onclick="openGallery('load')">读取</button><span class="dot">·</span>
      <button onclick="openGallery('look')">世界线</button>
    </nav>
  </div>
</section>

<section id="stage" class="screen">
  <div class="bg" id="bgA"></div>
  <div class="bg" id="bgB"></div>
  <div class="figure"><img id="portrait" alt=""></div>
  <div class="chapter" id="chapter"></div>
  <div class="choices" id="choices" hidden></div>
  <div class="ending" id="ending" hidden>
    <div class="endCard">
      <span class="endKicker" id="endKicker">结局</span>
      <h2 id="endTitle"></h2>
      <p id="endText"></p>
      <div class="endActions">
        <button onclick="backToFork()">回到上一个分叉</button>
        <button onclick="openGallery('load')">读取存档</button>
        <button onclick="backToTitle()">返回标题</button>
      </div>
    </div>
  </div>
  <div class="textbox" onclick="advance()">
    <div class="nameplate">
      <b id="speaker"></b>
      <span class="sub" id="hint"></span>
      <span class="stance" id="stance" hidden></span>
    </div>
    <div class="dialogue">
      <p class="line"><span id="typed"></span><span class="cursor">▼</span></p>
    </div>
    <div class="hud" onclick="event.stopPropagation()">
      <button id="autoBtn" onclick="toggleAuto()">AUTO</button>
      <button onclick="openLog()">LOG</button>
      <button onclick="openGallery('save')">SAVE</button>
      <button onclick="openGallery('load')">LOAD</button>
      <button onclick="openGallery('look')">世界线</button>
      <span class="sep"></span>
      <button onclick="backToTitle()">TITLE</button>
    </div>
  </div>
</section>

<section id="gallery" class="screen">
  <header class="gallery-head">
    <div class="gallery-title"><h2>世界线</h2><span class="count" id="count"></span></div>
    <div class="tabs">
      <button id="tabSave" onclick="setMode('save')">保存</button>
      <button id="tabLoad" class="on" onclick="setMode('load')">读取</button>
      <button id="tabLook" onclick="setMode('look')">世界线</button>
    </div>
    <div class="gallery-tools">
      <button class="ghost" onclick="resumeGame()">回到游戏</button>
      <button class="ghost" onclick="backToTitle()">返回标题</button>
    </div>
  </header>
  <div class="grid" id="slots"></div>
  <footer class="gallery-foot">
    <button class="ghost" onclick="resumeGame()">继续</button>
    <button class="ghost" onclick="openGallery('load')">读取</button>
    <button class="ghost" onclick="backToTitle()">标题界面</button>
  </footer>
</section>

<div class="overlay" id="logOverlay" onclick="if(event.target===this)closeLog()">
  <div class="log-card">
    <h3>刚刚走过的对话</h3>
    <div id="logList"></div>
    <div style="margin-top:16px;text-align:right"><button class="ghost" onclick="closeLog()">合上记录</button></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const SPEC = ${json};
const API = window.MIRAI_API_BASE || ${JSON.stringify(apiBase)};
const NODES = Object.fromEntries(SPEC.logic_nodes.map(function (n) { return [n.id, n]; }));
const CAST = Object.fromEntries(SPEC.cast.map(function (c) { return [c.name, c]; }));
const STANCE = ${JSON.stringify(STANCE)};
const SAVE_KEY = 'mirai.selene.save.' + SPEC.id;
const LAST_KEY = SAVE_KEY + '.last';

let currentId = SPEC.entry;
let typeTimer = null;
let fullText = '';
let shownChars = 0;
let lastStance = null;
let autoMode = false;
let autoTimer = null;
let currentMode = 'load';
let backlog = [];
let bgFront = 0;
let checkpoints = [];
let ended = false;

function el(id) { return document.getElementById(id); }
function esc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function show(id) {
  document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('active'); });
  var target = el(id);
  if (target) target.classList.add('active');
  if (id !== 'stage') clearAuto();
}

function backgroundOf(node) {
  if (!node || !node.scene || !node.scene.background) return null;
  var asset = SPEC.assets_manifest.backgrounds[node.scene.background];
  return asset ? asset.path : null;
}

function portraitOf(node, stance) {
  var cast = CAST[node.speaker] || SPEC.cast[0];
  if (!cast) return '';
  var portrait = SPEC.assets_manifest.portraits[cast.portrait];
  if (!portrait) return '';
  var face = STANCE[stance || lastStance];
  var emotion = node.emotion || (face ? face.emotion : 'neutral');
  return (portrait.emotions && portrait.emotions[emotion]) || portrait.base || '';
}

function coverOf() {
  var entry = NODES[SPEC.entry];
  return (SPEC.assets_manifest.cover && SPEC.assets_manifest.cover.path) ||
    backgroundOf(entry) ||
    (SPEC.assets_manifest.portraits[(SPEC.cast[0] || {}).portrait] || {}).base || '';
}

function renderTitle() {
  el('cover').style.backgroundImage = coverOf() ? 'url("' + coverOf() + '")' : 'none';
  el('titleText').textContent = SPEC.title;
  el('titleSub').textContent = SPEC.subtitle || SPEC.logline || '';
  renderGallery();
}

function startGame() {
  checkpoints = [];
  show('stage');
  go(SPEC.entry, true);
}

function resumeGame() {
  show('stage');
  go(currentId, false);
}

function continueGame() {
  checkpoints = [];
  var last = null;
  try { last = localStorage.getItem(LAST_KEY); } catch (e) {}
  if (last && NODES[last]) { show('stage'); go(last, false); }
  else startGame();
}

function setBackground(node) {
  var path = backgroundOf(node);
  var cur = el(bgFront === 0 ? 'bgA' : 'bgB');
  var next = el(bgFront === 0 ? 'bgB' : 'bgA');
  next.style.backgroundImage = path ? 'url("' + path + '")' : 'none';
  next.style.opacity = '1';
  cur.style.opacity = '0';
  bgFront = 1 - bgFront;
}

function setPortrait(node, stance) {
  var img = el('portrait');
  var face = STANCE[stance || lastStance];
  img.dataset.emotion = node.emotion || (face ? face.emotion : 'neutral');
  img.classList.remove('in');
  void img.offsetWidth;
  img.src = portraitOf(node, stance);
  img.classList.add('in');
}

function flashChapter(node) {
  var chapter = el('chapter');
  chapter.textContent = (node.title || '') + (node.scene && node.scene.place ? '  ·  ' + node.scene.place : '');
  chapter.classList.add('show');
  window.setTimeout(function () { chapter.classList.remove('show'); }, 1800);
}

function go(id, push) {
  var node = NODES[id];
  if (!node) node = NODES[SPEC.entry];
  if (!node) return;
  currentId = node.id;
  hideEnding();
  clearAuto();
  setBackground(node);
  setPortrait(node, null);
  el('speaker').textContent = node.speaker || '旁白';
  var index = SPEC.logic_nodes.findIndex(function (n) { return n.id === node.id; });
  var hint = ['第 ' + (index + 1) + ' / ' + SPEC.logic_nodes.length + ' 幕', node.scene && node.scene.time, node.scene && node.scene.place].filter(Boolean).join(' · ');
  el('hint').textContent = hint;
  typeLine(node.text || '');
  renderChoices(node);
  flashChapter(node);
  askStance(node);
  if (push !== false) {
    backlog.push({ speaker: node.speaker || '旁白', text: node.text || '' });
    if (backlog.length > 60) backlog.shift();
    try { localStorage.setItem(LAST_KEY, node.id); } catch (e) {}
  }
}

function typeLine(text) {
  fullText = text || '';
  shownChars = 0;
  clearInterval(typeTimer);
  var elLine = el('typed');
  elLine.textContent = '';
  typeTimer = window.setInterval(function () {
    shownChars += 2;
    elLine.textContent = fullText.slice(0, shownChars);
    if (shownChars >= fullText.length) {
      clearInterval(typeTimer);
      scheduleAuto();
    }
  }, 22);
}

function scheduleAuto() {
  clearAuto();
  if (!autoMode) return;
  var node = NODES[currentId];
  if (node && node.choices && node.choices.length) return;
  autoTimer = window.setTimeout(function () { nextNode(); }, 1600);
}

function finishTyping() {
  shownChars = fullText.length;
  el('typed').textContent = fullText;
  clearInterval(typeTimer);
  scheduleAuto();
}

function advance() {
  if (shownChars < fullText.length) { finishTyping(); return; }
  var node = NODES[currentId];
  if (node && node.choices && node.choices.length) return;
  showEnding(node);
}

function nextNode() {
  var node = NODES[currentId];
  if (node && (!node.choices || !node.choices.length)) { showEnding(node); return; }
  var order = SPEC.logic_nodes;
  var index = order.findIndex(function (n) { return n.id === currentId; });
  var next = order[(index + 1) % order.length];
  show('stage');
  go(next.id, true);
}

function showEnding(node) {
  if (!node || ended) return;
  ended = true;
  clearAuto();
  var index = SPEC.logic_nodes.findIndex(function (n) { return n.id === node.id; });
  el('endKicker').textContent = '结局 · ' + (index + 1) + ' / ' + SPEC.logic_nodes.length;
  el('endTitle').textContent = node.title || '结局';
  el('endText').textContent = node.text || '';
  el('ending').hidden = false;
}

function hideEnding() {
  ended = false;
  var overlay = el('ending');
  if (overlay) overlay.hidden = true;
}

function backToFork() {
  if (!checkpoints.length) { toast('这里不是从分叉走来的'); return; }
  var id = checkpoints.pop();
  hideEnding();
  show('stage');
  go(id, false);
}

function renderChoices(node) {
  var box = el('choices');
  var choices = (node.choices || []);
  box.innerHTML = '';
  box.hidden = choices.length === 0;
  choices.forEach(function (choice) {
    var button = document.createElement('button');
    button.className = 'choice';
    button.textContent = choice.label;
    button.onclick = function (event) { event.stopPropagation(); checkpoints.push(currentId); hideEnding(); go(choice.to, true); };
    box.appendChild(button);
  });
}

/* ---------- PAI-SSM 姿态 ---------- */
function askStance(node) {
  var badge = el('stance');
  badge.hidden = true;
  if (!API) return;
  fetch(API + '/pai/step', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: node.text, parent_id: 'root' })
  }).then(function (res) { return res.ok ? res.json() : null; }).then(function (data) {
    if (!data || !data.ok || !data.stance) return;
    lastStance = data.stance;
    var face = STANCE[data.stance];
    badge.textContent = face ? face.label : data.stance;
    badge.hidden = false;
    setPortrait(NODES[currentId], data.stance);
  }).catch(function () { /* 桥没起就保持静态演出 */ });
}

/* ---------- AUTO / LOG ---------- */
function toggleAuto() {
  autoMode = !autoMode;
  el('autoBtn').classList.toggle('on', autoMode);
  clearAuto();
  if (autoMode) {
    var node = NODES[currentId];
    if (node && !(node.choices && node.choices.length)) {
      autoTimer = window.setTimeout(function () { nextNode(); }, 1800);
    }
    toast('AUTO 已开');
  } else {
    toast('AUTO 已关');
  }
}

function clearAuto() {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
}

function openLog() {
  var box = el('logList');
  box.innerHTML = backlog.map(function (item) {
    return '<div class="log-entry"><strong>' + esc(item.speaker) + '</strong><p>' + esc(item.text) + '</p></div>';
  }).join('') || '<p style="color:var(--muted)">还没有走过任何一句。</p>';
  el('logOverlay').classList.add('open');
}

function closeLog() { el('logOverlay').classList.remove('open'); }

function toast(message) {
  var node = el('toast');
  node.textContent = message;
  node.classList.add('show');
  window.setTimeout(function () { node.classList.remove('show'); }, 1800);
}

function backToTitle() {
  clearAuto();
  hideEnding();
  checkpoints = [];
  show('title');
  renderTitle();
}

/* ---------- 存档 ---------- */
function readSaves() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || '{}'); } catch (e) { return {}; }
}
function writeSaves(data) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) {}
}

function openGallery(mode) {
  hideEnding();
  currentMode = mode === 'save' ? 'save' : mode === 'look' ? 'look' : 'load';
  setMode(currentMode);
  show('gallery');
}

function setMode(mode) {
  currentMode = mode;
  ['tabSave', 'tabLoad', 'tabLook'].forEach(function (id) {
    el(id).classList.toggle('on', (id === 'tabSave' && mode === 'save') || (id === 'tabLoad' && mode === 'load') || (id === 'tabLook' && mode === 'look'));
  });
  renderGallery();
}

function renderGallery() {
  var box = el('slots');
  if (!box) return;
  box.innerHTML = '';
  var saves = readSaves();
  var slots = Array.from({ length: 10 }).map(function (_, index) {
    return saves['s' + index] || null;
  });

  if (currentMode === 'look') {
    // 世界线视图：直接列 Spec 的十幕
    SPEC.logic_nodes.slice(0, 10).forEach(function (node, index) {
      var slot = document.createElement('button');
      slot.className = 'slot';
      var bg = backgroundOf(node);
      slot.innerHTML = '<span class="no">No.' + String(index + 1).padStart(2, '0') + '</span>' +
        (bg ? '<img class="thumb" src="' + bg + '" alt="">' : '<div class="thumb"></div>') +
        '<span class="quote">' + esc((node.text || '').slice(0, 46)) + '</span>' +
        '<span class="foot"><span>' + esc(node.title || node.id) + '</span><span>' + esc((node.scene && node.scene.time) || '') + '</span></span>';
      slot.onclick = function () { show('stage'); go(node.id, true); };
      box.appendChild(slot);
    });
    el('count').textContent = String(SPEC.logic_nodes.length).padStart(3, '0') + ' / 010';
    return;
  }

  slots.forEach(function (save, index) {
    var node = save ? NODES[save.nodeId] : SPEC.logic_nodes[index];
    var bg = node ? backgroundOf(node) : null;
    var slot = document.createElement('button');
    if (!save && currentMode === 'load') {
      slot.className = 'slot empty';
      slot.innerHTML = '<span class="no">No.' + String(index + 1).padStart(2, '0') + '</span><b>空</b><span>空存档</span>';
      slot.onclick = function () { toast('这个位置还没有存档'); };
    } else {
      slot.className = 'slot';
      slot.innerHTML = '<span class="no">No.' + String(index + 1).padStart(2, '0') + '</span>' +
        (bg ? '<img class="thumb" src="' + bg + '" alt="">' : '<div class="thumb"></div>') +
        '<span class="quote">' + esc(((save && save.text) || (node && node.text) || '').slice(0, 46)) + '</span>' +
        '<span class="foot"><span>' + esc((save && save.title) || (node && node.title) || '未命名') + '</span><span>' + esc((save && save.time) || '') + '</span></span>';
      slot.onclick = function () {
        if (currentMode === 'save') saveSlot(index);
        else if (save) loadSlot(save);
      };
    }
    box.appendChild(slot);
  });
  el('count').textContent = '010 / 010';
}

function saveSlot(index) {
  var node = NODES[currentId];
  if (!node) return;
  var saves = readSaves();
  saves['s' + index] = {
    nodeId: currentId,
    title: node.title || node.id,
    text: node.text || '',
    time: new Date().toLocaleString('zh-CN', { hour12: false })
  };
  writeSaves(saves);
  toast('已存到 No.' + String(index + 1).padStart(2, '0'));
  renderGallery();
}

function loadSlot(save) {
  if (!save || !NODES[save.nodeId]) { toast('这个存档对不上当前世界'); return; }
  checkpoints = [];
  show('stage');
  go(save.nodeId, false);
  toast('读取「' + save.title + '」');
}

/* ---------- 开场：花瓣 ---------- */
(function petals() {
  var canvas = el('petals');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var items = [];
  var count = window.innerWidth < 640 ? 18 : 36;

  function resize() {
    canvas.width = window.innerWidth * window.devicePixelRatio;
    canvas.height = window.innerHeight * window.devicePixelRatio;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  for (var i = 0; i < count; i += 1) {
    items.push({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      r: 2 + Math.random() * 4,
      vy: 0.2 + Math.random() * 0.5,
      vx: -0.2 + Math.random() * 0.4,
      a: 0.12 + Math.random() * 0.3,
      phase: Math.random() * Math.PI * 2
    });
  }

  function frame() {
    var title = el('title');
    var active = title && title.classList.contains('active');
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (active) {
      items.forEach(function (p) {
        p.y += p.vy;
        p.x += p.vx + Math.sin(p.phase + p.y * 0.01) * 0.2;
        if (p.y > window.innerHeight + 10) { p.y = -10; p.x = Math.random() * window.innerWidth; }
        ctx.beginPath();
        ctx.fillStyle = 'rgba(255, 240, 245, ' + p.a + ')';
        ctx.ellipse(p.x, p.y, p.r, p.r * 0.6, p.phase, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    requestAnimationFrame(frame);
  }
  frame();
})();

/* ---------- 键盘 ---------- */
document.addEventListener('keydown', function (event) {
  if (event.code === 'Escape') {
    if (el('logOverlay').classList.contains('open')) { closeLog(); return; }
    backToTitle();
    return;
  }
  if (event.code === 'Space' || event.code === 'Enter') {
    if (el('title').classList.contains('active')) { event.preventDefault(); startGame(); return; }
    if (el('stage').classList.contains('active')) { event.preventDefault(); advance(); }
  }
});

renderTitle();
</script>
</body>
</html>`;
}
