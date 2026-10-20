// make-fixtures.js — generates the fictional demo images in tests/fixtures/ by drawing them on a canvas
// in headless Chromium. Run once:  NODE_PATH=<folder with @playwright/test> node tests/make-fixtures.js
//   harbor-point.jpg  ~3000×2000 synthetic gradient landscape with the fictional Harbor Point lighthouse (~3 MB)
//   demo-logo.png     small transparent logo for the background-colour case
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out = await page.evaluate(async () => {
    function rand(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }
    const r = rand(42);
    const W = 3000, H = 2000;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    // sky
    const sky = g.createLinearGradient(0, 0, 0, H * 0.6);
    sky.addColorStop(0, '#1d3b72'); sky.addColorStop(0.55, '#e98a5c'); sky.addColorStop(1, '#f7d39a');
    g.fillStyle = sky; g.fillRect(0, 0, W, H * 0.6);
    // sun
    const sun = g.createRadialGradient(2100, 1080, 10, 2100, 1080, 420);
    sun.addColorStop(0, 'rgba(255,240,200,1)'); sun.addColorStop(1, 'rgba(255,200,140,0)');
    g.fillStyle = sun; g.fillRect(0, 0, W, H);
    // clouds
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgba(255,${200 + r() * 55 | 0},${180 + r() * 60 | 0},${0.08 + r() * 0.15})`;
      g.beginPath(); g.ellipse(r() * W, r() * H * 0.45, 120 + r() * 300, 20 + r() * 50, 0, 0, Math.PI * 2); g.fill();
    }
    // sea
    const sea = g.createLinearGradient(0, H * 0.6, 0, H);
    sea.addColorStop(0, '#2f6c8f'); sea.addColorStop(1, '#0d2a40');
    g.fillStyle = sea; g.fillRect(0, H * 0.6, W, H * 0.4);
    for (let i = 0; i < 2500; i++) {
      const y = H * 0.6 + r() * H * 0.4;
      g.strokeStyle = `rgba(255,${210 + r() * 40 | 0},${170 + r() * 60 | 0},${0.05 + r() * 0.25})`;
      g.lineWidth = 1 + r() * 3;
      const x = r() * W; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 20 + r() * 80, y); g.stroke();
    }
    // headland
    g.fillStyle = '#3b3328';
    g.beginPath(); g.moveTo(0, H * 0.62);
    for (let x = 0; x <= 1300; x += 20) g.lineTo(x, H * 0.5 + Math.sin(x / 140) * 30 + r() * 18 + (x > 900 ? (x - 900) * 0.35 : 0));
    g.lineTo(1300, H * 0.66); g.lineTo(0, H * 0.7); g.closePath(); g.fill();
    // grass texture
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = `rgba(${60 + r() * 60 | 0},${90 + r() * 70 | 0},${40 + r() * 30 | 0},0.6)`;
      g.fillRect(r() * 1200, H * 0.5 + r() * H * 0.18, 2 + r() * 4, 2 + r() * 8);
    }
    // lighthouse
    const lx = 620, base = H * 0.52;
    g.fillStyle = '#f4f1ea';
    g.beginPath(); g.moveTo(lx - 70, base); g.lineTo(lx - 42, base - 560); g.lineTo(lx + 42, base - 560); g.lineTo(lx + 70, base); g.closePath(); g.fill();
    g.fillStyle = '#c0392b';
    for (let k = 0; k < 3; k++) { const y = base - 120 - k * 170; g.fillRect(lx - 66 + k * 8, y, 132 - k * 16, 60); }
    g.fillStyle = '#222'; g.fillRect(lx - 60, base - 600, 120, 40);
    g.fillStyle = '#ffe9a8'; g.fillRect(lx - 40, base - 680, 80, 80);
    g.fillStyle = '#c0392b'; g.beginPath(); g.moveTo(lx - 60, base - 680); g.lineTo(lx, base - 740); g.lineTo(lx + 60, base - 680); g.fill();
    const beam = g.createLinearGradient(lx, 0, lx + 1400, 0);
    beam.addColorStop(0, 'rgba(255,240,180,0.45)'); beam.addColorStop(1, 'rgba(255,240,180,0)');
    g.fillStyle = beam; g.beginPath(); g.moveTo(lx, base - 640); g.lineTo(lx + 1400, base - 820); g.lineTo(lx + 1400, base - 520); g.fill();
    // sign
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = 'bold 72px sans-serif';
    g.fillText('HARBOR POINT', 1900, 1900);
    // film grain so the JPEG is photo-sized
    const img = g.getImageData(0, 0, W, H); const d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 34; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    g.putImageData(img, 0, 0);
    const toB64 = (blob) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
    const photo = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.94));

    const l = document.createElement('canvas'); l.width = 240; l.height = 240;
    const lg = l.getContext('2d');
    lg.fillStyle = '#5b4bdb'; lg.beginPath(); lg.arc(120, 120, 100, 0, Math.PI * 2); lg.fill();
    lg.fillStyle = '#ffffff'; lg.font = 'bold 72px sans-serif'; lg.textAlign = 'center'; lg.textBaseline = 'middle'; lg.fillText('DL', 120, 124);
    const logo = await new Promise((res) => l.toBlob(res, 'image/png'));
    return { photo: await toB64(photo), logo: await toB64(logo) };
  });
  const dir = path.join(__dirname, 'fixtures');
  fs.writeFileSync(path.join(dir, 'harbor-point.jpg'), Buffer.from(out.photo, 'base64'));
  fs.writeFileSync(path.join(dir, 'demo-logo.png'), Buffer.from(out.logo, 'base64'));
  console.log('harbor-point.jpg', fs.statSync(path.join(dir, 'harbor-point.jpg')).size, 'demo-logo.png', fs.statSync(path.join(dir, 'demo-logo.png')).size);
  await browser.close();
})();
