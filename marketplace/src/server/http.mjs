import { createServer } from 'node:http';
import { readFile, stat, realpath, lstat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { ApiError } from './marketplace.mjs';

const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.mp4':'video/mp4','.ico':'image/x-icon','.md':'text/plain; charset=utf-8'};
const SOURCE_FILES=['src/server/http.mjs','src/server/marketplace.mjs','src/server/store.mjs','src/server/index.mjs','src/chain/raydium.mjs','src/chain/settlement.mjs','src/client/wallet.mjs','package.json','package-lock.json','scripts/test-settlement-local.mjs','scripts/test-backend-local.mjs','scripts/verify-raydium-live.mjs','scripts/test-settlement-devnet.mjs','tests/raydium.test.mjs','tests/settlement.test.mjs','tests/marketplace.test.mjs','tests/wallet.test.mjs','evidence/RAYDIUM-SOURCES.md','evidence/raydium-mainnet-read.json','evidence/settlement-local.json','evidence/backend-local.json','evidence/settlement-devnet.json','evidence/project-status.json','docs/TECHNICAL-READINESS.md','vendor/bigint-buffer/README.md'];
SOURCE_FILES.push('tests/readiness.test.mjs','scripts/check-readiness.mjs','vendor/bigint-buffer/index.cjs','vendor/bigint-buffer/package.json','tests/bigint-buffer.test.mjs','src/client/polyfills.mjs','scripts/build-wallet.mjs','src/server/network.mjs');
function json(res,status,body) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body)); }
async function body(req) {
  const chunks=[];let length=0;
  if(!req.headers['content-type']?.startsWith('application/json'))throw new ApiError(415,'JSON_REQUIRED','Send an application/json request.');
  for await(const chunk of req){length+=chunk.length;if(length>16_384)throw new ApiError(413,'BODY_TOO_LARGE','Request is too large.');chunks.push(chunk);}
  try{const result=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!result||typeof result!=='object'||Array.isArray(result))throw Error();return result;}
  catch{throw new ApiError(400,'INVALID_JSON','Request must be a JSON object.');}
}

