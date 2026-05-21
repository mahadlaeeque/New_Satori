import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';
try {
  const src = readFileSync('src/Growgnition.jsx', 'utf8');
  const r = await esbuild.transform(src, { loader: 'jsx', jsx: 'automatic' });
  console.log('OK - output bytes:', r.code.length);
} catch (e) {
  console.error('ERROR:', e.message);
  if (e.errors) {
    e.errors.slice(0, 8).forEach(er => {
      console.error('  -', er.text, '@', er.location && (er.location.line + ':' + er.location.column));
      if (er.location) console.error('    >', er.location.lineText);
    });
  }
  process.exit(1);
}
