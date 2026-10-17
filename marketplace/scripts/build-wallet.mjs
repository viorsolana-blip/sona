import { build } from 'esbuild';
await build({entryPoints:['src/client/wallet.mjs'],outfile:'dist/app/wallet.js',bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'eof',inject:['src/client/polyfills.mjs'],define:{'process.env.NODE_ENV':'"production"'}});
console.log('Built wallet adapter → dist/app/wallet.js');
