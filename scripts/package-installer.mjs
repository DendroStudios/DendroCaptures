// Renames the Tauri NSIS installer to DendroCaptureInstaller_v{version}.exe
// and drops it in dist-installer/. Run via: npm run build:installer
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version;
const nsisDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');

// The bundle folder accumulates installers from older versions; match the
// current version exactly so a stale build can never be shipped by mistake.
const setup = readdirSync(nsisDir).find(
  (name) => name.includes(`_${version}_`) && name.endsWith('-setup.exe'),
);
if (!setup) {
  console.error(`No NSIS installer for version ${version} found in ${nsisDir}. Run "npm run build" first.`);
  process.exit(1);
}

const outDir = join(root, 'dist-installer');
mkdirSync(outDir, { recursive: true });
const target = join(outDir, `DendroCaptureInstaller_v${version}.exe`);
copyFileSync(join(nsisDir, setup), target);
console.log(`Installer ready: ${target}`);
