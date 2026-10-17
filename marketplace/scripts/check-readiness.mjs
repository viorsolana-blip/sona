#!/usr/bin/env node
/** Offline evidence inventory. Matching hashes bind recorded artifacts to these
 * files; they do not authenticate the author, rerun a validator or audit safety.
 * This command cannot certify a public production deployment. */
import { readFile, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export const STATUS_PATH='evidence/project-status.json';
export const SOURCE_PATHS=Object.freeze([
 'dist/app/app.js','src/client/wallet.mjs','src/chain/raydium.mjs','src/chain/settlement.mjs',
 'src/server/index.mjs','src/server/http.mjs','src/server/marketplace.mjs','src/server/store.mjs',
 'scripts/test-settlement-local.mjs','scripts/test-backend-local.mjs','scripts/verify-raydium-live.mjs',
 'src/server/network.mjs','src/client/polyfills.mjs','scripts/build-wallet.mjs','dist/app/wallet.js',
 'vendor/bigint-buffer/index.cjs','vendor/bigint-buffer/package.json','tests/browser-bundle.test.mjs','tests/bigint-buffer.test.mjs',
 'tests/wallet.test.mjs','tests/raydium.test.mjs','tests/settlement.test.mjs','tests/marketplace.test.mjs','package.json','package-lock.json',
]);
export const ARTIFACT_PATHS=Object.freeze(['evidence/settlement-local.json','evidence/backend-local.json','evidence/raydium-mainnet-read.json']);
const MAX_BYTES=2*1024*1024;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).every(k=>keys.includes(k))&&keys.every(k=>Object.hasOwn(value,k));
const nullableUrl=value=>value===null||(()=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}})();
const sha=text=>createHash('sha256').update(text).digest('hex');
const CAPABILITIES=['liveWallet','livePositions','protocolValidation','settlement'];
export function validateStatus(status){
 const errors=[];
 if(!exact(status,['schemaVersion','project','declaredStage','declaredCapabilities','architecture','deployment','sourceProvenance','executionReceipts']))return ['Status must contain exactly the documented public evidence fields.'];
 if(status.schemaVersion!==2||status.project!=='Sona')errors.push('Unsupported project or schema version.');
 if(!['development','functional-local-implementation','testnet','production'].includes(status.declaredStage))errors.push('Invalid declared stage.');
 if(!exact(status.declaredCapabilities,CAPABILITIES)||CAPABILITIES.some(k=>typeof status.declaredCapabilities[k]!=='boolean'))errors.push('Invalid capability declarations.');
 if(!exact(status.architecture,['settlementMode','custody','customSonaProgramRequired','supportedInstrument'])||status.architecture.settlementMode!=='bilateral-co-signed'||status.architecture.custody!=='user-wallets'||status.architecture.customSonaProgramRequired!==false||status.architecture.supportedInstrument!=='raydium-cpmm-burn-and-earn-fee-key')errors.push('Invalid settlement architecture.');
 if(!exact(status.deployment,['publicOrigin','cluster','securityReviewUrl'])||!nullableUrl(status.deployment?.publicOrigin)||!nullableUrl(status.deployment?.securityReviewUrl)||![null,'devnet','mainnet-beta'].includes(status.deployment?.cluster))errors.push('Invalid deployment declarations.');
 if(!exact(status.sourceProvenance,['repositoryUrl','revision'])||!nullableUrl(status.sourceProvenance?.repositoryUrl)||(status.sourceProvenance?.revision!==null&&!/^[a-f0-9]{40,64}$/i.test(status.sourceProvenance?.revision||'')))errors.push('Invalid source provenance declaration.');
 if(!Array.isArray(status.executionReceipts)||status.executionReceipts.length>100||status.executionReceipts.some(r=>!exact(r,['action','cluster','signature'])||r.action!=='purchase'||!['devnet','mainnet-beta'].includes(r.cluster)||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(r.signature)))errors.push('Invalid public execution receipt declarations.');
 return errors;
}
const specs=[
 {id:'local-settlement-execution',path:ARTIFACT_PATHS[0],schema:'sona-settlement-local-evidence-v1',required:['src/chain/settlement.mjs','scripts/test-settlement-local.mjs','tests/settlement.test.mjs'],scope:'Isolated local validator; purpose-created SPL NFTs and valueless SOL. No Raydium mainnet sale.',valid:a=>a.failed===0&&a.passed>0&&Array.isArray(a.cases)&&a.cases.length===a.passed&&a.cases.every(c=>record(c)&&c.passed===true)&&a.validator?.genesisHash&&a.privateKeysPersisted===false},
 {id:'local-backend-execution',path:ARTIFACT_PATHS[1],schema:'sona-backend-local-evidence-v1',required:['src/server/marketplace.mjs','src/server/http.mjs','src/server/store.mjs','scripts/test-backend-local.mjs'],scope:'HTTP authentication, persistent listings and co-signed settlement against the isolated local validator. Test NFT authenticity is injected only in the test runner.',valid:a=>a.cluster==='localnet'&&a.failed===0&&a.passed>0&&Array.isArray(a.cases)&&a.cases.length===a.passed&&a.receipt?.commitment==='finalized'&&a.receipt?.cluster==='localnet'&&a.signature===a.receipt.signature},
 {id:'mainnet-read-only',path:ARTIFACT_PATHS[2],schema:'raydium-mainnet-read',required:['src/chain/raydium.mjs','tests/raydium.test.mjs','scripts/verify-raydium-live.mjs'],scope:'Read-only validation of an existing third-party Fee Key. Not a Sona listing, customer or sale.',valid:a=>a.kind==='raydium-mainnet-read'&&a.verified===true&&a.networkWrites===0&&a.verification?.verified===true&&a.verification.cluster==='mainnet-beta'&&a.genesisHash==='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'},
];
function checkArtifact(files,spec){
 const base={id:spec.id,evidencePaths:[spec.path],scope:spec.scope};
 if(typeof files[spec.path]!=='string')return {...base,status:'missing',reason:'No recorded artifact is available.'};
 let artifact;try{artifact=JSON.parse(files[spec.path]);}catch{return {...base,status:'invalid',reason:'Recorded artifact is not valid JSON.'};}
 if(!record(artifact)||(artifact.schema||artifact.kind)!==spec.schema||!spec.valid(artifact))return {...base,status:'invalid',reason:'Recorded artifact does not satisfy its stated test/read scope.'};
 const hashes=artifact.sourceSha256||artifact.sourceHashes;
 if(!record(hashes)||spec.required.some(path=>!Object.hasOwn(hashes,path)))return {...base,status:'invalid',reason:'Recorded artifact omits required source hashes.'};
 const mismatches=[],unreadable=[];
 for(const [path,hash]of Object.entries(hashes)){
  if(!SOURCE_PATHS.includes(path)||typeof files[path]!=='string'||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)){unreadable.push(SOURCE_PATHS.includes(path)?path:'unapproved source path');continue;}
  if(sha(files[path])!==hash)mismatches.push(path);
 }
 if(unreadable.length||mismatches.length)return {...base,status:'stale-or-unbound',reason:'Recorded execution does not match all of its declared current source files. Rerun the test/read; do not rewrite its hashes.',mismatches,unreadable};
 return {...base,status:'recorded-current-source',reason:'Recorded artifact passes structural checks and its listed source hashes match. This command has not independently rerun or authenticated the execution.',recordedAt:artifact.generatedAt||artifact.observedAt,passedCases:artifact.passed??null,sourceHashCount:Object.keys(hashes).length};
}
export function evaluateReadiness({files={},status=null,inputErrors=[]}={}){
 const errors=[...inputErrors,...validateStatus(status)];
 if(typeof files['dist/app/app.js']!=='string')errors.push('Required application source unavailable: dist/app/app.js.');
 const observations=[];const checks=[];
 const add=(id,paths,condition,reason)=>{const present=paths.every(path=>typeof files[path]==='string')&&condition;checks.push({id,status:present?'source-present':'missing',reason:present?reason:'Required implementation source or integration call is absent.',evidencePaths:paths});};
 const app=files['dist/app/app.js']||'';
 const fixtureImport=/import[^\n]*initialListings/.test(app)||/balance\s*:\s*125\b/.test(app)||/state\.positions\.push\(/.test(app);
 add('live-wallet',['dist/app/app.js','src/client/wallet.mjs'],/createWalletController/.test(app)&&/standard:connect/.test(files['src/client/wallet.mjs']||'')&&!fixtureImport,'Wallet Standard and injected adapters are wired to the UI. Automated adapter tests are available; a real browser-extension session is separate evidence.');
 add('live-position-loading',['src/server/marketplace.mjs','src/chain/raydium.mjs'],/getBalance/.test(files['src/server/marketplace.mjs']||'')&&/discoverFeeKeys/.test(files['src/chain/raydium.mjs']||'')&&!fixtureImport,'RPC balance and verified Fee Key discovery source are present; no fictional fallback is imported by the UI.');
 add('protocol-validation',['src/chain/raydium.mjs'],/verifyFeeKey/.test(files['src/chain/raydium.mjs']||''),'Raydium CPMM Burn & Earn decoder and ownership/lock/mint checks are present. The separate mainnet-read artifact supplies a recorded live observation.');
 add('settlement',['src/chain/settlement.mjs','src/server/marketplace.mjs','src/client/wallet.mjs'],/createTransferCheckedInstruction/.test(files['src/chain/settlement.mjs']||'')&&/verifyCanonicalSignedTransaction/.test(files['src/server/marketplace.mjs']||'')&&/assertSettlementTransaction/.test(files['src/client/wallet.mjs']||''),'Atomic SPL NFT transfer plus exact SOL payment, both signatures and canonical-message checks are implemented. Runtime evidence is assessed separately.');
 if(fixtureImport)observations.push({path:'dist/app/app.js',description:'Legacy fictional inventory or browser-local ownership mutation is present.'});
 observations.push({path:'src/server/marketplace.mjs',description:'Listings and purchase coordination are server-hosted. Co-signed settlement is non-custodial; this does not make the order service decentralized.'});
 checks.push(...specs.map(spec=>checkArtifact(files,spec)));
 const valid=errors.length===0;
 for(const [id,supplied,reason]of [
  ['public-deployment',valid&&status.deployment.publicOrigin,'A declared URL is not verified availability, configuration or operational readiness. No custom Sona program deployment is required for this architecture.'],
  ['mainnet-settlement',valid&&status.executionReceipts.some(r=>r.cluster==='mainnet-beta'),'Public signatures require independent inspection of success, signers, amounts, mint and lock invariants. Local transactions and mainnet account reads are not mainnet sales.'],
  ['source-provenance',valid&&status.sourceProvenance.repositoryUrl&&status.sourceProvenance.revision,'Public repository accessibility and correspondence to this running build remain independently unverified.'],
  ['independent-security-review',valid&&status.deployment.securityReviewUrl,'Security review scope, findings and correspondence to this revision require independent review.'],
 ])checks.push({id,status:supplied?'declared-unverified':'missing',reason,evidencePaths:[]});
 const implementation=checks.slice(0,4).every(c=>c.status==='source-present');
 const currentLocal=checks.filter(c=>c.id.startsWith('local-')).every(c=>c.status==='recorded-current-source');
 return {schemaVersion:2,project:'Sona',productionReady:false,exitCode:errors.length?2:1,observedStage:implementation?(currentLocal?'implementation-with-recorded-local-execution':'implementation-source-with-evidence-gaps'):'incomplete-implementation',scope:'Offline source and recorded-evidence inventory; no network execution, security certification or score prediction.',verificationPolicy:'Code presence, declared metadata and hash-matched recorded artifacts are distinct evidence levels. The offline gate cannot certify production readiness or independent execution.',inspectedPaths:[...SOURCE_PATHS,...ARTIFACT_PATHS].filter(p=>typeof files[p]==='string'),missingPaths:SOURCE_PATHS.filter(p=>typeof files[p]!=='string'),observations,checks,inputErrors:errors};
}
async function readPublicFile(root,path){
 try{const full=resolve(root,path),stat=await lstat(full);if(!stat.isFile()||stat.isSymbolicLink())return {error:`Refused non-regular or symbolic-link public input: ${path}.`};const actual=await realpath(full),inside=relative(root,actual);if(inside==='..'||inside.startsWith(`..${sep}`)||inside.startsWith(sep))return {error:`Refused public input outside the project: ${path}.`};if(stat.size>MAX_BYTES)return {error:`Public input exceeds the 2 MiB limit: ${path}.`};return {text:await readFile(actual,'utf8')};}catch(error){return error.code==='ENOENT'?{missing:true}:{error:`Unable to read public input: ${path}.`};}
}
export async function auditProject(projectRoot){
 let root;try{root=await realpath(resolve(projectRoot));}catch{return evaluateReadiness({inputErrors:['Project root is unavailable.']});}
 const files={},inputErrors=[];
 for(const path of [...SOURCE_PATHS,...ARTIFACT_PATHS]){const result=await readPublicFile(root,path);if(result.error)inputErrors.push(result.error);else if(result.text!==undefined)files[path]=result.text;}
 const metadata=await readPublicFile(root,STATUS_PATH);let status=null;
 if(metadata.error)inputErrors.push(metadata.error);else if(metadata.missing)inputErrors.push('Public status metadata is missing.');else try{status=JSON.parse(metadata.text);}catch{inputErrors.push('Public status metadata is not valid JSON.');}
 return evaluateReadiness({files,status,inputErrors});
}
export function humanReport(report){return [`Sona production readiness: not certified`,`Observed stage: ${report.observedStage}`,report.scope,'',...report.checks.map(c=>`[${c.status}] ${c.id}: ${c.reason}`),...report.inputErrors.map(e=>`[input error] ${e}`),'',report.verificationPolicy].join('\n');}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);let root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),json=false,bad=false;
 for(let i=0;i<args.length;i++)if(args[i]==='--json')json=true;else if(args[i]==='--root'&&args[i+1]&&!args[i+1].startsWith('--'))root=args[++i];else bad=true;
 const report=bad?evaluateReadiness({inputErrors:['Usage: node scripts/check-readiness.mjs [--json] [--root /path/to/sona-site]']}):await auditProject(root);
 process.stdout.write((json?JSON.stringify(report,null,2):humanReport(report))+'\n');process.exitCode=report.exitCode;
}
