import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const hostingScript=readFileSync(new URL('./fixtures/cloudflare-jsd.html',import.meta.url),'utf8');

/** Compare all authored bytes, permitting only the exact observed host script. */
export function verifyDeliveredDocument(actual,expected) {
  if (actual===expected) return {authoredHtmlUnchanged:true,hostingInjection:null};
  const close='</body>';
  const split=expected.lastIndexOf(close);
  if(split<0 || !actual.startsWith(expected.slice(0,split)) || !actual.endsWith(expected.slice(split))) throw new Error('Authored document changed');
  const injected=actual.slice(split,actual.length-expected.slice(split).length);
  const normalized=injected.replace(/window\.__CF\$cv\$params=\{r:'[a-f0-9]{16}',t:'[A-Za-z0-9+/=]+'\}/,"window.__CF$cv$params={r:'RAY_ID',t:'TIMESTAMP'}");
  if(normalized!==hostingScript) throw new Error('Unrecognized hosting HTML modification');
  return {authoredHtmlUnchanged:true,hostingInjection:{type:'observed-cloudflare-javascript-detection',bytes:Buffer.byteLength(injected),sha256:createHash('sha256').update(injected).digest('hex')}};
}