export function createHttpServer({market,projectRoot,origin}) {
  const root=resolve(projectRoot,'dist'), limits=new Map();
  return createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
    try{
      const host=new URL(origin).host;
      if(req.headers.host!==host)throw new ApiError(400,'HOST_MISMATCH','Use the configured Sona origin.');
      const url=new URL(req.url,origin),path=url.pathname;
      const mutating=!['GET','HEAD'].includes(req.method);
      if(mutating&&req.headers.origin&&req.headers.origin!==origin)throw new ApiError(403,'ORIGIN_MISMATCH','Cross-origin requests are not allowed.');
      if(req.headers['sec-fetch-site']==='cross-site'&&mutating)throw new ApiError(403,'ORIGIN_MISMATCH','Cross-site requests are not allowed.');
      if(path.startsWith('/api/')){
        const key=req.socket.remoteAddress,bucket=limits.get(key)||{start:Date.now(),count:0};
        if(Date.now()-bucket.start>60000){bucket.start=Date.now();bucket.count=0;}bucket.count++;limits.set(key,bucket);
        if(limits.size>10000)for(const[k,v]of limits)if(Date.now()-v.start>60000)limits.delete(k);
        if(bucket.count>180)throw new ApiError(429,'RATE_LIMIT','Too many requests. Wait a moment and retry.');
        const token=req.headers.authorization?.replace(/^Bearer /,''),owner=market.session(token);
        const auth=()=>{if(!owner)throw new ApiError(401,'AUTH_REQUIRED','Authenticate your connected wallet first.');return owner;};
        let output;
        if(req.method==='GET'&&path==='/api/config')output={cluster:market.cluster,settlementMode:'co-signed',tradingEnabled:true,protocol:'Raydium CPMM Burn & Earn',origin,networkFees:'Buyer pays Solana network and token account rent fees. Seller approves each purchase.'};
        else if(req.method==='GET'&&path==='/api/listings')output=await market.listings();
        else if(req.method==='GET'&&path==='/api/receipts')output={receipts:market.store.all('receipt')};
        else if(req.method==='GET'&&path.startsWith('/api/wallet/'))output=await market.wallet(decodeURIComponent(path.slice(12)),owner);
        else if(req.method==='POST'&&path==='/api/auth/challenge'){const input=await body(req);output=market.challenge(input.address);}
        else if(req.method==='POST'&&path==='/api/auth/verify')output=market.authenticate(await body(req));
        else if(req.method==='POST'&&path==='/api/auth/logout'){market.logout(token);output={ok:true};}
        else if(req.method==='POST'&&path==='/api/listings')output=await market.createListing(auth(),await body(req));
        else if(/^\/api\/listings\/[^/]+(?:\/request)?$/.test(path)){
          const id=path.split('/')[3];
          if(req.method==='POST'&&path.endsWith('/request')){await body(req);output=await market.requestPurchase(auth(),id);}
          else if(req.method==='PATCH')output=await market.changeListing(auth(),id,await body(req));
          else if(req.method==='DELETE')output=await market.changeListing(auth(),id,{},true);
          else throw new ApiError(405,'METHOD','Unsupported listing method.');
        }else if(/^\/api\/trades\/[^/]+(?:\/(prepare|approve|submit|cancel))?$/.test(path)){
          const [, , ,id,action]=path.split('/');auth();
          if(req.method==='GET'&&!action)output=await market.trade(owner,id);
          else if(req.method==='POST'){
            const input=await body(req);
            if(action==='prepare')output=await market.prepare(owner,id);
            else if(action==='approve')output=await market.approve(owner,id,input.transactionBase64);
            else if(action==='submit')output=await market.submit(owner,id,input.transactionBase64);
            else if(action==='cancel')output=await market.cancel(owner,id);
            else throw new ApiError(404,'NOT_FOUND','Endpoint not found.');
          }else throw new ApiError(405,'METHOD','Unsupported purchase method.');
        }else throw new ApiError(404,'NOT_FOUND','Endpoint not found.');
        json(res,200,output);return;
      }
      if(!['GET','HEAD'].includes(req.method))throw new ApiError(405,'METHOD','Read-only resource.');
      let full;
      if(path.startsWith('/source/')){
        const source=decodeURIComponent(path.slice(8));if(!SOURCE_FILES.includes(source))throw new ApiError(404,'NOT_FOUND','Source file not published.');full=resolve(projectRoot,source);
        if((await lstat(full)).isSymbolicLink()||await realpath(full)!==full)throw new ApiError(404,'NOT_FOUND','Source file not published.');
      }else{
        const relative=decodeURIComponent(path).replace(/^\/+/,''),candidate=resolve(root,relative||'index.html');
        if(!candidate.startsWith(root+sep))throw new ApiError(404,'NOT_FOUND','File not found.');
        full=candidate;const info=await stat(full);if(info.isDirectory())full=resolve(full,'index.html');
        const actual=await realpath(full);if(!actual.startsWith(root+sep))throw new ApiError(404,'NOT_FOUND','File not found.');
      }
      const data=await readFile(full);res.writeHead(200,{'Content-Type':types[extname(full)]||'application/octet-stream','Cache-Control':/\.(html|js|mjs|json)$/.test(full)?'no-cache':'public, max-age=3600'});res.end(req.method==='HEAD'?undefined:data);
    }catch(error){
      if(res.headersSent){res.destroy();return;}
      const code=typeof error.code==='string'?error.code:'UPSTREAM_UNAVAILABLE';
      const status=error.status||(code==='ENOENT'?404:code.startsWith('INVALID_')?400:502);
      const message=error instanceof ApiError||error.name==='SettlementError'||error.name==='RaydiumEligibilityError'?error.message:status===404?'Resource not found.':'The Solana data request could not be completed. Retry shortly; no successful trade is assumed.';
      json(res,status,{error:{code,message}});
    }
  });
}
