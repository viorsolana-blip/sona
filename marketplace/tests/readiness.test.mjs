import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { auditProject, evaluateReadiness, validateStatus, SOURCE_PATHS, ARTIFACT_PATHS, STATUS_PATH } from '../scripts/check-readiness.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const baseline=JSON.parse(await readFile(join(root,STATUS_PATH),'utf8'));
const sources=async()=>Object.fromEntries(await Promise.all([...SOURCE_PATHS,...ARTIFACT_PATHS].map(async path=>{try{return [path,await readFile(join(root,path),'utf8')];}catch(error){if(error.code==='ENOENT')return [path,undefined];throw error;}})));
const check=(report,id)=>report.checks.find(c=>c.id===id);
const sha=text=>createHash('sha256').update(text).digest('hex');

test('actual implementation and recorded evidence remain distinct from production certification',async()=>{
 const report=await auditProject(root);
 assert.deepEqual(report.inputErrors,[]);assert.equal(report.exitCode,1);assert.equal(report.productionReady,false);
 for(const id of ['live-wallet','live-position-loading','protocol-validation','settlement'])assert.equal(check(report,id).status,'source-present');
 for(const id of ['local-settlement-execution','local-backend-execution','mainnet-read-only'])assert.ok(['recorded-current-source','stale-or-unbound'].includes(check(report,id).status));
 assert.match(check(report,'local-settlement-execution').scope,/No Raydium mainnet sale/);
 assert.match(check(report,'mainnet-read-only').scope,/Not a Sona listing/);
 assert.equal(check(report,'public-deployment').status,'missing');assert.equal(check(report,'mainnet-settlement').status,'missing');
});

test('production labels, URLs and plausible signatures cannot certify release',async()=>{
 const status=structuredClone(baseline);status.declaredStage='production';status.deployment={publicOrigin:'https://example.com',cluster:'mainnet-beta',securityReviewUrl:'https://example.com/review'};status.sourceProvenance={repositoryUrl:'https://example.com/source',revision:'a'.repeat(40)};status.executionReceipts=[{action:'purchase',cluster:'mainnet-beta',signature:'1'.repeat(88)}];
 const report=evaluateReadiness({files:await sources(),status});assert.deepEqual(report.inputErrors,[]);assert.equal(report.productionReady,false);assert.equal(report.exitCode,1);
 for(const id of ['public-deployment','mainnet-settlement','source-provenance','independent-security-review'])assert.equal(check(report,id).status,'declared-unverified');
});

test('source hash matching binds a recorded artifact and changing code makes it stale',async()=>{
 const files=await sources();const path='evidence/backend-local.json';const artifact=JSON.parse(files[path]);
 // Synthetic rebinding is only test input: readiness must still never certify it.
 for(const key of Object.keys(artifact.sourceSha256))artifact.sourceSha256[key]=sha(files[key]);files[path]=JSON.stringify(artifact);
 const recorded=evaluateReadiness({files,status:baseline});assert.equal(check(recorded,'local-backend-execution').status,'recorded-current-source');assert.equal(recorded.productionReady,false);
 files['src/server/marketplace.mjs']+='\n// changed after recording';const stale=evaluateReadiness({files,status:baseline});assert.equal(check(stale,'local-backend-execution').status,'stale-or-unbound');assert.deepEqual(check(stale,'local-backend-execution').mismatches,['src/server/marketplace.mjs']);
});

test('missing hashes, failed cases, wrong network and malformed artifacts fail closed',async()=>{
 const original=await sources();
 for(const patch of [a=>{a.sourceSha256={};},a=>{a.failed=1;},a=>{a.cluster='mainnet-beta';},a=>{a.receipt.commitment='processed';}]){
  const files={...original},artifact=JSON.parse(files['evidence/backend-local.json']);patch(artifact);files['evidence/backend-local.json']=JSON.stringify(artifact);assert.equal(check(evaluateReadiness({files,status:baseline}),'local-backend-execution').status,'invalid');
 }
 const files={...original,'evidence/settlement-local.json':'{invalid'};assert.equal(check(evaluateReadiness({files,status:baseline}),'local-settlement-execution').status,'invalid');
 const artifact=JSON.parse(original['evidence/raydium-mainnet-read.json']);artifact.networkWrites=1;files['evidence/raydium-mainnet-read.json']=JSON.stringify(artifact);assert.equal(check(evaluateReadiness({files,status:baseline}),'mainnet-read-only').status,'invalid');
});

