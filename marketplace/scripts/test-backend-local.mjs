#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { Transaction } from '@solana/web3.js';
import { getAccount } from '@solana/spl-token';
import { Store } from '../src/server/store.mjs';
import { Marketplace } from '../src/server/marketplace.mjs';
import { createHttpServer } from '../src/server/http.mjs';
import { inspectSettlementAsset } from '../src/chain/settlement.mjs';
import { runSettlementLocal } from './test-settlement-local.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const wire=tx=>tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
await runSettlementLocal({runBackend:async({connection,seller,buyer,other,nft})=>{
  const temp=await mkdtemp(join(tmpdir(),'sona-backend-')),filename=join(temp,'market.sqlite');
  const port=42000+Math.floor(Math.random()*6000),origin=`http://127.0.0.1:${port}`;
  const asset=await nft(),mint=asset.mint.toBase58(),s=seller.publicKey.toBase58(),b=buyer.publicKey.toBase58();
  // A purpose-created SPL NFT isolates backend/atomic transfer behavior. This
  // dependency injection is never available in the production entrypoint.
  const verify=async({owner,mint:requested})=>{
    assert.equal(requested,mint);await inspectSettlementAsset({connection,...asset,seller:owner});
    return {verified:true,mint,owner,tokenAccount:asset.sourceTokenAccount.toBase58(),mintA:mint,mintB:mint,poolId:mint,lpMint:mint,slot:await connection.getSlot('confirmed')};
  };
  let store=new Store(filename);
  const market=new Marketplace({store,connection,cluster:'localnet',origin,verifyFeeKey:verify,discoverFeeKeys:async({owner})=>({positions:[await verify({owner,mint})],rejected:[],slot:await connection.getSlot()})});
  const server=createHttpServer({market,projectRoot:root,origin});
  await new Promise(resolveListen=>server.listen(port,'127.0.0.1',resolveListen));
  async function api(path,{method='GET',token,body,status=200,extra={}}={}){
    const response=await fetch(origin+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{...extra})},body:body?JSON.stringify(body):undefined});
    const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;
  }
  async function login(key){const address=key.publicKey.toBase58(),c=await api('/api/auth/challenge',{method:'POST',body:{address}});return (await api('/api/auth/verify',{method:'POST',body:{address,challengeId:c.challengeId,signatureBase64:Buffer.from(nacl.sign.detached(Buffer.from(c.message),key.secretKey)).toString('base64')}})).token;}
  try{
    const config=await api('/api/config');assert.equal(Object.hasOwn(config,'rpcUrl'),false);
    const getBalance=connection.getBalance.bind(connection);
    connection.getBalance=async()=>{throw Object.assign(new Error('secret-provider-detail'),{code:-32005});};
    const rpcFailure=await api(`/api/wallet/${s}`,{status:502});assert.doesNotMatch(JSON.stringify(rpcFailure),/secret-provider-detail/);
    connection.getBalance=getBalance;assert.equal((await api('/api/config')).tradingEnabled,true);
    await api('/source/var/marketplace.sqlite',{status:404});
    const sellerToken=await login(seller),buyerToken=await login(buyer),otherToken=await login(other);
    await api('/api/listings',{method:'POST',body:{mint,priceLamports:'100000001'},status:401});
    await api('/api/auth/challenge',{method:'POST',body:{address:s},status:403,extra:{Origin:'https://attacker.invalid'}});
    const {listing}=await api('/api/listings',{method:'POST',token:sellerToken,body:{mint,priceLamports:'100000001',expiresInDays:7}});
    assert.equal((await api('/api/listings')).listings[0].id,listing.id);
    const {trade}=await api(`/api/listings/${listing.id}/request`,{method:'POST',token:buyerToken,body:{}});
    await api(`/api/trades/${trade.id}`,{token:otherToken,status:403});
    const prepared=await api(`/api/trades/${trade.id}/prepare`,{method:'POST',token:sellerToken,body:{}});
    const sellerTx=Transaction.from(Buffer.from(prepared.settlement.transactionBase64,'base64'));sellerTx.partialSign(seller);
    await api(`/api/trades/${trade.id}/approve`,{method:'POST',token:sellerToken,body:{transactionBase64:wire(sellerTx)}});
    await api(`/api/trades/${trade.id}/cancel`,{method:'POST',token:sellerToken,body:{},status:409});
    const approved=await api(`/api/trades/${trade.id}`,{token:buyerToken});
    const final=Transaction.from(Buffer.from(approved.settlement.transactionBase64,'base64'));final.partialSign(buyer);
    const sellerBefore=await connection.getBalance(seller.publicKey);
    const result=await api(`/api/trades/${trade.id}/submit`,{method:'POST',token:buyerToken,body:{transactionBase64:wire(final)}});
    assert.equal(result.trade.status,'confirmed');assert.equal(result.trade.commitment,'finalized');
    assert.equal(await connection.getBalance(seller.publicKey)-sellerBefore,100000001);
    assert.equal((await getAccount(connection,asset.sourceTokenAccount)).amount,0n);
    const repeat=await api(`/api/trades/${trade.id}/submit`,{method:'POST',token:buyerToken,body:{transactionBase64:wire(final)}});
    assert.equal(repeat.signature,result.signature);assert.equal(await connection.getBalance(seller.publicKey)-sellerBefore,100000001);
    assert.equal((await api('/api/receipts')).receipts.length,1);assert.equal((await api('/api/listings')).listings.length,0);
    await new Promise(resolveClose=>server.close(resolveClose));store.close();store=new Store(filename);
    assert.equal(store.get('trade',trade.id).status,'confirmed');assert.equal(store.get('listing',listing.id).status,'sold');assert.equal(store.all('receipt').length,1);
    const sourceSha256={};for(const f of ['src/server/marketplace.mjs','src/server/http.mjs','src/server/store.mjs','src/server/index.mjs','src/server/network.mjs','src/client/wallet.mjs','src/client/polyfills.mjs','dist/app/app.js','dist/app/wallet.js','scripts/build-wallet.mjs','scripts/test-backend-local.mjs','tests/marketplace.test.mjs','tests/browser-bundle.test.mjs','tests/wallet.test.mjs','tests/bigint-buffer.test.mjs','vendor/bigint-buffer/index.cjs','vendor/bigint-buffer/package.json','package.json','package-lock.json'])sourceSha256[f]=createHash('sha256').update(await readFile(resolve(root,f))).digest('hex');
    const cases=['RPC credentials omitted from public config','numeric RPC error handled without process failure or information leak','private database not served','signed nonce authentication','unauthenticated mutation rejected','cross-origin mutation rejected','persistent verified listing','participant-only transaction access','seller co-sign approval','released approval cannot falsely cancel','buyer co-sign and finalized settlement','exact lamport payment','idempotent repeat submission','SQLite persistence after restart'];
    const report={schema:'sona-backend-local-evidence-v1',generatedAt:new Date().toISOString(),scope:'Actual HTTP authentication, SQLite listing/request/approval, atomic SPL/System transaction, finalized receipt and restart persistence. Isolated local validator with a test NFT. Raydium authenticity is separately tested against mainnet accounts; this is not a mainnet Fee Key sale.',cluster:'localnet',passed:cases.length,failed:0,cases,signature:result.signature,mint,seller:s,buyer:b,priceLamports:'100000001',receipt:store.all('receipt')[0],sourceSha256};
    await writeFile(join(root,'evidence/backend-local.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({backendPassed:report.passed,signature:result.signature}));
  }finally{if(server.listening)await new Promise(done=>server.close(done));store.close();await rm(temp,{recursive:true,force:true});}
}});
