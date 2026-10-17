import handler from 'vinext/server/fetch-handler';
import { Connection } from '@solana/web3.js';
import { D1Store } from '../marketplace/src/hosted/d1-store.mjs';
import { HostedMarketplace } from '../marketplace/src/hosted/marketplace.mjs';
import { handleApi } from '../marketplace/src/hosted/http.mjs';
import { verifyNetwork } from '../marketplace/src/server/network.mjs';
import { verifyFeeKey, discoverFeeKeys } from '../marketplace/src/chain/raydium.mjs';
import { protectResponse } from '../marketplace/src/security/response-headers.mjs';
import appDocument from '../marketplace/dist/app/index.html?raw';
import technicalDocument from '../marketplace/dist/technical/index.html?raw';
import setupDocument from '../marketplace/dist/setup/index.html?raw';

const publicOrigin = 'https://sona-liquidity-marketplace.official-alexslobodi.chatgpt.site';
// An immutable network identity may be cached; orders and authentication never are.
let verifiedNetwork: {endpoint:string; hash:string; until:number} | undefined;
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (['/app','/technical','/setup','/policies/terms-conditions'].includes(url.pathname)) {
      url.pathname += '/';
      return protectResponse(Response.redirect(url,307),url.pathname);
    }
    // These exact existing documents are delivered by the Worker, because the
    // production asset gateway does not currently honor custom asset headers.
    const document = ['/app/','/app/index.html'].includes(url.pathname) ? appDocument
      : ['/technical/','/technical/index.html'].includes(url.pathname) ? technicalDocument
      : ['/setup/','/setup/index.html'].includes(url.pathname) ? setupDocument : null;
    if (document !== null) {
      if (!['GET','HEAD'].includes(request.method)) return protectResponse(new Response(null,{status:405,headers:{Allow:'GET, HEAD'}}),url.pathname);
      return protectResponse(new Response(request.method==='HEAD'?null:document,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'}}),url.pathname);
    }
    if (url.pathname.startsWith('/api/')) {
      try {
        const origin = env.SONA_ORIGIN || publicOrigin;
        if (url.origin !== origin) return protectResponse(Response.json({error:{code:'HOST_MISMATCH',message:'Use the configured Sona origin.'}}, {status:400}),url.pathname);
        const endpoint = env.SONA_RPC_URL || 'https://solana-rpc.publicnode.com';
        const connection = new Connection(endpoint, {commitment:'confirmed',disableRetryOnRateLimit:true,
          fetch: (input:any,init:any)=>fetch(input,{...init,signal:AbortSignal.timeout(15_000)})});
        if (!verifiedNetwork || verifiedNetwork.endpoint!==endpoint || verifiedNetwork.until<Date.now()) {
          const hash = await verifyNetwork(connection,'mainnet-beta');
          verifiedNetwork = {endpoint,hash,until:Date.now()+300_000};
        }
        const store = new D1Store(env.DB);
        const market = await HostedMarketplace.create({store,connection,cluster:'mainnet-beta',genesisHash:verifiedNetwork.hash,origin,verifyFeeKey,discoverFeeKeys});
        return protectResponse(await handleApi(request,{market,origin,store}),url.pathname);
      } catch (error) {
        console.error("Sona initialization failed", error instanceof Error ? error.name : "UnknownError");
        return protectResponse(Response.json({error:{code:'SERVICE_UNAVAILABLE',message:'The marketplace connection is temporarily unavailable. Please retry.'}}, {status:503,headers:{'Cache-Control':'no-store'}}),url.pathname);
      }
    }
    if (env.ASSETS) {
      // The retained HTML, styling, fonts and images are served without a redesign.
      const assetUrl = new URL(request.url);
      if (assetUrl.pathname.endsWith('/')) assetUrl.pathname += 'index.html';
      return protectResponse(await env.ASSETS.fetch(new Request(assetUrl,request)),url.pathname);
    }
    return protectResponse(await handler.fetch(request,env,ctx),url.pathname);
  },
};
