const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
(async () => {
 const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
 try {
  for(const theme of ['wii','oled','appletv','retro','nord','win95','xp','invalid']) {
   const page=await browser.newPage();
   await page.addInitScript(t=>localStorage.setItem('dizen.theme',t),theme);
   // The initial appearance must not depend on main.js or Samsung's Web APIs.
   await page.route('**/js/main.js*',r=>r.abort());
   await page.route('**/*webapis.js',r=>r.abort());
   await page.goto(pathToFileURL(path.resolve(__dirname,'../launcher/index.html')).href);
   assert.equal(await page.locator('html').getAttribute('data-theme'),theme==='invalid'?'dizen':theme);
   if(theme==='wii') assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()),'#f6f6f6');
   await page.close();
  }
  console.log('PASS: saved theme and variables applied without main.js/Web APIs; invalid theme falls back');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