test('unapproved hash paths are not read or reflected',async()=>{
 const files=await sources(),artifact=JSON.parse(files['evidence/backend-local.json']);artifact.sourceSha256['../../private-sentinel']='0'.repeat(64);files['evidence/backend-local.json']=JSON.stringify(artifact);const report=evaluateReadiness({files,status:baseline});assert.equal(check(report,'local-backend-execution').status,'stale-or-unbound');assert.ok(!JSON.stringify(report).includes('private-sentinel'));
});

test('malformed and expanded release metadata returns structured errors without supplied secrets',()=>{
 const sentinel='must-not-appear-in-report';
 for(const status of [null,[],{}, {...baseline,schemaVersion:999},{...baseline,privateKey:sentinel},{...baseline,deployment:{publicOrigin:`https://user:${sentinel}@example.com`,cluster:'mainnet-beta',securityReviewUrl:null}},{...baseline,executionReceipts:[null]}]){
  const report=evaluateReadiness({files:{'dist/app/app.js':''},status});assert.equal(report.productionReady,false);assert.equal(report.exitCode,2);assert.ok(report.inputErrors.length);assert.ok(!JSON.stringify(report).includes(sentinel));
 }
 assert.deepEqual(validateStatus(baseline),[]);
});

async function tempProject(t){const folder=await mkdtemp(join(tmpdir(),'sona-readiness-'));t.after(()=>rm(folder,{recursive:true,force:true}));await mkdir(join(folder,'dist/app'),{recursive:true});await mkdir(join(folder,'evidence'));await writeFile(join(folder,'dist/app/app.js'),'/* no integration */');await writeFile(join(folder,STATUS_PATH),JSON.stringify(baseline));return folder;}
test('reader ignores secret files and rejects symbolic-link public inputs',async t=>{
 const folder=await tempProject(t);await mkdir(join(folder,'.aws'));await writeFile(join(folder,'.aws/credentials'),'never-read-this-sentinel');const ordinary=await auditProject(folder);assert.deepEqual(ordinary.inputErrors,[]);assert.ok(!JSON.stringify(ordinary).includes('never-read-this-sentinel'));
 await rm(join(folder,'dist/app/app.js'));await symlink(join(folder,'.aws/credentials'),join(folder,'dist/app/app.js'));const blocked=await auditProject(folder);assert.equal(blocked.exitCode,2);assert.ok(blocked.inputErrors.some(e=>e.includes('symbolic-link')));assert.ok(!JSON.stringify(blocked).includes('never-read-this-sentinel'));
});

test('missing app and malformed JSON produce input failures',async t=>{
 const folder=await tempProject(t);await writeFile(join(folder,STATUS_PATH),'{bad');await rm(join(folder,'dist/app/app.js'));const report=await auditProject(folder);assert.equal(report.exitCode,2);assert.ok(report.inputErrors.some(e=>e.includes('not valid JSON')));assert.ok(report.inputErrors.some(e=>e.includes('Required application source')));
});

test('offline report is deterministic and CLI does not predict a rating',async()=>{
 assert.deepEqual(await auditProject(root),await auditProject(root));const result=spawnSync(process.execPath,[resolve(root,'scripts/check-readiness.mjs'),'--json'],{encoding:'utf8'});assert.equal(result.status,1);assert.equal(result.stderr,'');const report=JSON.parse(result.stdout);assert.equal(report.productionReady,false);assert.ok(!Object.hasOwn(report,'score'));assert.ok(!Object.hasOwn(report,'predictedScore'));
});
