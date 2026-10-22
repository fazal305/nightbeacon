// Renders each bot channel's banner set around its own logo:
//   node tools/banners/render-logo-banners.mjs           both channels
//   node tools/banners/render-logo-banners.mjs rmn       one channel
// Output: server/channels/banners/<channel>/*.jpg (what banners.js uses).
// Logos: tools/banners/r3syst-logo.png and rmn-logo.png (transparent PNGs).
// Needs Playwright: npm i -g playwright (or set PLAYWRIGHT_PATH to its folder).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = (await import(process.env.PLAYWRIGHT_PATH ? `file://${process.env.PLAYWRIGHT_PATH}/index.mjs` : 'playwright')).default ?? (await import('playwright'));
const here = path.dirname(fileURLToPath(import.meta.url));
const img = (f) => `data:image/png;base64,${fs.readFileSync(path.join(here, f)).toString('base64')}`;

const LABELS = {
  r3syst: [
    ['breaking.jpg', '● LIVE', 'BREAKING NEWS'], ['urgent.jpg', 'URGENT', 'JUST IN'], ['live.jpg', '● LIVE', 'LIVE COVERAGE'],
    ['developing.jpg', '● LIVE', 'DEVELOPING STORY'], ['statement.jpg', 'OFFICIAL', 'STATEMENT'], ['update.jpg', 'UPDATE', 'LATEST DEVELOPMENTS'],
    ['alert.jpg', '⚠ ALERT', 'SECURITY ALERT'], ['summary.jpg', 'DAILY', 'NEWS SUMMARY'],
  ],
  rmn: [
    ['breaking.jpg', '● LIVE', 'BREAKING ALERT'], ['urgent.jpg', 'URGENT', 'JUST IN'], ['live.jpg', '● LIVE', 'LIVE COVERAGE'],
    ['developing.jpg', '● LIVE', 'DEVELOPING STORY'], ['statement.jpg', 'OFFICIAL', 'STATEMENT'], ['update.jpg', 'UPDATE', 'LATEST DEVELOPMENTS'],
    ['alert.jpg', '⚠ ALERT', 'SECURITY ALERT'], ['summary.jpg', 'DAILY', 'NEWS ROUNDUP'],
  ],
};

const FIT = `<script>{
  const fit = (el, prop, start, max) => { let fs = start; el.style.setProperty(prop, fs + 'px');
    while (el.offsetWidth > max && fs > 28) { fs -= 2; el.style.setProperty(prop, fs + 'px'); } };
  fit(document.querySelector('.box span'), '--fs', 66, document.querySelector('.box').clientWidth - 70);
  fit(document.querySelector('.chip span'), '--cs', 54, document.querySelector('.chip').clientWidth - 40);
}</script>`;

// R3SYST: green missile logo on black, green accents.
const r3syst = (logo) => ([, chip, label]) => `<!doctype html><html><head><style>
  html,body{margin:0}
  .c{position:relative;width:1600px;height:900px;overflow:hidden;font-family:'Inter Display','Inter',sans-serif;color:#fff;
     background:radial-gradient(ellipse 65% 70% at 50% 38%,#06301a 0%,#03140b 45%,#000 80%)}
  .grid{position:absolute;inset:0;opacity:.22;background-image:linear-gradient(#1ed760 1px,transparent 1px),linear-gradient(90deg,#1ed760 1px,transparent 1px);
     background-size:56px 56px;-webkit-mask-image:radial-gradient(ellipse 60% 55% at 50% 40%,#000 10%,transparent 70%)}
  .scan{position:absolute;left:0;right:0;top:604px;height:3px;background:linear-gradient(90deg,transparent,#1ed760 25%,#1ed760 75%,transparent);opacity:.9;box-shadow:0 0 18px #1ed760}
  .logo{position:absolute;left:50%;top:-40px;width:780px;margin-left:-390px;filter:drop-shadow(0 0 22px rgba(30,215,96,.45))}
  .bar{position:absolute;left:50%;top:640px;transform:translateX(-50%);height:96px;display:flex}
  .chip,.box{display:flex;align-items:center;justify-content:center;height:100%;transform:skewX(-14deg)}
  .chip{background:#1ed760;color:#02140a;width:270px}
  .box{background:rgba(0,0,0,.75);border:3px solid #1ed760;width:720px;margin-left:-3px}
  .chip span,.box span{display:inline-block;white-space:nowrap;font-weight:900;font-style:italic;letter-spacing:1px;transform:skewX(14deg)}
  .chip span{font-size:var(--cs,54px)} .box span{font-size:var(--fs)}
  .foot{position:absolute;left:0;right:0;top:772px;text-align:center;font-size:26px;font-weight:600;letter-spacing:9px;color:#9ff5c2;opacity:.85}
</style></head><body><div class="c"><div class="grid"></div><div class="scan"></div><img class="logo" src="${logo}">
  <div class="bar"><div class="chip"><span>${chip}</span></div><div class="box"><span>${label}</span></div></div>
  <div class="foot">REAL TIME &nbsp;/&nbsp; TRUSTED &nbsp;/&nbsp; ALWAYS ON &nbsp;·&nbsp; @R3SYST</div>
</div>${FIT}</body></html>`;

