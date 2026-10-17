import test from 'node:test';
import assert from 'node:assert/strict';
import { runSettlementLocal } from '../scripts/test-settlement-local.mjs';

test('real local-validator settlement, rollback and adversarial execution', {
  skip: process.env.SONA_LOCAL_VALIDATOR_TESTS !== '1', timeout: 180000,
}, async () => {
  const evidence = await runSettlementLocal();
  assert.equal(evidence.failed, 0);
  assert.equal(evidence.passed, 6);
  assert(evidence.cases.every((entry) => entry.passed));
});
