import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const root = new URL('../dist/angular/browser/', import.meta.url);
const [polyfillsPath, mainPath, stylesPath] = ['polyfills.js', 'main.js', 'styles.css'].map((name) => new URL(name, root));
const [polyfillsSource, styles] = await Promise.all([
  readFile(polyfillsPath, 'utf8'),
  readFile(stylesPath, 'utf8'),
]);

async function bundle(entryPoint) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    legalComments: 'none',
    minify: true,
  });
  return result.outputFiles[0].text;
}

const [polyfills, application] = await Promise.all([
  bundle(polyfillsPath.pathname),
  bundle(mainPath.pathname),
]);
const metadata = `// ==UserScript==
// @name         Erome video duration controls
// @namespace    https://github.com/drdre1/
// @icon         https://www.erome.com/favicon.ico
// @version      2.0.0
// @description  Display video durations and filter Erome albums with a modular Angular control panel
// @author       drdre1
// @match        https://www.erome.com/*
// @connect      erome.com
// @connect      *.erome.com
// @noframes
// @grant        GM.xmlHttpRequest
// @run-at       document-end
// ==/UserScript==
`;
const styleInjector = `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(styles)};(document.head||document.documentElement).appendChild(s)})();\n`;
const userscript = `${metadata}\n${styleInjector}${polyfills}\n${application}`.trimEnd() + '\n';
await writeFile(new URL('../erome.user.js', import.meta.url), userscript);
console.log('Built installable Angular userscript: erome.user.js');
