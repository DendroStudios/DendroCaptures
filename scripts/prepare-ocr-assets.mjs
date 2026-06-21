import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ocrDir = join(root, 'public', 'ocr');
const coreDir = join(ocrDir, 'core');
const tessdataDir = join(ocrDir, 'tessdata');

const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
};

mkdirSync(coreDir, { recursive: true });
mkdirSync(tessdataDir, { recursive: true });

copy(
  join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js'),
  join(ocrDir, 'worker.min.js'),
);

for (const file of [
  'tesseract-core.wasm.js',
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
]) {
  copy(
    join(root, 'node_modules', 'tesseract.js-core', file),
    join(coreDir, file),
  );
}

// Compatibility aliases for older cached workers or browser diagnostics that
// include a hyphen between "relaxed" and "simd".
copy(
  join(coreDir, 'tesseract-core-relaxedsimd.wasm.js'),
  join(coreDir, 'tesseract-core-relaxed-simd.wasm.js'),
);
copy(
  join(coreDir, 'tesseract-core-relaxedsimd-lstm.wasm.js'),
  join(coreDir, 'tesseract-core-relaxed-simd-lstm.wasm.js'),
);

copy(
  join(root, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'),
  join(tessdataDir, 'eng.traineddata.gz'),
);
copy(
  join(root, 'node_modules', '@tesseract.js-data', 'fra', '4.0.0_best_int', 'fra.traineddata.gz'),
  join(tessdataDir, 'fra.traineddata.gz'),
);

console.log('OCR assets ready');
