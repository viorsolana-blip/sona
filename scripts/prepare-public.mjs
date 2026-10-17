import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const source=resolve(root,'marketplace');
const published=resolve(root,'public/source');
// This directory is generated; rebuild it so removed source files cannot linger.
rmSync(published,{recursive:true,force:true});
mkdirSync(published,{recursive:true});
for(const part of ['src','tests','scripts','vendor','evidence','docs','package.json','package-lock.json','README.md']) cpSync(resolve(source,part),resolve(published,part),{recursive:true});
const files={};
function walk(path){for(const item of readdirSync(path)){const p=resolve(path,item);if(statSync(p).isDirectory())walk(p);else files[relative(root,p).split(sep).join('/')]=createHash('sha256').update(readFileSync(p)).digest('hex');}}
walk(resolve(source,'src'));walk(resolve(root,'build'));walk(resolve(root,'drizzle'));
const revision=process.env.GITHUB_SHA||process.env.SONA_SOURCE_REVISION||null;
writeFileSync(resolve(root,'public/build-manifest.json'),JSON.stringify({schemaVersion:1,project:'Sona',repository:'https://github.com/viorsolana-blip/sona',sourceRevision:revision,builtAt:new Date().toISOString(),runtime:'Cloudflare Workers',persistence:'Cloudflare D1',files},null,2)+'\n');
