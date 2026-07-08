// Prepares public/ to be servable as a fully static site (Netlify) and keeps
// the PC server's vendor assets in sync. Runs on npm install (postinstall)
// and as the Netlify build command.
//   1. Copies xterm.js dist files from node_modules into public/vendor/.
//   2. Writes public/env.js from CLERK_PUBLISHABLE_KEY and BACKEND_URL env
//      vars (both empty locally — the PC server serves /env.js dynamically
//      and shadows the static file).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');

const copies = [
  ['node_modules/@xterm/xterm/css/xterm.css', 'vendor/xterm/css/xterm.css'],
  ['node_modules/@xterm/xterm/lib/xterm.js', 'vendor/xterm/lib/xterm.js'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'vendor/addon-fit/lib/addon-fit.js'],
];

for (const [src, dest] of copies) {
  const from = path.join(root, src);
  const to = path.join(pub, dest);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

const env = {
  CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY || null,
  BACKEND_URL: process.env.BACKEND_URL || '',
};
fs.writeFileSync(path.join(pub, 'env.js'), `window.ENV=${JSON.stringify(env)};\n`);

console.log(`build-static: vendor copied; env.js written (clerk: ${env.CLERK_PUBLISHABLE_KEY ? 'yes' : 'no'}, backend: ${env.BACKEND_URL || 'same-origin'})`);
