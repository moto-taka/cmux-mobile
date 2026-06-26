// @ts-ignore — browser-global module (sets globalThis.renderGridToVT), no types
import '../client/render-grid.js';
import { describe, it, expect } from 'vitest';

const renderGridToVT = (globalThis as { renderGridToVT?: (input: unknown) => string }).renderGridToVT!;

const STYLES = [
  { id: 0, foreground: '#C0CAF5', background: '#1A1B26' },
  { id: 1, foreground: '#FF0000', background: null, bold: true },
];

describe('renderGridToVT', () => {
  it('exports a function', () => {
    expect(typeof renderGridToVT).toBe('function');
  });

  it('full snapshot: RIS + sync wrap + truecolor + autowrap restore + cursor', () => {
    const vt = renderGridToVT({ render_grid: {
      format: 'cmux.render-grid.v1', full: true, columns: 5, rows: 2,
      active_screen: 'primary', scrollback_rows: 0, scrollback_spans: [],
      cleared_rows: [], styles: STYLES,
      row_spans: [{ row: 0, column: 0, style_id: 0, text: 'hi', cell_width: 2 }],
      cursor: { row: 0, column: 2, style: 'block', blinking: true, visible: true },
      modes: [{ ansi: false, code: 7, on: true }],
    }});
    expect(vt.startsWith('\x1bc\x1b[?2026h')).toBe(true); // RIS + begin sync
    expect(vt.endsWith('\x1b[?2026l')).toBe(true);          // end sync
    expect(vt).toContain('38;2;192;202;245');               // truecolor fg
    expect(vt).toContain('\x1b[?7h');                        // autowrap restored
    expect(vt).toContain('\x1b[?25h\x1b[1;3H');              // cursor row1 col3
    expect(vt).toContain('hi');
  });

  it('`full` defaults to true when the key is absent', () => {
    const vt = renderGridToVT({ render_grid: {
      format: 'cmux.render-grid.v1', columns: 3, rows: 1, active_screen: 'primary',
      styles: STYLES, row_spans: [{ row: 0, column: 0, style_id: 0, text: 'x' }],
      cursor: null, modes: [],
    }});
    expect(vt.startsWith('\x1bc')).toBe(true);
  });

  it('alternate screen flows scrollback BEFORE entering the alt buffer', () => {
    const vt = renderGridToVT({ render_grid: {
      format: 'cmux.render-grid.v1', full: true, columns: 5, rows: 1,
      active_screen: 'alternate', scrollback_rows: 1,
      scrollback_spans: [{ row: 0, column: 0, style_id: 0, text: 'old' }],
      cleared_rows: [], styles: STYLES,
      row_spans: [{ row: 0, column: 0, style_id: 0, text: 'tui' }],
      cursor: null, modes: [],
    }});
    const alt = vt.indexOf('\x1b[?1049h');
    expect(alt).toBeGreaterThanOrEqual(0);
    expect(vt.indexOf('old')).toBeLessThan(alt);   // scrollback first (primary)
    expect(vt.indexOf('tui')).toBeGreaterThan(alt); // viewport in alt buffer
  });

  it('delta patch: no RIS, clears changed rows, absolute CUP, bar cursor', () => {
    const vt = renderGridToVT({ render_grid: {
      format: 'cmux.render-grid.v1', full: false, columns: 10, rows: 3,
      active_screen: 'primary', scrollback_rows: 0, scrollback_spans: [],
      cleared_rows: [1], styles: STYLES,
      row_spans: [{ row: 0, column: 2, style_id: 1, text: 'hi', cell_width: 2 }],
      cursor: { row: 0, column: 4, style: 'bar', blinking: true, visible: true },
      modes: [],
    }});
    expect(vt.startsWith('\x1bc')).toBe(false);
    expect(vt).toContain('\x1b[2;1H\x1b[2K'); // cleared_rows row 1 (1-based)
    expect(vt).toContain('\x1b[1;1H\x1b[2K'); // span row cleared too
    expect(vt).toContain('\x1b[1;3H');        // span placed at row1 col3
    expect(vt).toContain('\x1b[5 q');         // bar+blink → DECSCUSR 5
    expect(vt).toContain('hi');
  });

  it('neutralizes control chars in span text (no escape injection)', () => {
    const vt = renderGridToVT({ render_grid: {
      format: 'cmux.render-grid.v1', full: false, columns: 10, rows: 1,
      active_screen: 'primary', cleared_rows: [], styles: STYLES,
      row_spans: [{ row: 0, column: 0, style_id: 0, text: 'a\x1b[31mb\x07c' }],
      cursor: null, modes: [],
    }});
    expect(vt).toContain('a [31mb c');          // ESC/BEL → spaces, text preserved
    expect(vt.includes('\x1b[31m')).toBe(false); // the injected SGR never fires
  });
});
