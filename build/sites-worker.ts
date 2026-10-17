import handler from 'vinext/server/fetch-handler';
import { Connection } from '@solana/web3.js';
import { D1Store } from '../marketplace/src/hosted/d1-store.mjs';
import { HostedMarketplace } from '../marketplace/src/hosted/marketplace.mjs';
import { handleApi } from '../marketplace/src/hosted/http.mjs';
import { verifyNetwork } from '../marketplace/src/server/network.mjs';
import { verifyFeeKey, discoverFeeKeys } from '../marketplace/src/chain/raydium.mjs';

const publicOrigin = 'https://sona-liquidity-marketplace.official-alexslobodi.chatgpt.site';
// An immutable network identity may be cached; orders and authentication never are.
let verifiedNetwork: {endpoint:string; hash:string; until:number} | undefined;
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (['/app','/technical','/policies/terms-conditions'].includes(url.pathname)) {
      url.pathname += '/';
      return Response.redirect(url,307);
    }
    if (url.pathname.startsWith('/api/')) {
      try {
        const origin = env.SONA_ORIGIN || publicOrigin;
        if (url.origin !== origin) return Response.json({error:{code:'HOST_MISMATCH',message:'Use the configured Sona origin.'}}, {status:400});
        const endpoint = env.SONA_RPC_URL || 'https://solana-rpc.publicnode.com';
        const connection = new Connection(endpoint, {commitment:'confirmed',disableRetryOnRateLimit:true,
          fetch: (input:any,init:any)=>fetch(input,{...init,signal:AbortSignal.timeout(15_000)})});
        if (!verifiedNetwork || verifiedNetwork.endpoint!==endpoint || verifiedNetwork.until<Date.now()) {
          const hash = await verifyNetwork(connection,'mainnet-beta');
          verifiedNetwork = {endpoint,hash,until:Date.now()+300_000};
        }
        const store = new D1Store(env.DB);
        const market = await HostedMarketplace.create({store,connection,cluster:'mainnet-beta',genesisHash:verifiedNetwork.hash,origin,verifyFeeKey,discoverFeeKeys});
        return await handleApi(request,{market,origin,store});
      } catch (error) {
        console.error("Sona initialization failed", error instanceof Error ? error.name : "UnknownError");
        return Response.json({error:{code:'SERVICE_UNAVAILABLE',message:'The marketplace connection is temporarily unavailable. Please retry.'}}, {status:503,headers:{'Cache-Control':'no-store'}});
      }
    }
    if (env.ASSETS) {
      // The retained HTML, styling, fonts and images are served without a redesign.
      const assetUrl = new URL(request.url);
      if (assetUrl.pathname.endsWith('/')) assetUrl.pathname += 'index.html';
      return env.ASSETS.fetch(new Request(assetUrl,request));
    }
    return handler.fetch(request,env,ctx);
  },
};
