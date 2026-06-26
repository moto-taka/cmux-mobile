// renderGridToVT — convert a cmux "cmux.render-grid.v1" frame (from
// mobile.terminal.replay / the mobile event stream) into a VT escape-sequence
// string that reproduces the screen when fed to xterm.js via term.write().
//
// This is a faithful JS port of CMUXMobileCore's MobileTerminalRenderGridReplay
// (Swift). A `full` frame is a cold-attach snapshot (reset + repaint scrollback
// and viewport as a scrolling flow + restore modes/cursor); a delta frame
// repaints only the changed viewport rows.
//
// Wire shape (snake_case) of a render_grid frame:
//   { format, full, columns, rows, active_screen: "primary"|"alternate",
//     styles: [{ id, foreground:"#RRGGBB"|null, background, bold, faint,
//                italic, underline, blink, inverse, invisible,
//                strikethrough, overline }],
//     row_spans:        [{ row, column, style_id, text, cell_width }],
//     scrollback_rows, scrollback_spans: [RowSpan],
//     cleared_rows: [int],
//     cursor: { row, column, style:"block"|"block_hollow"|"underline"|"bar",
//               blinking, visible } | null,
//     modes: [{ code, ansi, on }],
//     terminal_foreground, terminal_background, terminal_cursor_color }

