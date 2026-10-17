import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';
import { Store } from '../src/server/store.mjs';
import { Marketplace } from '../src/server/marketplace.mjs';
import { verifyNetwork, GENESIS_HASHES } from '../src/server/network.mjs';

function fixture(t){
  const seller=Keypair.generate(),buyer=Keypair.generate(),stranger=Keypair.generate(),mint=Keypair.generate().publicKey.toBase58();
  const s=seller.publicKey.toBase58(),b=buyer.publicKey.toBase58(),x=stranger.publicKey.toBase58();
  const store=new Store();t.after(()=>store.close());let time=Date.now(),holder=s,height=1,status=null;
  const verified={verified:true,mint,owner:s,tokenAccount:Keypair.generate().publicKey.toBase58(),mintA:mint,mintB:mint,poolId:mint,lpMint:mint,slot:8};
  const connection={getBalance:async()=>2_000_000_000,getBlockHeight:async()=>height,getSignatureStatuses:async()=>({value:[status]})};
  const market=new Marketplace({store,connection,origin:'http://127.0.0.1:4173',now:()=>time,verifyFeeKey:async({owner,mint:m})=>{if(owner!==holder||m!==mint)throw Error('Not owned');return {...verified,owner};},discoverFeeKeys:async()=>({positions:[]})});
  return {market,store,seller,buyer,stranger,s,b,x,mint,clock:v=>time+=v,owner:v=>holder=v,height:v=>height=v,status:v=>status=v};
}
function authenticate(market,key,challenge=market.challenge(key.publicKey.toBase58())){
  return market.authenticate({address:key.publicKey.toBase58(),challengeId:challenge.challengeId,signatureBase64:Buffer.from(nacl.sign.detached(Buffer.from(challenge.message),key.secretKey)).toString('base64')});
}
test('authentication requires an exact wallet signature, is single-use and expires',t=>{
  const f=fixture(t),c=f.market.challenge(f.s);
  assert.throws(()=>f.market.authenticate({address:f.s,challengeId:c.challengeId,signatureBase64:Buffer.from(nacl.sign.detached(Buffer.from(c.message),f.buyer.secretKey)).toString('base64')}),{code:'INVALID_SIGNATURE'});
  const {token}=authenticate(f.market,f.seller,c);assert.equal(f.market.session(token),f.s);
  assert.throws(()=>authenticate(f.market,f.seller,c),{code:'CHALLENGE_EXPIRED'});
  const c2=f.market.challenge(f.s);f.clock(300001);assert.throws(()=>authenticate(f.market,f.seller,c2),{code:'CHALLENGE_EXPIRED'});
  f.clock(3600001);assert.equal(f.market.session(token),null);
});
test('listings reject fractional lamports, wrong owners, duplicates and unauthorized edits',async t=>{
  const f=fixture(t);
  await assert.rejects(f.market.createListing(f.s,{mint:f.mint,priceLamports:0.1}),{code:'INVALID_PRICE'});
  await assert.rejects(f.market.createListing(f.b,{mint:f.mint,priceLamports:'1'}),/Not owned/);
  const {listing}=await f.market.createListing(f.s,{mint:f.mint,priceLamports:'123456789'});assert.equal(listing.priceLamports,'123456789');
  await assert.rejects(f.market.createListing(f.s,{mint:f.mint,priceLamports:'1'}),{code:'ALREADY_LISTED'});
  await assert.rejects(f.market.changeListing(f.b,listing.id,{},true),{code:'NOT_OWNER'});
  assert.equal((await f.market.changeListing(f.s,listing.id,{},true)).listing.status,'canceled');
  assert.deepEqual((await f.market.listings()).listings,[]);
});
test('purchase requests are idempotent; edits cancel stale price requests',async t=>{
  const f=fixture(t),{listing}=await f.market.createListing(f.s,{mint:f.mint,priceLamports:'50'});
  await assert.rejects(f.market.requestPurchase(f.s,listing.id),{code:'SELF_TRADE'});
  const first=await f.market.requestPurchase(f.b,listing.id),second=await f.market.requestPurchase(f.b,listing.id);
  assert.equal(first.trade.id,second.trade.id);assert.equal(f.store.all('trade').length,1);
  await f.market.changeListing(f.s,listing.id,{priceLamports:'51'});
  assert.equal(f.store.get('trade',first.trade.id).status,'canceled');
  assert.equal((await f.market.requestPurchase(f.b,listing.id)).trade.priceLamports,'51');
});
test('unreleased approval can cancel; released approval cannot be falsely revoked',async t=>{
  const f=fixture(t),{listing}=await f.market.createListing(f.s,{mint:f.mint,priceLamports:'50'}),{trade}=await f.market.requestPurchase(f.b,listing.id);
  f.store.put('trade',{...trade,status:'approved'});f.store.put('listing',{...listing,status:'reserved',reservedBy:trade.id});
  await assert.rejects(f.market.cancel(f.b,trade.id),{code:'APPROVAL_RELEASED'});
  await assert.rejects(f.market.changeListing(f.s,listing.id,{},true),{code:'LISTING_UNAVAILABLE'});
  await assert.rejects(f.market.trade(f.x,trade.id),{code:'NOT_PARTICIPANT'});
  f.market.inflight.set(trade.id,Promise.resolve({private:true}));await assert.rejects(f.market.submit(f.x,trade.id,''),{code:'NOT_PARTICIPANT'});
});
test('finalized block height releases expired approvals; confirmed failure alone does not',async t=>{
  const f=fixture(t),{listing}=await f.market.createListing(f.s,{mint:f.mint,priceLamports:'50'}),{trade}=await f.market.requestPurchase(f.b,listing.id);
  f.store.put('trade',{...trade,status:'submitted',signature:'fixture',settlement:{lastValidBlockHeight:20}});f.store.put('listing',{...listing,status:'reserved',reservedBy:trade.id});
  f.height(25);f.status({err:{InstructionError:[2,'Custom']},confirmationStatus:'confirmed'});await f.market.reconcile();
  assert.equal(f.store.get('trade',trade.id).status,'submitted');assert.equal(f.store.get('listing',listing.id).status,'reserved');
  f.status(null);await f.market.reconcile();assert.equal(f.store.get('trade',trade.id).status,'expired');assert.equal(f.store.get('listing',listing.id).status,'active');
});
test('verified new holder can replace a stale old-owner listing',async t=>{
  const f=fixture(t),{listing}=await f.market.createListing(f.s,{mint:f.mint,priceLamports:'50'});f.owner(f.b);
  const result=await f.market.createListing(f.b,{mint:f.mint,priceLamports:'75'});
  assert.equal(result.listing.seller,f.b);assert.equal(f.store.get('listing',listing.id).status,'expired');
});
test('confirmation is idempotent and emits one durable public receipt',async t=>{
  const f=fixture(t),{listing}=await f.market.createListing(f.s,{mint:f.mint,priceLamports:'50'}),{trade}=await f.market.requestPurchase(f.b,listing.id);
  const signed={...trade,status:'submitted',signature:'fixture',settlement:{lastValidBlockHeight:20,messageSha256:'fixture'}};f.store.put('trade',signed);
  f.market.complete(signed,10);f.market.complete(signed,10);
  assert.equal(f.store.all('receipt').length,1);assert.equal(f.store.all('activity').filter(a=>a.type==='sale').length,1);assert.equal(f.store.get('listing',listing.id).status,'sold');
});
test('stale reconciliation cannot overwrite a concurrently finalized sale',async t=>{
  const f=fixture(t),{listing}=await f.market.createListing(f.s,{mint:f.mint,priceLamports:'50'}),{trade}=await f.market.requestPurchase(f.b,listing.id);
  const pending={...trade,status:'submitted',signature:'fixture',settlement:{lastValidBlockHeight:20,messageSha256:'fixture'}};
  f.store.put('trade',pending);f.store.put('listing',{...listing,status:'reserved',reservedBy:trade.id});f.height(25);
  let releaseRead,entered;
  const paused=new Promise(done=>entered=done);
  f.market.connection.getSignatureStatuses=()=>{entered();return new Promise(done=>releaseRead=done);};
  const checking=f.market.reconcile();await paused;
  f.market.complete(pending,24);releaseRead({value:[null]});await checking;
  assert.equal(f.store.get('trade',trade.id).status,'confirmed');assert.equal(f.store.get('listing',listing.id).status,'sold');assert.equal(f.store.all('receipt').length,1);
});
test('network identity is checked and persistent data cannot cross clusters',async t=>{
  assert.equal(await verifyNetwork({getGenesisHash:async()=>GENESIS_HASHES['mainnet-beta']},'mainnet-beta'),GENESIS_HASHES['mainnet-beta']);
  await assert.rejects(verifyNetwork({getGenesisHash:async()=>GENESIS_HASHES.devnet},'mainnet-beta'),/genesis/);
  const f=fixture(t);assert.throws(()=>new Marketplace({store:f.store,cluster:'devnet'}),/another Solana network/);
});


