// Checks that sw.js precaches exactly the app's files. A listed file that is
// missing breaks the offline install; a file that isn't listed won't work offline.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sw = readFileSync(`${ROOT}/sw.js`, 'utf8');
const block = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
if (!block) {
  console.error('Could not find the PRECACHE list in sw.js');
  process.exit(1);
}
const listed = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

const walk = (dir) => readdirSync(`${ROOT}/${dir}`, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]));
const shipped = ['index.html', 'manifest.webmanifest', ...['css', 'js', 'vendor', 'icons'].flatMap(walk)];

const problems = [
  ...listed.filter((p) => !existsSync(`${ROOT}/${p}`)).map((p) => `listed in PRECACHE but missing: ${p}`),
  ...shipped.filter((p) => !listed.includes(p)).map((p) => `not in PRECACHE (won't work offline): ${p}`),
  ...listed.filter((p, i) => listed.indexOf(p) !== i).map((p) => `listed twice: ${p}`),
];

if (problems.length) {
  problems.forEach((p) => console.error(`✖ ${p}`));
  process.exit(1);
}
console.log(`✔ sw.js precaches all ${listed.length} app files`);
