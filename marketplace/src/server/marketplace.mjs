import { randomBytes, randomUUID, createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { prepareSettlement, verifyCanonicalSignedTransaction, inspectSettlementAsset, assertSettlementNotExpired, parseLamports, findExternalSettlement } from '../chain/settlement.mjs';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
const problem=(status,code,message)=>{throw new ApiError(status,code,message);};
const digest=value=>createHash('sha256').update(value).digest('hex');
const iso=ms=>new Date(ms).toISOString();
const short=value=>`${value.slice(0,4)}…${value.slice(-4)}`;
const MINTS={
  So11111111111111111111111111111111111111112:'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:'USDC',
  Es9vMFrzaCERmJfrF4H2FYD9KZCtNH6nYxn3S9ieYZz:'USDT',
};
const finalStates=['confirmed','expired','canceled','failed'];
export function address(value) {
  try { const key=new PublicKey(value); if(!PublicKey.isOnCurve(key.toBytes()))throw Error(); return key.toBase58(); }
  catch { problem(400,'INVALID_WALLET','Enter a valid signing wallet address.'); }
}
function price(value) { const result=parseLamports(value); if(result>1_000_000_000_000_000n)problem(400,'INVALID_PRICE','The maximum listing price is 1,000,000 SOL.'); return result.toString(); }

export class Marketplace {
  constructor({store,connection,cluster='mainnet-beta',genesisHash=null,origin,verifyFeeKey,discoverFeeKeys,now=Date.now}) {
    Object.assign(this,{store,connection,cluster,origin,verifyFeeKey,discoverFeeKeys,now});
    const network=store.get('metadata','network');
    if(network&&(network.cluster!==cluster||(network.genesisHash&&genesisHash&&network.genesisHash!==genesisHash)))throw new Error('This database belongs to another Solana network. Use a separate database path.');
    store.put('metadata',{id:'network',cluster,genesisHash:genesisHash||network?.genesisHash||null});
    this.inflight=new Map();
    // Preparation contains no released signature. An interrupted preparation can
    // safely be retried after restart; approved/submitted trades must reconcile.
    for(const trade of store.all('trade'))if(trade.status==='preparing'){
      trade.status='failed'; trade.error='Preparation interrupted; request again.'; store.put('trade',trade); this.release(trade);
    }
  }
  challenge(value) {
    const owner=address(value), id=randomUUID(), expires=this.now()+300_000;
    const message=`Sona wallet authentication\nOrigin: ${this.origin}\nNetwork: ${this.cluster}\nWallet: ${owner}\nNonce: ${randomBytes(24).toString('hex')}\nIssued at: ${iso(this.now())}\nExpires at: ${iso(expires)}\n\nAuthenticate this wallet with Sona. This message does not authorize an asset transfer.`;
    this.store.db.prepare('DELETE FROM challenges WHERE expires < ?').run(this.now());
    this.store.db.prepare('INSERT INTO challenges VALUES (?,?,?,?)').run(id,owner,message,expires);
    return {challengeId:id,message};
  }
  authenticate({address:owner,challengeId,signatureBase64}) {
    address(owner);
    const challenge=this.store.db.prepare('SELECT * FROM challenges WHERE id=?').get(challengeId || '');
    if(!challenge||challenge.address!==owner||challenge.expires<this.now())problem(401,'CHALLENGE_EXPIRED','Request a fresh wallet authentication message.');
    const bytes=Buffer.from(typeof signatureBase64==='string'?signatureBase64:'','base64');
    if(bytes.length!==64||bytes.toString('base64')!==signatureBase64||!nacl.sign.detached.verify(Buffer.from(challenge.message),bytes,new PublicKey(owner).toBytes()))problem(401,'INVALID_SIGNATURE','Wallet authentication signature is invalid.');
    const token=randomBytes(32).toString('base64url');
    this.store.transaction(()=>{
      const consumed=this.store.db.prepare('DELETE FROM challenges WHERE id=?').run(challenge.id);
      if(consumed.changes!==1)problem(401,'REPLAY','This authentication message was already used.');
      this.store.db.prepare('DELETE FROM sessions WHERE expires < ?').run(this.now());
      this.store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token),owner,this.now()+3_600_000);
    });
    return {token,address:owner,expiresAt:iso(this.now()+3_600_000)};
  }
  session(token) { if(typeof token!=='string'||token.length>128)return null; const s=this.store.db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(digest(token),this.now()); return s?.address || null; }
  logout(token) { if(token)this.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token)); }
  activity(owner,type,text,extra={}) { this.store.put('activity',{id:randomUUID(),owner,type,text,title:text,time:iso(this.now()),createdAt:iso(this.now()),...extra}); }
  viewPosition(p) { const mint=p.mint||p.feeKeyMint; return {...p,id:mint,mint,feeKeyMint:mint,sourceTokenAccount:p.tokenAccount,base:MINTS[p.mintA]||short(p.mintA||mint),quote:MINTS[p.mintB]||short(p.mintB||mint),protocol:'Raydium',type:'Fee rights',lock:'Permanent',duration:'Permanent',annualFees:null,fees:null,claimable:null,value:null,verifiedSlot:p.slot}; }
  viewTrade(t,owner) {
    const {settlement,approvedTransaction,submittedTransaction,...safe}=t;
    if(owner&&owner!==t.seller&&owner!==t.buyer)problem(403,'NOT_PARTICIPANT','This purchase belongs to different wallets.');
    return safe;
  }
  getListing(id) { const l=this.store.get('listing',id); if(!l)problem(404,'NOT_FOUND','Listing not found.'); return l; }
  getTrade(id,owner) { const t=this.store.get('trade',id); if(!t)problem(404,'NOT_FOUND','Purchase not found.'); if(owner!==t.seller&&owner!==t.buyer)problem(403,'NOT_PARTICIPANT','This purchase belongs to different wallets.'); return t; }
  assertActive(l) { if(l.status!=='active'||Date.parse(l.expiresAt)<=this.now())problem(409,'LISTING_UNAVAILABLE','This listing is no longer available.'); }
  release(trade) { const l=this.store.get('listing',trade.listingId); if(l?.reservedBy===trade.id){l.status=Date.parse(l.expiresAt)>this.now()?'active':'expired'; delete l.reservedBy; this.store.put('listing',l);} }
  finishPending(snapshot,status,{error,unavailable=false}={}) {
    return this.store.transaction(()=>{
      const fresh=this.store.get('trade',snapshot.id);
      if(!fresh||fresh.status!==snapshot.status||fresh.signature!==snapshot.signature||finalStates.includes(fresh.status))return false;
      fresh.status=status;if(error)fresh.error=error;this.store.put('trade',fresh);
      const listing=this.getListing(fresh.listingId),reservedHere=listing.reservedBy===fresh.id;
      this.release(fresh);
      if(unavailable&&reservedHere){const current=this.getListing(fresh.listingId);current.status='unavailable';this.store.put('listing',current);}
      return true;
    });
  }
  async reconcile() {
    if(this.reconciling)return this.reconciling;
    const operation=this.reconcileOnce();this.reconciling=operation;
    try{return await operation;}finally{this.reconciling=null;}
  }
  async reconcileOnce() {
    const pending=this.store.all('trade').filter(t=>!finalStates.includes(t.status)&&t.settlement);
    if(!pending.length)return;
    // Finalized height avoids releasing a seller reservation on a temporary fork.
    const height=await this.connection.getBlockHeight('finalized');
    for(const current of pending){
      const t=this.store.get('trade',current.id); if(!t||finalStates.includes(t.status)||!t.settlement)continue;
      if(t.signature){
        const {value}=await this.connection.getSignatureStatuses([t.signature],{searchTransactionHistory:true});
        const status=value[0];
        if(status?.err&&status.confirmationStatus==='finalized'){this.finishPending(t,'failed',{error:'The transaction failed on Solana.'});continue;}
        if(status?.confirmationStatus==='finalized'){this.complete(t,status.slot);continue;}
        // A landed transaction must not be released merely because its blockhash
        // is now old. Wait for finalization and reconcile again.
        if(status)continue;
      }
      if(height>t.settlement.lastValidBlockHeight){
        if(t.status==='approved'){
          // A buyer can broadcast outside this server after receiving approval.
          // Recover an exact finalized transaction before calling it expired.
          const external=await findExternalSettlement({connection:this.connection,settlement:t.settlement,notBeforeBlockTime:Math.floor(Date.parse(t.createdAt)/1000)-60});
          if(external){t.signature=external.signature;this.complete(t,external.slot);continue;}
        }
        let stillOwned=true;
        try{await this.verifyFeeKey({connection:this.connection,cluster:this.cluster,mint:t.mint,owner:t.seller,tokenAccount:t.settlement.sourceTokenAccount});}
        catch(error){
          // Transport errors cannot establish changed ownership; keep pending.
          if(error.name!=='RaydiumEligibilityError'&&error.name!=='SettlementError')throw error;
          stillOwned=false;
        }
        this.finishPending(t,'expired',{unavailable:!stillOwned});
      }
    }
  }
  complete(t,slot) {
    this.store.transaction(()=>{
      const fresh=this.store.get('trade',t.id);if(fresh.status==='confirmed')return;
      t.status='confirmed';t.confirmationSlot=slot;t.commitment='finalized';t.completedAt=iso(this.now());this.store.put('trade',t);
      const l=this.getListing(t.listingId);l.status='sold';l.signature=t.signature;delete l.reservedBy;this.store.put('listing',l);
      for(const other of this.store.all('trade'))if(other.listingId===l.id&&other.id!==t.id&&!finalStates.includes(other.status)){other.status='canceled';this.store.put('trade',other);}
      this.activity(t.buyer,'purchase','Fee Key received',{tradeId:t.id,signature:t.signature});
      this.activity(t.seller,'sale','Fee Key sold',{tradeId:t.id,signature:t.signature});
      this.store.put('receipt',{id:t.signature,cluster:this.cluster,signature:t.signature,slot,commitment:'finalized',mint:t.mint,buyer:t.buyer,seller:t.seller,priceLamports:t.priceLamports,messageSha256:t.settlement.messageSha256,createdAt:t.completedAt});
    });
  }
  async listings() {
    await this.reconcile();
    const output=[];
    for(const l of this.store.all('listing')){
      if(l.status!=='active'&&l.status!=='reserved')continue;
      if(Date.parse(l.expiresAt)<=this.now()&&l.status==='active'){l.status='expired';this.store.put('listing',l);continue;}
      output.push(l);
    }
    return {listings:output};
  }
  async wallet(owner,authenticatedOwner) {
    owner=address(owner);await this.reconcile();
    const [balance,result]=await Promise.all([this.connection.getBalance(new PublicKey(owner),'confirmed'),this.discoverFeeKeys({connection:this.connection,cluster:this.cluster,owner})]);
    if(!Number.isSafeInteger(balance))problem(502,'BALANCE_RANGE','RPC balance could not be represented exactly.');
    return {address:owner,balanceLamports:String(balance),positions:result.positions.map(p=>this.viewPosition(p)),rejected:result.rejected,slot:result.slot,truncated:result.truncated||false,scannedCandidates:result.scannedCandidates,totalCandidates:result.totalCandidates,
      listings:this.store.all('listing').filter(l=>l.seller===owner),
      trades:authenticatedOwner===owner?this.store.all('trade').filter(t=>t.seller===owner||t.buyer===owner).map(t=>this.viewTrade(t,owner)):[],
      activity:authenticatedOwner===owner?this.store.all('activity').filter(a=>a.owner===owner):[]};
  }
  async createListing(owner,input) {
    const lamports=price(input.priceLamports),days=input.expiresInDays??7;
    if(![1,7,30].includes(days))problem(400,'INVALID_EXPIRY','Choose a 1, 7 or 30 day listing.');
    const p=await this.verifyFeeKey({connection:this.connection,cluster:this.cluster,mint:input.mint,owner});
    if(!p?.verified)problem(400,'UNVERIFIED_FEE_KEY','Only verified Raydium CPMM Fee Keys can be listed.');
    const listing={...this.viewPosition(p),id:randomUUID(),seller:owner,priceLamports:lamports,price:Number(lamports)/1e9,status:'active',cluster:this.cluster,createdAt:iso(this.now()),expiresAt:iso(this.now()+days*86400_000),visibility:'public'};
    this.store.transaction(()=>{
      for(const old of this.store.all('listing').filter(l=>l.mint===listing.mint&&['active','reserved'].includes(l.status))){
        if(old.status==='reserved')problem(409,'ALREADY_LISTED','This Fee Key has a pending approval. Wait for settlement or expiry.');
        if(old.seller===owner&&Date.parse(old.expiresAt)>this.now())problem(409,'ALREADY_LISTED','This Fee Key already has an active listing.');
        old.status='expired';this.store.put('listing',old);
      }
      this.store.put('listing',listing);this.activity(owner,'listing','Fee Key listed',{listingId:listing.id});
    });return {listing};
  }
  async changeListing(owner,id,input,remove=false) {
    await this.reconcile();let l=this.getListing(id);
    if(l.seller!==owner)problem(403,'NOT_OWNER','Only the seller can change this listing.');
    this.assertActive(l);
    if(!remove)await this.verifyFeeKey({connection:this.connection,cluster:this.cluster,mint:l.mint,owner,tokenAccount:l.tokenAccount});
    this.store.transaction(()=>{
      l=this.getListing(id);this.assertActive(l);
      if(remove)l.status='canceled';else {l.priceLamports=price(input.priceLamports);l.price=Number(l.priceLamports)/1e9;}
      this.store.put('listing',l);
      for(const t of this.store.all('trade'))if(t.listingId===id&&t.status==='requested'){t.status='canceled';this.store.put('trade',t);}
      this.activity(owner,remove?'cancellation':'listing',remove?'Listing removed':'Listing price updated',{listingId:id});
    });return {listing:l};
  }
  async requestPurchase(owner,id) {
    await this.reconcile();const l=this.getListing(id);this.assertActive(l);
    if(l.seller===owner)problem(400,'SELF_TRADE','Choose a Fee Key listed by another wallet.');
    await this.verifyFeeKey({connection:this.connection,cluster:this.cluster,mint:l.mint,owner:l.seller,tokenAccount:l.tokenAccount});
    let trade;
    this.store.transaction(()=>{
      const latest=this.getListing(id);this.assertActive(latest);
      if(latest.priceLamports!==l.priceLamports)problem(409,'PRICE_CHANGED','Listing price changed. Review it again.');
      const prior=this.store.all('trade').find(t=>t.listingId===id&&t.buyer===owner&&!finalStates.includes(t.status));
      if(prior){trade=prior;return;}
      trade={id:randomUUID(),listingId:id,buyer:owner,seller:l.seller,mint:l.mint,priceLamports:l.priceLamports,cluster:this.cluster,status:'requested',createdAt:iso(this.now()),expiresAt:l.expiresAt};
      this.store.put('trade',trade);this.activity(l.seller,'request','Purchase approval requested',{tradeId:trade.id});this.activity(owner,'request','Purchase requested',{tradeId:trade.id});
    });return {trade:this.viewTrade(trade,owner)};
  }
  async prepare(owner,id) {
    await this.reconcile();let t=this.getTrade(id,owner);if(t.seller!==owner)problem(403,'NOT_SELLER','Only the seller can prepare this approval.');
    let l;
    this.store.transaction(()=>{
      t=this.getTrade(id,owner);if(t.status!=='requested')problem(409,'TRADE_STATE','This request is already being processed.');
      l=this.getListing(t.listingId);this.assertActive(l);
      if(l.priceLamports!==t.priceLamports)problem(409,'PRICE_CHANGED','The listing price changed. Request the purchase again.');
      t.status='preparing';l.status='reserved';l.reservedBy=t.id;this.store.put('trade',t);this.store.put('listing',l);
    });
    try{
      const result=await prepareSettlement({connection:this.connection,listing:{...l,sourceTokenAccount:l.tokenAccount},buyer:t.buyer,verifyFeeKey:this.verifyFeeKey});
      const {transaction,...settlement}=result;
      t=this.getTrade(id,owner);if(t.status!=='preparing')problem(409,'TRADE_STATE','The request was canceled during preparation.');
      t.settlement=settlement;t.status='prepared';this.store.put('trade',t);
      return {trade:this.viewTrade(t,owner),settlement};
    }catch(error){t=this.getTrade(id,owner);if(t.status==='preparing'){t.status='failed';this.store.put('trade',t);this.release(t);}throw error;}
  }
  async approve(owner,id,transactionBase64) {
    let t=this.getTrade(id,owner);if(t.seller!==owner)problem(403,'NOT_SELLER','Only the seller can approve.');
    if(t.status!=='prepared')problem(409,'TRADE_STATE','Prepare a fresh purchase approval.');
    await assertSettlementNotExpired({connection:this.connection,lastValidBlockHeight:t.settlement.lastValidBlockHeight});
    await this.verifyFeeKey({connection:this.connection,cluster:this.cluster,mint:t.mint,owner,tokenAccount:t.settlement.sourceTokenAccount});
    const verified=verifyCanonicalSignedTransaction({transactionBase64,expectedTransactionBase64:t.settlement.transactionBase64,requiredSigners:[t.seller]});
    t=this.getTrade(id,owner);if(t.status!=='prepared')problem(409,'TRADE_STATE','Request changed while approving.');
    t.approvedTransaction=verified.transactionBase64;t.status='approved';this.store.put('trade',t);this.activity(t.buyer,'approval','Seller approved your purchase',{tradeId:t.id});
    return {trade:this.viewTrade(t,owner)};
  }
  async trade(owner,id) {
    await this.reconcile();const t=this.getTrade(id,owner);const output={trade:this.viewTrade(t,owner)};
    if(t.settlement)output.settlement={...t.settlement,transactionBase64:t.approvedTransaction||t.settlement.transactionBase64};return output;
  }
  async cancel(owner,id) {
    const t=this.getTrade(id,owner);
    if(!['requested','prepared','preparing'].includes(t.status))problem(409,'APPROVAL_RELEASED','A signed approval cannot be revoked here. Wait until its blockhash expires.');
    t.status='canceled';this.store.put('trade',t);this.release(t);return {trade:this.viewTrade(t,owner)};
  }
  async submit(owner,id,transactionBase64) {
    const trade=this.getTrade(id,owner);if(trade.buyer!==owner)problem(403,'NOT_BUYER','Only the buyer can complete the purchase.');
    if(this.inflight.has(id))return this.inflight.get(id);
    const operation=this.submitOnce(owner,id,transactionBase64);this.inflight.set(id,operation);
    try{return await operation;}finally{this.inflight.delete(id);}
  }
  async submitOnce(owner,id,transactionBase64) {
    let t=this.getTrade(id,owner);if(t.buyer!==owner)problem(403,'NOT_BUYER','Only the buyer can complete the purchase.');
    if(t.status==='confirmed')return {trade:this.viewTrade(t,owner),signature:t.signature};
    if(!['approved','submitted'].includes(t.status))problem(409,'TRADE_STATE','The seller must approve this purchase first.');
    const checked=verifyCanonicalSignedTransaction({transactionBase64,expectedTransactionBase64:t.settlement.transactionBase64,requiredSigners:[t.buyer,t.seller]});
    const signature=bs58.encode(checked.transaction.signature);
    if(t.signature&&t.signature!==signature)problem(409,'SIGNATURE_CHANGED','A different transaction was already submitted.');
    // Save the deterministic signature before any network call. If send/confirm
    // times out, the receipt can be recovered instead of creating another sale.
    if(t.status==='approved'){
      await assertSettlementNotExpired({connection:this.connection,lastValidBlockHeight:t.settlement.lastValidBlockHeight});
      await this.verifyFeeKey({connection:this.connection,cluster:this.cluster,mint:t.mint,owner:t.seller,tokenAccount:t.settlement.sourceTokenAccount});
      await inspectSettlementAsset({connection:this.connection,seller:t.seller,mint:t.mint,sourceTokenAccount:t.settlement.sourceTokenAccount});
      t=this.getTrade(id,owner);if(t.status!=='approved')problem(409,'TRADE_STATE','Purchase state changed.');
      t.signature=signature;t.submittedTransaction=checked.transactionBase64;t.status='submitted';this.store.put('trade',t);
    }
    try{
      const existing=(await this.connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
      if(!existing)await this.connection.sendRawTransaction(checked.transaction.serialize(),{skipPreflight:false,maxRetries:3});
      const result=await this.connection.confirmTransaction({signature,blockhash:t.settlement.blockhash,lastValidBlockHeight:t.settlement.lastValidBlockHeight},'finalized');
      if(result.value.err){t.status='failed';t.error='The transaction failed on Solana.';this.store.put('trade',t);this.release(t);problem(409,'SETTLEMENT_FAILED',t.error);}
      this.complete(t,result.context.slot);
    }catch(error){
      if(error instanceof ApiError)throw error;
      // A transport error is not evidence of failure. Preserve the signature and
      // reservation until RPC reconciliation establishes the actual outcome.
      return {trade:this.viewTrade(this.store.get('trade',id),owner),signature,pending:true,message:'Submitted for confirmation. Check this transaction before signing anything again.'};
    }
    return {trade:this.viewTrade(this.store.get('trade',id),owner),signature};
  }
}
