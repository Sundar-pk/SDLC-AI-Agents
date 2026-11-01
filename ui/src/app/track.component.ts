import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { PHASE, type StageView } from './models';

const STEP = 88;
const PAD = 50;
const Y = 84;

interface Node {
  s: StageView; x: number; points: string | null; r: number; color: string; lines: string[];
}
interface Band { key: string; x: number; w: number; label: string; color: string }

function poly(cx: number, cy: number, r: number, sides: number, rot: number): string {
  return Array.from({ length: sides }, (_, i) => {
    const a = rot + (i * 2 * Math.PI) / sides;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');
}

function wrap(label: string): string[] {
  const words = label.split(' ');
  if (label.length <= 11 || words.length === 1) return [label];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

@Component({
  selector: 'app-track',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap" tabindex="0" aria-label="Pipeline progress">
      <svg [attr.width]="width()" height="176" [attr.viewBox]="'0 0 ' + width() + ' 176'" role="img">
        @for (b of bands(); track b.key) {
          <rect [attr.x]="b.x" y="6" [attr.width]="b.w" height="20" rx="10" [style.fill]="b.color" opacity="0.13" />
          <text [attr.x]="b.x + b.w / 2" y="20" text-anchor="middle" class="band" [style.fill]="b.color">{{ b.label }}</text>
        }
        @for (n of nodes(); track n.s.id; let i = $index) {
          @if (i > 0) {
            <line [attr.x1]="nodes()[i - 1].x + 24" [attr.x2]="n.x - 24" [attr.y1]="Y" [attr.y2]="Y" class="edge"
              [class.done]="nodes()[i - 1].s.status === 'done'" [style.stroke]="nodes()[i - 1].s.status === 'done' ? nodes()[i - 1].color : null" />
          }
        }
        @for (n of nodes(); track n.s.id) {
          <g class="node" [class]="n.s.status" [attr.transform]="'translate(' + n.x + ',' + Y + ')'">
            <title>{{ n.s.n }} · {{ n.s.label }} ({{ n.s.status }}){{ n.s.fails ? ' · failed ' + n.s.fails + ' time(s)' : '' }}</title>
            @if (n.s.status === 'current' || n.s.status === 'waiting') {
              @if (n.points) { <polygon class="ring" [attr.points]="ringPoints(n)" [style.stroke]="ringColor(n)" /> }
              @else { <circle class="ring" [attr.r]="n.r + 6" [style.stroke]="ringColor(n)" /> }
            }
            @if (n.points) {
              <polygon [attr.points]="shape(n)" class="shape" [style.fill]="fill(n)" [style.stroke]="stroke(n)" />
            } @else {
              <circle [attr.r]="n.r" class="shape" [style.fill]="fill(n)" [style.stroke]="stroke(n)" />
            }
            <text class="glyph" text-anchor="middle" dy="0.35em" [style.fill]="glyphColor(n)">{{ glyph(n) }}</text>
            @if (n.s.fails > 0) {
              <g transform="translate(17,-20)"><rect x="-11" y="-8" width="22" height="16" rx="8" class="badge" /><text class="badge-t" text-anchor="middle" dy="0.35em">✕{{ n.s.fails }}</text></g>
            }
            @for (l of n.lines; track $index) {
              <text class="label" text-anchor="middle" [attr.y]="40 + $index * 13" [class.strong]="n.s.status === 'current' || n.s.status === 'waiting'">{{ l }}</text>
            }
            <text class="kind" text-anchor="middle" [attr.y]="40 + n.lines.length * 13 + 1">{{ kindLabel(n.s.kind) }}</text>
          </g>
        }
      </svg>
    </div>
  `,
  styles: [`
    .wrap { overflow-x: auto; padding-bottom: 4px; }
    svg { display: block; min-width: 100%; }
    .band { font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
    .edge { stroke: var(--line-strong); stroke-width: 2.5; stroke-linecap: round; }
    .edge.done { stroke-width: 3.5; }
    .shape { stroke-width: 2.5; transition: fill 0.3s, stroke 0.3s; }
    .glyph { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .label { font-size: 11px; fill: var(--muted); text-anchor: middle; }
    .label.strong { fill: var(--ink); font-weight: 700; }
    .kind { font-size: 8.5px; fill: var(--faint); text-transform: uppercase; letter-spacing: 0.07em; }
    .ring { fill: none; stroke-width: 2; opacity: 0.45; transform-origin: center; animation: pulse 1.8s ease-out infinite; }
    .badge { fill: var(--c-red); }
    .badge-t { font-size: 9px; fill: #fff; font-weight: 700; }
    @keyframes pulse { 0% { transform: scale(0.92); opacity: 0.7; } 100% { transform: scale(1.22); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .ring { animation: none; opacity: 0.35; } }
  `],
})
export class TrackComponent {
  readonly stages = input.required<StageView[]>();
  readonly Y = Y;

  readonly width = computed(() => PAD * 2 + (this.stages().length - 1) * STEP);

  readonly nodes = computed<Node[]>(() =>
    this.stages().map((s, i) => {
      const x = PAD + i * STEP;
      const r = s.kind === 'end' ? 14 : s.kind === 'gate' ? 23 : s.kind === 'script' ? 22 : 19;
      const points = s.kind === 'script' ? 'hex' : s.kind === 'gate' ? 'oct' : null;
      return { s, x, r, points, color: PHASE[s.phase]?.color ?? 'var(--ink)', lines: wrap(s.label) };
    }),
  );

  readonly bands = computed<Band[]>(() => {
    const out: Band[] = [];
    for (const n of this.nodes()) {
      const last = out.at(-1);
      if (last && last.key === n.s.phase) last.w += STEP;
      else out.push({ key: n.s.phase, x: n.x - STEP / 2 + 4, w: STEP - 8, label: PHASE[n.s.phase]?.label ?? n.s.phase, color: n.color });
    }
    return out.filter((b) => b.key !== 'end').map((b) => ({ ...b, w: b.w - (b.w > STEP ? 0 : 0) }));
  });

  shape(n: Node): string { return n.s.kind === 'script' ? poly(0, 0, n.r, 6, 0) : poly(0, 0, n.r, 8, Math.PI / 8); }
  ringPoints(n: Node): string { return n.s.kind === 'script' ? poly(0, 0, n.r + 6, 6, 0) : poly(0, 0, n.r + 6, 8, Math.PI / 8); }
  ringColor(n: Node): string { return n.s.status === 'waiting' ? 'var(--c-verify)' : n.color; }
  fill(n: Node): string {
    switch (n.s.status) {
      case 'done': return n.color;
      case 'waiting': return 'var(--c-verify-soft)';
      case 'current': return 'var(--surface)';
      default: return 'var(--surface)';
    }
  }
  stroke(n: Node): string {
    switch (n.s.status) {
      case 'done': return n.color;
      case 'current': return n.color;
      case 'waiting': return 'var(--c-verify)';
      case 'blocked': return 'var(--c-red)';
      default: return 'var(--line-strong)';
    }
  }
  glyphColor(n: Node): string {
    switch (n.s.status) {
      case 'done': return '#fff';
      case 'current': return n.color;
      case 'waiting': return 'var(--c-verify-ink)';
      case 'blocked': return 'var(--c-red)';
      default: return 'var(--faint)';
    }
  }
  glyph(n: Node): string {
    if (n.s.kind === 'end') return n.s.status === 'done' ? '✓' : '■';
    if (n.s.status === 'done') return '✓';
    if (n.s.status === 'blocked') return '!';
    if (n.s.status === 'waiting') return '✋';
    return n.s.n;
  }
  kindLabel(k: string): string { return k === 'agent' ? 'agent' : k === 'script' ? 'script' : k === 'gate' ? 'person' : ''; }
}
