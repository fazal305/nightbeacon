// Renders the r3syst banner templates from the channel's base artwork:
// the "LIVE | BREAKING NEWS" bar is redrawn with each label.
//   node tools/banners/render.mjs            -> server/channels/banners/r3syst/*.jpg
// Needs Playwright: npm i -g playwright (or set PLAYWRIGHT_PATH to its folder).
const { chromium } = (await import(process.env.PLAYWRIGHT_PATH ? `file://${process.env.PLAYWRIGHT_PATH}/index.mjs` : 'playwright')).default ?? (await import('playwright'));
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../server/channels/banners/r3syst');
const base = fs.readFileSync(path.join(here, 'r3syst-base.webp')).toString('base64');

export const VARIANTS = [
  { file: 'breaking.jpg', chip: '● LIVE', label: 'BREAKING NEWS' },
  { file: 'urgent.jpg', chip: 'URGENT', label: 'JUST IN' },
  { file: 'live.jpg', chip: '● LIVE', label: 'LIVE COVERAGE' },
  { file: 'developing.jpg', chip: '● LIVE', label: 'DEVELOPING STORY' },
  { file: 'statement.jpg', chip: 'OFFICIAL', label: 'STATEMENT' },
  { file: 'update.jpg', chip: 'UPDATE', label: 'LATEST DEVELOPMENTS' },
  { file: 'alert.jpg', chip: '⚠ ALERT', label: 'SECURITY ALERT' },
  { file: 'summary.jpg', chip: 'DAILY', label: 'NEWS SUMMARY' },
];

const html = ({ chip, label }) => `<!doctype html><html><head><style>
  html,body{margin:0;padding:0}
  .c{position:relative;width:1672px;height:941px;background:url(data:image/webp;base64,${base}) 0 0/1672px 941px;overflow:hidden;
     font-family:'Inter Display','Inter',sans-serif;font-style:italic;font-weight:900;color:#fff}
  /* soft red wash hides the original bar's glow before the new one is drawn */
  .wash{position:absolute;left:360px;top:548px;width:940px;height:116px;
     background:radial-gradient(ellipse at center,#9e0606 0%,#8a0505 55%,rgba(138,5,5,0) 78%);filter:blur(4px)}
  .bar{position:absolute;left:388px;top:562px;height:90px;display:flex;align-items:stretch}
  .chip,.box{display:flex;align-items:center;justify-content:center;transform:skewX(-18deg);height:100%}
  .chip{box-sizing:border-box;background:linear-gradient(180deg,#ff1a12,#d10a05);width:280px;box-shadow:0 6px 18px rgba(0,0,0,.35)}
  .box{margin-left:-6px;background:linear-gradient(180deg,rgba(120,0,0,.96),rgba(78,0,0,.96));border:3px solid rgba(255,255,255,.92);
     box-sizing:border-box;width:610px;box-shadow:0 6px 22px rgba(0,0,0,.4)}
  .chip span,.box span{display:inline-block;flex:none;transform:skewX(18deg);white-space:nowrap;letter-spacing:.5px}
  .chip span{font-size:var(--cs,56px)}
  .box span{font-size:var(--fs)}
</style></head><body><div class="c"><div class="wash"></div>
  <div class="bar"><div class="chip"><span>${chip}</span></div><div class="box"><span>${label}</span></div></div>
</div><script>
  // shrink long labels to fit the box (in a block: setContent reuses the page's script scope)
  {
  const fit = (el, prop, start, max) => { let fs = start; el.style.setProperty(prop, fs + 'px');
    while (el.offsetWidth > max && fs > 28) { fs -= 2; el.style.setProperty(prop, fs + 'px'); } };
  fit(document.querySelector('.box span'), '--fs', 64, 520);
  fit(document.querySelector('.chip span'), '--cs', 56, 220);
  }
</script></body></html>`;

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1672, height: 941 } });
fs.mkdirSync(out, { recursive: true });
for (const v of VARIANTS) {
  await page.setContent(html(v));
  await page.waitForTimeout(150);
  await page.locator('.c').screenshot({ path: path.join(out, v.file), type: 'jpeg', quality: 90 });
  console.log(`wrote ${v.file}`);
}
await browser.close();
