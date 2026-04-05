import * as esbuild from 'esbuild';
import { analyzeMetafile } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import sass from 'sass';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '.');

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Remove .DS_Store (same as original)
function removeDSStore(dir) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      removeDSStore(filePath);
    } else if (file === '.DS_Store') {
      fs.unlinkSync(filePath);
    }
  });
}

// Recursive copy (replaces CopyPlugin)
function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (let entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

const args = process.argv.slice(2);
const browser = args[0] || 'chrome';
const disableBundleInsights = true;
const isProduction = args[1] === 'production' || args.includes('--mode=production');
const isWatch = args.includes('--watch');

const isFirefox = browser === 'firefox';
const isSafari = browser === 'safari';
const outputDirName = isProduction
  ? (isFirefox ? 'dist_firefox' : isSafari ? 'dist_safari' : 'dist')
  : (isFirefox ? 'dev_firefox' : isSafari ? 'dev_safari' : 'dev');
const outputDir = path.resolve(root, outputDirName);
const browserName = isFirefox ? 'firefox' : (isSafari ? 'safari' : 'chrome');

console.log(`🚀 Building for ${browserName} (${isProduction ? 'production' : 'development'}) → ${outputDirName}`);

// Clean output
if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

// JS/TS entries (exact same as webpack)
const jsEntries = {
  popup: './src/core/popup.ts',
  settings: './src/core/settings.ts',
  content: './src/content.ts',
  background: './src/background.ts',
  'reader-script': './src/reader-script.ts',
};

// SCSS files (compiled separately with sass)
const scssFiles = {
  style: './src/style.scss',
  highlighter: './src/highlighter.scss',
  reader: './src/reader.scss',
};

const esbuildOptions = {
  entryPoints: jsEntries,
  outdir: outputDir,
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',                    // matches original non-module script behavior
  sourcemap: !isProduction,
  minify: isProduction,
  metafile: true,
  define: {
    'DEBUG_MODE': JSON.stringify(!isProduction),
    'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development'),
  },
  logLevel: 'info',
};

async function mainBuild() {
  // 1. Build JS/TS with esbuild
  const result = await esbuild.build(esbuildOptions);
  if (!disableBundleInsights) {
    console.log('📊 Bundle analysis:');
    console.log(await analyzeMetafile(result.metafile, { verbose: true }));
  }

  // 2. Compile SCSS → CSS (replaces sass-loader + MiniCssExtractPlugin)
  for (const [name, scssPath] of Object.entries(scssFiles)) {
    const fullPath = path.resolve(root, scssPath);
    const result = sass.compile(fullPath, {
      style: isProduction ? 'compressed' : 'expanded',
    });
    fs.writeFileSync(path.join(outputDir, `${name}.css`), result.css);
  }

  // 3. Copy assets (replaces CopyPlugin)
  const copies = [
    { from: isFirefox ? 'src/manifest.firefox.json' : isSafari ? 'src/manifest.safari.json' : 'src/manifest.chrome.json', to: 'manifest.json' },
    { from: 'src/popup.html', to: 'popup.html' },
    { from: 'src/side-panel.html', to: 'side-panel.html' },
    { from: 'src/settings.html', to: 'settings.html' },
    { from: 'src/icons', to: 'icons' },
    { from: 'node_modules/webextension-polyfill/dist/browser-polyfill.min.js', to: 'browser-polyfill.min.js' },
    { from: 'src/flatten-shadow-dom.js', to: 'flatten-shadow-dom.js' },
    { from: 'src/_locales', to: '_locales' },
  ];

  for (const { from, to } of copies) {
    const fromPath = path.resolve(root, from);
    const toPath = path.resolve(outputDir, to);
    if (fs.statSync(fromPath).isDirectory()) {
      copyDir(fromPath, toPath);
    } else {
      const toDir = path.dirname(toPath);
      if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
      fs.copyFileSync(fromPath, toPath);
    }
  }

  // 4. Remove .DS_Store
  removeDSStore(outputDir);

  console.log(`✅ Build finished → ${outputDirName}`);

  // 5. Zip in production (exact same as original)
  if (isProduction) {
    const buildsDir = path.resolve(root, 'builds');
    if (!fs.existsSync(buildsDir)) fs.mkdirSync(buildsDir, { recursive: true });
    const zip = new AdmZip();
    zip.addLocalFolder(outputDir);
    const zipName = `obsidian-web-clipper-${packageJson.version}-${browserName}.zip`;
    zip.writeZip(path.join(buildsDir, zipName));
    console.log(`📦 Zipped → builds/${zipName}`);
  }
}

// Run build (with watch support)
if (isWatch) {
  const ctx = await esbuild.context(esbuildOptions);
  await ctx.watch();
  await mainBuild(); // initial full build (CSS + assets)
  console.log('👀 Watch mode active (JS/TS). Restart for CSS/assets changes.');
} else {
  await mainBuild();
}