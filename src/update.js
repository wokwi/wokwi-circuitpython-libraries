const path = require('path');
const fs = require('fs');
const os = require('os');
const rimraf = require('rimraf');
const zip = require('@zip.js/zip.js');

const magic0 = 0x776b6f57;
const magic1 = 0x30524169;
const target = path.join(__dirname, '../packages');

/**
 * @param {{name: string, size: number}} headerData
 * @returns
 */
function libraryHeader({ name, size }) {
  const nameBuffer = Buffer.from(name);
  const header = new Uint32Array([magic0, magic1, nameBuffer.length, size]);
  const buffer = new Uint8Array(header.byteLength + nameBuffer.length);
  buffer.set(new Uint8Array(header.buffer), 0);
  buffer.set(nameBuffer, header.byteLength);
  return buffer;
}

/**
 * @param {string} sourceFile
 * @param {string} targetFile
 */
function packFile(sourceFile, targetFile) {
  const output = fs.openSync(targetFile, 'w');
  const content = fs.readFileSync(sourceFile);
  fs.writeSync(
    output,
    libraryHeader({ name: path.basename(sourceFile), size: content.byteLength })
  );
  fs.writeSync(output, content);
  fs.closeSync(output);
}

/**
 * @param {string} sourceDir
 * @param {string} targetDir
 * @param {string} prefix
 */
function packLibrary(sourceDir, targetDir, prefix) {
  const output = fs.openSync(targetDir, 'w');
  queue = fs.readdirSync(sourceDir).sort();
  while (queue.length) {
    file = queue.shift();
    const filePath = path.join(sourceDir, file);
    if (fs.lstatSync(filePath).isDirectory()) {
      queue.push(
        ...fs.readdirSync(filePath).sort().map((item) => `${filePath.substring(sourceDir.length)}/${item}`)
      );
      continue;
    }
    const content = fs.readFileSync(filePath);
    const archiveName = `${prefix}/${file}`;
    fs.writeSync(output, libraryHeader({ name: archiveName, size: content.byteLength }));
    fs.writeSync(output, content);
  }
  fs.closeSync(output);
}

/**
 * @param {ArrayBuffer} zipData
 * @param {string} targetDir
 */
async function extractZipFile(zipData, targetDir) {
  const zipReader = new zip.ZipReader(new zip.Uint8ArrayReader(new Uint8Array(zipData)));
  const entries = await zipReader.getEntries();
  for (const entry of entries) {
    const name = entry.filename.split('/').slice(1).join('/');
    const writer = new zip.Uint8ArrayWriter();
    await entry.getData(writer);
    await fs.mkdirSync(path.dirname(path.join(targetDir, name)), { recursive: true });
    fs.writeFileSync(path.join(targetDir, name), Buffer.from(await writer.getData()));
  }
}

/**
 * @param {string} sourceDir
 * @param {string} targetDir
 * @param {Record<string, {dependencies: string[], version: string}>} indexFile
 */
function packLibraries(sourceDir, targetDir, indexFile) {
  const libraryIndex = [];
  const libRoot = path.join(sourceDir, 'lib');
  const version = fs
    .readFileSync(path.join(sourceDir, 'VERSIONS.txt'), 'utf-8')
    .split('\n')[0]
    .trim();
  for (const lib of fs.readdirSync(libRoot).sort()) {
    const name = lib.replace('.mpy', '');
    console.log(`-> ${name}`);
    const indexEntry = indexFile[name];
    libraryIndex.push({ name, deps: indexEntry.dependencies, version: indexEntry.version });
    const packedName = path.join(targetDir, `${name}.mpylib`);
    if (lib.endsWith('.mpy')) {
      packFile(path.join(libRoot, lib), packedName);
    } else {
      packLibrary(path.join(libRoot, lib), packedName, name);
    }
  }

  fs.writeFileSync('index.json', JSON.stringify({ format: 1, version, libs: libraryIndex }));
  return libraryIndex;
}

async function main() {
  const releasesUrl =
    'https://api.github.com/repos/adafruit/Adafruit_CircuitPython_Bundle/releases/latest';
  const release = await fetch(releasesUrl).then((res) => res.json());
  const indexAsset = release.assets.find((asset) => asset.name.endsWith('.json'));
  console.log('Downloading', indexAsset.name, '...');
  const indexFile = await fetch(indexAsset.browser_download_url).then((res) => res.json());

  for (const version of ['7.x-mpy', '8.x-mpy']) {
    const zipAsset = release.assets.find(
      (asset) => asset.name.includes(`-${version}-`) && asset.name.endsWith('.zip')
    );

    console.log('Downloading', zipAsset.name, '...');
    const zipData = await fetch(zipAsset.browser_download_url).then((res) => res.arrayBuffer());

    console.log('Extracting', zipAsset.name, '...');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update'));

    try {
      await extractZipFile(zipData, tempDir);

      console.log('Packing...');
      const versionTarget = path.join(target, version);
      rimraf.sync(versionTarget);
      fs.mkdirSync(versionTarget, { recursive: true });
      const libraryIndex = packLibraries(tempDir, versionTarget, indexFile);
      console.log(`Successfully packed ${libraryIndex.length} libraries.`);
    } finally {
      rimraf.sync(tempDir);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
