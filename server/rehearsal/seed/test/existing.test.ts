import { test } from 'node:test';
import assert from 'node:assert';
import { cartTotal } from '../src/total.ts';
test('sums lines', () => assert.strictEqual(cartTotal([{ price: 10, qty: 2 }]), 20));
