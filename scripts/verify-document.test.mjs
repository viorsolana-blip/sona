import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyDeliveredDocument} from './verify-document.mjs';
const html='<html><body><h1>Sona</h1></body></html>\n';
const injection=readFileSync(new URL('./fixtures/cloudflare-jsd.html',import.meta.url),'utf8').replace('RAY_ID','a4c1c5efbeb2ed7a').replace('TIMESTAMP','MTc5MjI2NjAwNg==');
test('exact source HTML passes without a host injection',()=>assert.equal(verifyDeliveredDocument(html,html).hostingInjection,null));
test('only the exact observed Cloudflare script is allowed and its digest is recorded',()=>{
  for(const source of [html,html.replace('</body></html>','</body>\n</html>')]) {
    const result=verifyDeliveredDocument(source.replace('</body>',injection+'</body>'),source);
    assert.equal(result.authoredHtmlUnchanged,true);assert.match(result.hostingInjection.sha256,/^[a-f0-9]{64}$/);
  }
});
test('changes to authored content, added scripts and mutated host code fail',()=>{
  for(const actual of [html.replace('Sona','Different'),html.replace('</body>','<script>alert(1)</script></body>'),html.replace('</body>',injection.replace('visibility=\'hidden\'','visibility=\'visible\'')+'</body>'),html.replace('</body>',injection+injection+'</body>')]) assert.throws(()=>verifyDeliveredDocument(actual,html));
});
