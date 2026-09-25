// The native binding is a CommonJS addon; ESM reaches it through createRequire.
// One shared import point for the whole package (the Node twin of `import dsviper as V`).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The JSDoc type lets TypeScript check the package against index.d.ts: createRequire alone
// types what it loads as `any`, and every call through it would go unchecked.
/** @type {typeof import('@digitalsubstrate/dsviper')} */
const dsviper = require('@digitalsubstrate/dsviper');

export default dsviper;
