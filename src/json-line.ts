/**
 * The 1-based line where the value at a JSON pointer (`/items/0/status`) starts in `text`, so
 * check-run annotations land on the right line. Falls back to the nearest parent found, then 1.
 */
export function pointerLine(text: string, pointer: string): number {
  const want = pointer === '' || pointer === '/' ? [] : pointer.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let i = 0;
  let line = 1;
  let best = 1;

  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) {
      if (text[i] === '\n') line++;
      i++;
    }
  };
  const str = () => {
    let out = '';
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        out += text[i + 1] === '"' || text[i + 1] === '\\' || text[i + 1] === '/' ? text[i + 1] : '';
        i += 2;
      } else {
        if (text[i] === '\n') line++;
        out += text[i++];
      }
    }
    i++;
    return out;
  };
  /** Walks one value. `path` is where it sits; returns true once the target is reached. */
  const value = (depth: number, onPath: boolean): boolean => {
    ws();
    if (onPath) {
      best = line;
      if (depth === want.length) return true;
    }
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') return i++, false;
      for (;;) {
        ws();
        const key = str();
        ws();
        i++; // :
        if (value(depth + 1, onPath && key === want[depth])) return true;
        ws();
        if (text[i++] !== ',') return false;
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') return i++, false;
      for (let n = 0; ; n++) {
        if (value(depth + 1, onPath && String(n) === want[depth])) return true;
        ws();
        if (text[i++] !== ',') return false;
      }
    }
    if (c === '"') str();
    else while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++;
    return false;
  };

  try {
    value(0, true);
  } catch {
    // Malformed JSON: report the deepest line reached.
  }
  return best;
}
