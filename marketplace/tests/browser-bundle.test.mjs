import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Keypair } from '@solana/web3.js';
import { buildSettlementTransaction } from '../src/chain/settlement.mjs';

test('production browser bundle validates a real transaction without Node globals',async()=>{
  const source=await readFile(new URL('../dist/app/wallet.js',import.meta.url),'utf8');
  const exports=/export\{([^}]+)\};/.exec(source);assert.ok(exports,'ESM bundle exports exist');
  const properties=exports[1].split(',').map(item=>{const [local,exposed]=item.trim().split(/\s+as\s+/);return `${exposed||local}:${local}`;}).join(',');
  const classic=source.replace(exports[0],`globalThis.walletExports={${properties}};`);
  const context=vm.createContext({console,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,DataView,Event,EventTarget,atob,btoa,URL,setTimeout,clearTimeout});
  assert.equal(context.Buffer,undefined);assert.equal(context.process,undefined);assert.equal(context.require,undefined);
  vm.runInContext(classic,context,{timeout:10000});
  const terms=buildSettlementTransaction({seller:Keypair.generate().publicKey,buyer:Keypair.generate().publicKey,mint:Keypair.generate().publicKey,sourceTokenAccount:Keypair.generate().publicKey,priceLamports:'123456789',blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:10});
  assert.equal(context.walletExports.assertSettlementTransaction(terms.transactionBase64,terms),true);
  assert.throws(()=>context.walletExports.assertSettlementTransaction(terms.transactionBase64,{...terms,priceLamports:'1'}),/does not match/);
});