// Resistance Media News: their badge on dark, yellow accents.
const rmn = (logo) => ([, chip, label]) => `<!doctype html><html><head><style>
  html,body{margin:0}
  .c{position:relative;width:1600px;height:900px;overflow:hidden;font-family:'Inter Display','Inter',sans-serif;color:#fff;
     background:radial-gradient(ellipse 60% 80% at 22% 45%,#2b2410 0%,#15130c 45%,#0b0b0d 80%)}
  .ring{position:absolute;left:40px;top:50%;width:640px;height:640px;margin-top:-330px;border-radius:50%;border:2px solid rgba(245,184,0,.25);box-shadow:0 0 120px rgba(245,184,0,.15) inset}
  .stripe{position:absolute;left:690px;right:0;top:638px;height:3px;background:linear-gradient(90deg,#f5b800,#f5b800 70%,transparent);opacity:.8}
  .logo{position:absolute;left:35px;top:125px;width:650px}
  .name{position:absolute;left:690px;top:215px;font-weight:900;line-height:.95;letter-spacing:-1px}
  .name .l1{font-size:110px} .name .l2{font-size:110px;color:#f5b800}
  .bar{position:absolute;left:690px;top:515px;height:96px;display:flex}
  .chip,.box{display:flex;align-items:center;justify-content:center;height:100%}
  .chip{background:#f5b800;color:#111;width:250px}
  .box{background:#fff;color:#111;width:560px}
  .chip span,.box span{display:inline-block;white-space:nowrap;font-weight:900;letter-spacing:1px}
  .chip span{font-size:var(--cs,52px)} .box span{font-size:var(--fs)}
  .foot{position:absolute;left:692px;top:665px;font-size:28px;font-weight:600;letter-spacing:6px;opacity:.85}
</style></head><body><div class="c"><div class="ring"></div><div class="stripe"></div><img class="logo" src="${logo}">
  <div class="name"><div class="l1">RESISTANCE</div><div class="l2">MEDIA NEWS</div></div>
  <div class="bar"><div class="chip"><span>${chip}</span></div><div class="box"><span>${label}</span></div></div>
  <div class="foot">@RESISTANCEMEDIANEWS</div>
</div>${FIT}</body></html>`;

const DESIGNS = { r3syst: r3syst(img('r3syst-logo.png')), rmn: rmn(img('rmn-logo.png')) };
const only = process.argv[2];
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
for (const [key, design] of Object.entries(DESIGNS)) {
  if (only && only !== key) continue;
  const out = path.resolve(here, `../../server/channels/banners/${key}`);
  fs.mkdirSync(out, { recursive: true });
  for (const v of LABELS[key]) {
    await page.setContent(design(v));
    await page.waitForTimeout(150);
    await page.locator('.c').screenshot({ path: path.join(out, v[0]), type: 'jpeg', quality: 90 });
  }
  console.log(`${key}: ${LABELS[key].length} banners`);
}
await browser.close();
