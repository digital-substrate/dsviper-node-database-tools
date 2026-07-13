// The native binding is a CommonJS addon; ESM reaches it through createRequire.
// One shared import point for the whole package (the Node twin of `import dsviper as V`).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default require('@digitalsubstrate/dsviper');
