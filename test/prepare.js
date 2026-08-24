// Creates a local node_modules shim so `import '@supabase/supabase-js'` inside
// the real bot code resolves to the in-memory fake. No network install needed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'node_modules', '@supabase', 'supabase-js');

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'package.json'),
  JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module', main: 'index.js' }, null, 2)
);
fs.writeFileSync(
  path.join(dir, 'index.js'),
  "export * from '../../../test/fakes/supabase.js';\n"
);

console.log('test shim ready:', dir);