(function (global) {
  'use strict';

  // DEC private modes that switch screens / save the cursor — never replayed
  // from `modes` (active_screen is restored explicitly; replaying would
  // double-switch).
  const SCREEN_SWITCH = new Set([47, 1047, 1048, 1049]);

  const DEFAULT_STYLE = {
    id: 0, bold: false, faint: false, italic: false, underline: false,
    blink: false, inverse: false, invisible: false, strikethrough: false,
    overline: false, foreground: null, background: null,
  };

  function rgb(hex) {
    if (!hex) return null;
    const s = hex[0] === '#' ? hex.slice(1) : hex;
    if (s.length !== 6) return null;
    const n = parseInt(s, 16);
    if (Number.isNaN(n)) return null;
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }

  function sgr(style) {
    const s = style || DEFAULT_STYLE;
    const codes = ['0'];
    if (s.bold) codes.push('1');
    if (s.faint) codes.push('2');
    if (s.italic) codes.push('3');
    if (s.underline) codes.push('4');
    if (s.blink) codes.push('5');
    if (s.inverse) codes.push('7');
    if (s.invisible) codes.push('8');
    if (s.strikethrough) codes.push('9');
    if (s.overline) codes.push('53');
    const fg = rgb(s.foreground);
    if (fg) codes.push(`38;2;${fg[0]};${fg[1]};${fg[2]}`);
    const bg = rgb(s.background);
    if (bg) codes.push(`48;2;${bg[0]};${bg[1]};${bg[2]}`);
    return `\x1b[${codes.join(';')}m`;
  }

  function cursorStyleSeq(cursor) {
    let p;
    switch (cursor.style) {
      case 'underline': p = cursor.blinking ? 3 : 4; break;
      case 'bar': p = cursor.blinking ? 5 : 6; break;
      case 'block':
      case 'block_hollow':
      default: p = cursor.blinking ? 1 : 2; break;
    }
    return `\x1b[${p} q`;
  }

  function oscColor(ps, hex) {
    const c = rgb(hex);
    if (!c) return '';
    const h = (n) => n.toString(16).padStart(2, '0');
    return `\x1b]${ps};rgb:${h(c[0])}/${h(c[1])}/${h(c[2])}\x1b\\`;
  }

  function modeBytes(m) {
    const prefix = m.ansi ? '\x1b[' : '\x1b[?';
    return `${prefix}${m.code}${m.on ? 'h' : 'l'}`;
  }

  // Replace C0 controls and DEL with spaces so a span's text can never move the
  // cursor or emit its own escapes.
  function vtPrintable(text) {
    let out = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      out += (cp >= 0x20 && cp !== 0x7f) ? ch : ' ';
    }
    return out;
  }

  // Emit `lineCount` lines as a natural scrolling flow: each line resets to the
  // default style, positions its spans with CHA, separated by CRLF.
  function flowLines(spans, lineCount, stylesById, defaultStyle, terminateLast) {
    if (lineCount <= 0) return '';
    let out = '';
    const byRow = new Map();
    for (const s of spans) {
      if (!byRow.has(s.row)) byRow.set(s.row, []);
      byRow.get(s.row).push(s);
    }
    for (let line = 0; line < lineCount; line++) {
      if (line > 0) out += '\r\n';
      out += sgr(defaultStyle);
      let activeId = 0;
      const row = (byRow.get(line) || []).slice().sort((a, b) => a.column - b.column);
      for (const span of row) {
        out += `\x1b[${span.column + 1}G`;
        if (activeId !== span.style_id && stylesById.has(span.style_id)) {
          out += sgr(stylesById.get(span.style_id));
          activeId = span.style_id;
        }
        out += vtPrintable(span.text);
      }
    }
    if (terminateLast) out += '\r\n';
    return out;
  }

  function cursorRestore(rg, defaultStyle) {
    let out = sgr(defaultStyle);
    const c = rg.cursor;
    if (!c) return out + '\x1b[?25h';
    out += cursorStyleSeq(c);
    out += c.visible
      ? `\x1b[?25h\x1b[${c.row + 1};${c.column + 1}H`
      : `\x1b[?25l\x1b[${c.row + 1};${c.column + 1}H`;
    return out;
  }

  function stylesMap(styles) {
    const m = new Map();
    for (const s of (styles || [])) m.set(s.id, s);
    return m;
  }

  function fullSnapshot(rg) {
    const stylesById = stylesMap(rg.styles);
    const defaultStyle = stylesById.get(0) || DEFAULT_STYLE;
    let out = '';
    out += '\x1bc';            // RIS — reset to known state
    out += '\x1b[?2026h';     // begin synchronized update (no partial paint)
    out += oscColor(10, rg.terminal_foreground);
    out += oscColor(11, rg.terminal_background);
    out += oscColor(12, rg.terminal_cursor_color);
    out += '\x1b[?7l\x1b[?25l'; // autowrap off + cursor hidden while painting
    out += sgr(defaultStyle);

    if (rg.active_screen === 'alternate') {
      // Scrollback belongs to the primary screen: flow it there first so it is
      // preserved behind the alternate screen, then enter alt and paint the TUI.
      out += flowLines(rg.scrollback_spans || [], rg.scrollback_rows || 0, stylesById, defaultStyle, true);
      out += '\x1b[?1049h';
      out += sgr(defaultStyle);
      out += flowLines(rg.row_spans || [], rg.rows || 0, stylesById, defaultStyle, false);
    } else {
      // Primary: scrollback then the viewport as one continuous flow.
      const offset = (rg.row_spans || []).map((s) => ({
        row: s.row + (rg.scrollback_rows || 0),
        column: s.column,
        style_id: s.style_id,
        text: s.text,
        cell_width: s.cell_width,
      }));
      out += flowLines(
        (rg.scrollback_spans || []).concat(offset),
        (rg.scrollback_rows || 0) + (rg.rows || 0),
        stylesById, defaultStyle, false
      );
    }

    // Reapply modes last so autowrap returns to its captured value.
    for (const m of (rg.modes || [])) {
      if (!SCREEN_SWITCH.has(m.code)) out += modeBytes(m);
    }
    out += cursorRestore(rg, defaultStyle);
    out += '\x1b[?2026l';     // end synchronized update
    return out;
  }

  function deltaPatch(rg) {
    const stylesById = stylesMap(rg.styles);
    const defaultStyle = stylesById.get(0) || DEFAULT_STYLE;
    let out = '';
    const clear = new Set(rg.cleared_rows || []);
    for (const s of (rg.row_spans || [])) clear.add(s.row);
    const rowsToClear = Array.from(clear).sort((a, b) => a - b);
    for (const row of rowsToClear) {
      out += sgr(defaultStyle);
      out += `\x1b[${row + 1};1H\x1b[2K`;
    }
    let activeId = null;
    for (const span of (rg.row_spans || [])) {
      out += `\x1b[${span.row + 1};${span.column + 1}H`;
      if (activeId !== span.style_id && stylesById.has(span.style_id)) {
        out += sgr(stylesById.get(span.style_id));
        activeId = span.style_id;
      }
      out += vtPrintable(span.text);
    }
    out += sgr(defaultStyle);
    const c = rg.cursor;
    if (c) {
      out += cursorStyleSeq(c);
      out += c.visible
        ? `\x1b[?25h\x1b[${c.row + 1};${c.column + 1}H`
        : '\x1b[?25l';
    }
    return out;
  }

  // Accepts either a replay response ({ render_grid: {...} }) or a bare frame.
  function renderGridToVT(input) {
    const rg = input && input.render_grid ? input.render_grid : input;
    if (!rg || !rg.row_spans) return '';
    // `full` defaults to true when the key is absent (matches the Swift decoder);
    // only an explicit `false` is treated as a delta.
    return rg.full === false ? deltaPatch(rg) : fullSnapshot(rg);
  }

  global.renderGridToVT = renderGridToVT;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderGridToVT };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
