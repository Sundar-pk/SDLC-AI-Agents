import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
const instruction = process.argv[2] ?? '';
const promptFile = /Read the file (\S+) and follow/.exec(instruction)?.[1];
const prompt = readFileSync(promptFile, 'utf8');
const stage = basename(promptFile).replace(/-\d+\.md$/, '');
const runDir = dirname(dirname(promptFile));
const ws = /Workspace \(your working directory\): (.+)/.exec(prompt)[1].trim();
const result = (extra = {}) => { mkdirSync(join(runDir, 'results'), { recursive: true }); writeFileSync(join(runDir, 'results', `${stage}.result.json`), JSON.stringify({ status: 'pass', summary: `${stage} done by scripted agent`, ...extra })); };
const out = (name, text) => writeFileSync(join(runDir, name), text);
appendFileSync(join(runDir, '..', '..', 'agent-calls.jsonl'), JSON.stringify({ stage, bug: prompt.includes('## Work type: Bug fix'), nav: prompt.includes('Finding code'), images: prompt.includes('Open the image files'), model: process.argv[3] ?? null, ctx: existsSync(join(runDir, 'context.md')) }) + '\n');
switch (stage) {
  case 'intake': out('ticket.md', `# ABC-1: Cart total ignores the discount code\n\n## Goal\nThe cart total must apply the discount percent.\n\n## Acceptance criteria\n1. 2 × 10 EUR with 10% discount gives 18 EUR.\n2. 0% discount leaves the total unchanged.\n3. 100% discount gives 0.\n\n## Attachments\n- cart-screen.png: cart page with item list, discount code box (SAVE10), subtotal 20.00, discount -2.00, total 18.00.\n\n## Confluence\nDiscounts apply to the subtotal before tax.\n`); result({ ambiguous: false, questions: [] }); break;
  case 'spec': out('spec.md', `# Spec\n\n**Observed:** total is 20 EUR with a 10% discount.\n**Expected:** 18 EUR.\n\n## Rules\n1. Given 2 × 10 EUR and 10% discount, when the total is computed, then it is 18.\n2. Given 0% discount, then total unchanged.\n3. Given 100% discount, then 0.\n\n## Root cause hypothesis\n\`cartTotal\` in \`src/total.ts\` ignores \`discountPercent\` (confidence high).\n\n## UI\n| Screen | Component | Notes |\n|---|---|---|\n| Cart | CartSummary | Show subtotal, discount and total |\n`); result(); break;
  case 'plan': out('plan.md', '# Plan\nApply the discount in `cartTotal`. No other change.\n'); out('test-plan.md', '# Test plan\n| # | Rule | Level | Test | Check |\n|---|---|---|---|---|\n| 1 | 1 | unit | appliesPercentDiscount | 18 |\n| 2 | 2 | unit | zeroDiscountKeepsTotal | 20 |\n| 3 | 3 | unit | fullDiscountIsZero | 0 |\n'); result(); break;
  case 'red': writeFileSync(join(ws, 'test', 'discount.test.ts'), `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { cartTotal } from '../src/total.ts';\ntest('appliesPercentDiscount', () => assert.strictEqual(cartTotal([{ price: 10, qty: 2 }], 10), 18));\ntest('zeroDiscountKeepsTotal', () => assert.strictEqual(cartTotal([{ price: 10, qty: 2 }], 0), 20));\ntest('fullDiscountIsZero', () => assert.strictEqual(cartTotal([{ price: 10, qty: 2 }], 100), 0));\n`); out('red-notes.md', '# RED\nAdded test/discount.test.ts. The first and third tests fail because the discount is ignored.\n'); result(); break;
  case 'test_review': out('test-review.md', '# Test review\nVerdict: pass. The reproduction test fails for the reason in the ticket.\n'); result(); break;
  case 'green': { const f = join(ws, 'src', 'total.ts'); writeFileSync(f, readFileSync(f, 'utf8').replace('/** Cart total. BUG: the discount is ignored. */', '/** Cart total with a percent discount applied to the subtotal. */').replace('return lines.reduce((sum, l) => sum + l.price * l.qty, 0);', 'const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);\n  return subtotal * (1 - discountPercent / 100);')); out('green-notes.md', '# GREEN\nApplied the discount to the subtotal in cartTotal.\n'); result(); break; }
  case 'refactor': out('refactor-notes.md', '# Refactor\nNothing needed.\n'); result(); break;
  case 'kill_survivors': out('survivors.md', '# Survivors\n| Survivor | Decision |\n|---|---|\n| StringLiteral at total.ts:4 | equivalent mutant (doc comment string) |\n'); result(); break;
  case 'code_review': out('review.md', '# Code review\nVerdict: approve.\n\n## Findings\n- minor - src/total.ts:7 - rounding of fractional cents is not specified; consider `Math.round`.\n\n## Remaining mutation survivors\n- StringLiteral at total.ts:4 (equivalent).\n'); result(); break;
  case 'reconcile': out('reconcile.md', '# Reconcile\nPlan complete. No other callers of cartTotal.\n'); result(); break;
  case 'draft_mr': out('mr-description.md', '# Apply discount in cart total\n\n## Summary\nThe cart total ignored the discount percent. It is now applied to the subtotal.\n\n## Jira\nABC-1\n\n## Tests\n3 unit tests added. Mutation score 80% (threshold 70%).\n\n## Reviewer notes\nRounding of cents is not specified.\n'); result(); break;
  default: result();
}
console.log('ok');