test('local authentication rejects origin rebinding and exact expiration boundary', t => {
  const f = fixture(t), challenge = f.market.challenge(f.s);
  const originalOrigin = f.market.origin; f.market.origin = 'https://another-origin.example';
  assert.throws(() => authenticate(f.market, f.seller, challenge), { code: 'CHALLENGE_EXPIRED' });
  f.market.origin = originalOrigin; f.clock(300_000);
  assert.throws(() => authenticate(f.market, f.seller, challenge), { code: 'CHALLENGE_EXPIRED' });
});


test('local purchase admission rejects unfunded requests and expires unsigned queue entries', async t => {
  const f = fixture(t), { listing } = await f.market.createListing(f.s, { mint: f.mint, priceLamports: '50' });
  f.market.connection.getBalance = async () => 0;
  await assert.rejects(f.market.requestPurchase(f.b, listing.id), { code: 'INSUFFICIENT_BALANCE' });
  assert.equal(f.store.all('trade').length, 0);
  f.market.connection.getBalance = async () => 100;
  const { trade } = await f.market.requestPurchase(f.b, listing.id);
  f.clock(900_000); await f.market.reconcile();
  assert.equal(f.store.get('trade', trade.id).status, 'expired');
  assert.notEqual((await f.market.requestPurchase(f.b, listing.id)).trade.id, trade.id);
});
