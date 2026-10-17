import { Connection } from '@solana/web3.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Store } from './store.mjs';
import { Marketplace } from './marketplace.mjs';
import { createHttpServer } from './http.mjs';
import { verifyFeeKey, discoverFeeKeys } from '../chain/raydium.mjs';
import { verifyNetwork } from './network.mjs';

const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
const cluster=process.env.SONA_CLUSTER||'mainnet-beta';
if(!['mainnet-beta','devnet'].includes(cluster))throw new Error('Use mainnet-beta or devnet. Local fixtures are confined to the test runner.');
const port=Number(process.env.PORT||4173),host=process.env.HOST||'127.0.0.1';
const origin=process.env.SONA_ORIGIN||`http://${host}:${port}`;
if(!['127.0.0.1','localhost','::1'].includes(new URL(origin).hostname)&&!origin.startsWith('https://'))throw new Error('Public origins must use HTTPS.');
const rpc=process.env.SONA_RPC_URL||(cluster==='mainnet-beta'?'https://api.mainnet-beta.solana.com':'https://api.devnet.solana.com');
const connection=new Connection(rpc,{commitment:'confirmed',disableRetryOnRateLimit:true,confirmTransactionInitialTimeout:60000});
let genesisHash;
try{genesisHash=await verifyNetwork(connection,cluster);}catch{console.error('Could not verify the configured Solana network. Check RPC availability and cluster settings. Server not started.');process.exit(1);}
const store=new Store(resolve(projectRoot,process.env.SONA_DB_PATH||`var/marketplace-${cluster}.sqlite`));
const market=new Marketplace({store,connection,cluster,genesisHash,origin,verifyFeeKey,discoverFeeKeys});
const server=createHttpServer({market,projectRoot,origin});
server.listen(port,host,()=>console.log(`Sona running at ${origin}/app/ (${cluster}; seller-approved atomic settlement)`));
let checking=false;
const reconciliation=setInterval(async()=>{if(checking)return;checking=true;try{await market.reconcile();}catch{ /* RPC failures retain reservations for a later check. */ }finally{checking=false;}},15000);reconciliation.unref();
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>{clearInterval(reconciliation);server.close(()=>{store.close();process.exit(0);});});
