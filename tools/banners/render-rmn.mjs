// Renders the Resistance Media News banner templates (wordmark design; swap
// in their logo later by adding it as tools/banners/rmn-logo.png).
//   node tools/banners/render-rmn.mjs   -> server/channels/banners/rmn/*.jpg
// Needs Playwright: npm i -g playwright (or set PLAYWRIGHT_PATH to its folder).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = (await import(process.env.PLAYWRIGHT_PATH ? `file://${process.env.PLAYWRIGHT_PATH}/index.mjs` : 'playwright')).default ?? (await import('playwright'));
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../server/channels/banners/rmn');
const logoFile = path.join(here, 'rmn-logo.png');
const logo = fs.existsSync(logoFile) ? `data:image/png;base64,${fs.readFileSync(logoFile).toString('base64')}` : null;

export const VARIANTS = [
  { file: 'breaking.jpg', chip: '● LIVE', label: 'BREAKING ALERT' },
  { file: 'urgent.jpg', chip: 'URGENT', label: 'JUST IN' },
  { file: 'live.jpg', chip: '● LIVE', label: 'LIVE COVERAGE' },
  { file: 'developing.jpg', chip: '● LIVE', label: 'DEVELOPING STORY' },
  { file: 'statement.jpg', chip: 'OFFICIAL', label: 'STATEMENT' },
  { file: 'update.jpg', chip: 'UPDATE', label: 'LATEST DEVELOPMENTS' },
  { file: 'alert.jpg', chip: '⚠ ALERT', label: 'SECURITY ALERT' },
  { file: 'summary.jpg', chip: 'DAILY', label: 'NEWS ROUNDUP' },
];

const html = ({ chip, label }) => `<!doctype html><html><head><style>
  html,body{margin:0}
  .c{position:relative;width:1600px;height:900px;overflow:hidden;font-family:'Inter Display','Inter',sans-serif;color:#fff;
     background:radial-gradient(ellipse 70% 90% at 78% 45%,#3a0a0a 0%,#1a0505 45%,#0b0b0d 80%)}
  .grid{position:absolute;inset:0;opacity:.18;
     background-image:radial-gradient(circle,#ff5a4a 1.2px,transparent 1.6px);background-size:22px 22px;
     -webkit-mask-image:radial-gradient(ellipse 60% 70% at 75% 50%,#000 20%,transparent 75%)}
  .ring{position:absolute;right:-180px;top:50%;width:900px;height:900px;margin-top:-450px;border-radius:50%;
     border:2px solid rgba(255,70,50,.35);box-shadow:0 0 120px rgba(220,30,20,.35) inset}
  .ring.r2{width:700px;height:700px;margin-top:-350px;right:-80px;border-color:rgba(255,70,50,.22)}
  .stripe{position:absolute;left:0;right:0;top:618px;height:3px;background:linear-gradient(90deg,transparent,#e3241b 20%,#e3241b 80%,transparent);opacity:.8}
  .brand{position:absolute;left:120px;top:210px;display:flex;align-items:center;gap:44px}
  .mono{width:200px;height:200px;border-radius:50%;border:6px solid #fff;display:flex;align-items:center;justify-content:center;
     background:linear-gradient(160deg,#e3241b,#8e0e09);box-shadow:0 10px 40px rgba(0,0,0,.5);font-weight:900;font-size:78px;letter-spacing:-2px}
  .mono img{width:100%;height:100%;object-fit:cover;border-radius:50%}
  .name{font-weight:900;line-height:.95;letter-spacing:-1px}
  .name .l1{font-size:104px}
  .name .l2{font-size:104px;color:#ff3b2f}
  .bar{position:absolute;left:120px;top:560px;height:96px;display:flex}
  .chip,.box{display:flex;align-items:center;justify-content:center;height:100%}
  .chip{background:#e3241b;width:270px}
  .box{background:#fff;color:#111;width:760px}
  .chip span,.box span{display:inline-block;white-space:nowrap;font-weight:900;letter-spacing:1px}
  .chip span{font-size:var(--cs,54px)}
  .box span{font-size:var(--fs)}
  .foot{position:absolute;left:122px;top:700px;font-size:30px;font-weight:600;letter-spacing:6px;opacity:.85}
</style></head><body><div class="c"><div class="grid"></div><div class="ring"></div><div class="ring r2"></div><div class="stripe"></div>
  <div class="brand"><div class="mono">${logo ? `<img src="${logo}">` : 'RMN'}</div>
    <div class="name"><div class="l1">RESISTANCE</div><div class="l2">MEDIA NEWS</div></div></div>
  <div class="bar"><div class="chip"><span>${chip}</span></div><div class="box"><span>${label}</span></div></div>
  <div class="foot">@RESISTANCEMEDIANEWS</div>
</div><script>{
  const fit = (el, prop, start, max) => { let fs = start; el.style.setProperty(prop, fs + 'px');
    while (el.offsetWidth > max && fs > 28) { fs -= 2; el.style.setProperty(prop, fs + 'px'); } };
  fit(document.querySelector('.box span'), '--fs', 64, 690);
  fit(document.querySelector('.chip span'), '--cs', 54, 230);
}</script></body></html>`;

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
fs.mkdirSync(out, { recursive: true });
for (const v of VARIANTS) {
  await page.setContent(html(v));
  await page.waitForTimeout(150);
  await page.locator('.c').screenshot({ path: path.join(out, v.file), type: 'jpeg', quality: 90 });
  console.log(`wrote ${v.file}`);
}
await browser.close();
