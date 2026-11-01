import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/indexer/index.js';
import { parseJava, parseTs } from '../src/indexer/parse.js';
import { findInIndex, renderContext, renderRepoMap, termsFrom } from '../src/indexer/render.js';

const JAVA = `package com.shop.orders;

import java.util.List;
import com.shop.stock.StockService;
import org.springframework.web.bind.annotation.*;

/** Orders API */
@RestController
@RequestMapping("/orders")
public class OrderController {
    private final OrderService service;
    public OrderController(OrderService service) { this.service = service; }

    @GetMapping("/{id}")
    public Order get(@PathVariable Long id) {
        if (id == null) { return null; }
        return service.find(id);
    }

    @PostMapping
    @Transactional
    public Order create(@RequestBody OrderRequest request) {
        return service.create(request);
    }

    private void helper() { }
}
`;
const SERVICE = `package com.shop.orders;
import com.shop.stock.StockService;
@Service
public class OrderService {
    private final StockService stock;
    public Order create(OrderRequest r) { return null; }
    public Order find(Long id) { String s = "class Fake {"; return null; }
}`;
const TS = `import { Component, inject } from '@angular/core';
import { OrderService } from './order.service';

@Component({
  selector: 'app-order-list',
  standalone: true,
  template: '<ul></ul>',
})
export class OrderListComponent {
  private svc = inject(OrderService);
  orders: Order[] = [];
  load(page: number): void {
    this.svc.list(page).subscribe((o) => { this.orders = o; });
  }
  private hidden() {}
}

export function formatTotal(amount: number, currency = 'EUR'): string { return ''; }
export interface Order { id: number }
`;

function project() {
  const d = mkdtempSync(join(tmpdir(), 'idx-'));
  const w = (p: string, c: string) => { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), c); };
  w('api/pom.xml', '<project/>');
  w('api/src/main/java/com/shop/orders/OrderController.java', JAVA);
  w('api/src/main/java/com/shop/orders/OrderService.java', SERVICE);
  w('api/src/main/java/com/shop/stock/StockService.java', 'package com.shop.stock;\npublic class StockService { public int level(String sku) { return 0; } }');
  w('api/src/test/java/com/shop/orders/OrderServiceTest.java', 'package com.shop.orders;\nclass OrderServiceTest {\n    @Test\n    void createsOrder() {\n    }\n}');
  w('web/package.json', '{}');
  w('web/src/app/order-list.component.ts', TS);
  w('web/src/app/order-list.component.spec.ts', "describe('x', () => {});");
  w('web/src/app/order.service.ts', "@Injectable({ providedIn: 'root' })\nexport class OrderService { list(page: number) { return null; } }");
  execFileSync('git', ['init', '-q'], { cwd: d });
  return d;
}

describe('java parsing', () => {
  const p = parseJava(JAVA);
  it('finds the type, stereotype, base path and imports', () => {
    expect(p.pkg).toBe('com.shop.orders');
    expect(p.symbols[0]).toMatchObject({ kind: 'class', name: 'OrderController', tags: ['RestController', 'base /orders'] });
    expect(p.imports).toContain('StockService');
  });
  it('finds public methods with routes and skips private ones, fields and bodies', () => {
    const m = p.symbols.filter((s) => s.kind === 'method');
    expect(m.map((x) => x.name)).toEqual(['get', 'create']);
    expect(m[0]!.tags).toEqual(['GET /{id}']);
    expect(m[1]!.tags).toEqual(['POST', 'Transactional']);
  });
  it('is not fooled by braces inside strings', () => {
    const s = parseJava(SERVICE).symbols;
    expect(s.filter((x) => x.kind === 'method').map((x) => x.name)).toEqual(['create', 'find']);
    expect(s.filter((x) => x.kind === 'class').map((x) => x.name)).toEqual(['OrderService']);
  });
});

describe('typescript parsing', () => {
  const p = parseTs(TS);
  it('finds Angular components with selector, exported functions and interfaces', () => {
    expect(p.symbols.find((s) => s.name === 'OrderListComponent')).toMatchObject({ kind: 'class', tags: ['Component app-order-list'] });
    expect(p.symbols.find((s) => s.name === 'formatTotal')).toMatchObject({ kind: 'function' });
    expect(p.symbols.find((s) => s.name === 'Order')!.kind).toBe('interface');
    expect(p.imports).toEqual(expect.arrayContaining(['Component', 'OrderService']));
  });
  it('lists public methods only', () => {
    expect(p.symbols.filter((s) => s.kind === 'method').map((s) => s.name)).toEqual(['load']);
  });
});

describe('index', () => {
  it('builds, links tests, ranks by imports, and refreshes incrementally', () => {
    const d = project();
    const first = buildIndex(d);
    expect(first.stats).toMatchObject({ total: 7, reparsed: 7, reused: 0 });
    const files = first.index.files;
    expect(files['api/src/test/java/com/shop/orders/OrderServiceTest.java']!.testFor).toBe('api/src/main/java/com/shop/orders/OrderService.java');
    expect(files['web/src/app/order-list.component.ts']!.tests).toEqual(['web/src/app/order-list.component.spec.ts']);
    expect(files['api/src/main/java/com/shop/orders/OrderService.java']!.module).toBe('api');
    expect(first.index.inbound['api/src/main/java/com/shop/stock/StockService.java']).toBe(2);

    const second = buildIndex(d);
    expect(second.stats).toMatchObject({ reparsed: 0, reused: 7 });

    writeFileSync(join(d, 'api/src/main/java/com/shop/orders/NewThing.java'), 'package x;\npublic class NewThing {}');
    const t = new Date(Date.now() + 5000); utimesSync(join(d, 'api/src/main/java/com/shop/orders/OrderService.java'), t, t);
    const third = buildIndex(d);
    expect(third.stats).toMatchObject({ reparsed: 2, total: 8 });
  });
  it('renders a repo map within its budget and a context for a ticket', () => {
    const d = project();
    const { index } = buildIndex(d);
    const map = renderRepoMap(index, 300);
    expect(map.length).toBeLessThan(300 * 4 + 400);
    expect(map).toContain('OrderController');
    expect(map).toContain('GET /{id}'.slice(0, 3));
    const ctx = renderContext(index, 'Orders list page should show the order total formatted in EUR and load more orders', 5);
    expect(ctx).toContain('order-list.component.ts');
    expect(ctx).toContain('OrderService.java');
    expect(ctx).toMatch(/tests: .*OrderServiceTest/s);
    expect(termsFrom('The OrderService must validate the stock')).toEqual(expect.arrayContaining(['order', 'service', 'validate', 'stock']));
  });
  it('finds symbols by name, route and partial name', () => {
    const { index } = buildIndex(project());
    expect(findInIndex(index, 'OrderService')[0]).toContain('OrderService');
    expect(findInIndex(index, '/orders').some((l) => l.includes('OrderController'))).toBe(true);
    expect(findInIndex(index, 'formatTotal')[0]).toContain('formatTotal(amount: number');
    expect(findInIndex(index, 'createsOrder')[0]).toContain('(test)');
  });
});
