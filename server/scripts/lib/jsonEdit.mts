/**
 * Minimal in-place edits on a JSON *text*, so a one-field change stays a one-line
 * diff.
 *
 * Why not parse, mutate and re-serialize: a `.tmj` is written by Tiled in Tiled's
 * own formatting, and JSON.stringify writes it in ours. Re-serializing a map to add
 * a single field produced a 25 000-line diff, and the next save in Tiled produced
 * the reverse — a file whose formatting flip-flops between contributors cannot be
 * reviewed and cannot be merged. So: decide on the parsed model, write through
 * these.
 *
 * Deliberately not a general JSON editor. Two operations, both string-aware (a
 * brace inside a tile name must not fool the scanner), both refusing rather than
 * guessing when the text does not look the way the caller believes.
 */

/** Walk `text` from `open` (which must be `{` or `[`) to its matching close,
 *  skipping over strings and escapes. Returns the index AFTER the closing brace. */
function endOfBlock(text: string, open: number): number {
  const closing = text[open] === '{' ? '}' : ']';
  const opening = text[open];
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === opening) depth++;
    else if (c === closing) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('unbalanced JSON: no closing brace');
}

/** The `{ … }` block enclosing `at`, as a [start, end) span. */
function enclosingObject(text: string, at: number): { start: number; end: number } {
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    const c = text[i];
    if (c === '}' || c === ']') depth++;
    else if (c === '{' || c === '[') {
      if (depth === 0) {
        if (c === '[') throw new Error('enclosed by an array, not an object');
        return { start: i, end: endOfBlock(text, i) };
      }
      depth--;
    }
  }
  throw new Error('no enclosing object');
}

/** Every occurrence of `needle` outside of strings is ambiguous by definition, so
 *  callers pass something unique — e.g. `"id":430`. Throws unless it appears once. */
function onlyIndexOf(text: string, needle: string): number {
  const first = text.indexOf(needle);
  if (first < 0) throw new Error(`not found: ${needle}`);
  if (text.indexOf(needle, first + 1) >= 0) throw new Error(`not unique: ${needle}`);
  return first;
}

/** The span of `"key": <value>` at the TOP level of `block`, or null.
 *
 *  Depth-aware on purpose: an object's own `"type"` and the `"type"` of every entry
 *  in its nested `properties` array look identical to a regex, and the nested one
 *  comes first in the text — which is how a first attempt at this set a property's
 *  type to "FurnitureObject" and left the object's own class empty. */
function topLevelField(block: string, key: string): { valueStart: number; valueEnd: number } | null {
  const want = `"${key}"`;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === '"') {
      if (depth === 1 && block.startsWith(want, i)) {
        let j = i + want.length;
        while (j < block.length && /\s/.test(block[j])) j++;
        if (block[j] !== ':') continue; // a VALUE that happens to equal the key
        j++;
        while (j < block.length && /\s/.test(block[j])) j++;
        const valueStart = j;
        if (block[j] === '"') {
          j++;
          while (j < block.length) {
            if (block[j] === '\\') j += 2;
            else if (block[j] === '"') { j++; break; }
            else j++;
          }
        } else if (block[j] === '{' || block[j] === '[') {
          j = endOfBlock(block, j);
        } else {
          while (j < block.length && !/[,}\]\s]/.test(block[j])) j++;
        }
        return { valueStart, valueEnd: j };
      }
      inString = true;
    }
  }
  return null;
}

/**
 * Set a string field on the object that uniquely contains `needle`.
 *
 * Replaces the value if the key is already there (Tiled writes `"type":""` for an
 * object with no class), otherwise inserts the key right after the opening brace,
 * copying the indentation of the line that follows it.
 */
export function setStringField(text: string, needle: string, key: string, value: string): string {
  const { start, end } = enclosingObject(text, onlyIndexOf(text, needle));
  const block = text.slice(start, end);
  const field = topLevelField(block, key);
  if (field) {
    const replaced = block.slice(0, field.valueStart) + JSON.stringify(value) + block.slice(field.valueEnd);
    return text.slice(0, start) + replaced + text.slice(end);
  }
  // Indentation of the first field, so the inserted line sits with its siblings.
  const indent = /\{\s*?\n(\s*)/.exec(block)?.[1] ?? ' ';
  const inserted = `{\n${indent}${JSON.stringify(key)}:${JSON.stringify(value)},` + block.slice(1);
  return text.slice(0, start) + inserted + text.slice(end);
}

/**
 * Remove the object that uniquely contains `needle` from the array it sits in,
 * together with the comma that joined it.
 *
 * Used to drop a property a placement must not carry. Leaves an empty array as
 * `[]` rather than inventing whitespace.
 */
export function removeObjectContaining(text: string, needle: string): string {
  const { start, end } = enclosingObject(text, onlyIndexOf(text, needle));
  let from = start;
  let to = end;
  // Eat the separating comma — the one before if this is not the first element,
  // else the one after — plus the whitespace that came with it.
  const before = text.slice(0, start);
  const commaBefore = /,\s*$/.exec(before);
  const commaAfter = /^\s*,/.exec(text.slice(end));
  if (commaBefore) from = start - commaBefore[0].length;
  else if (commaAfter) to = end + commaAfter[0].length;
  const out = text.slice(0, from) + text.slice(to);
  // Removing the last element leaves the array's own line breaks behind, which show
  // up in a diff as two lines of nothing. Collapse an emptied array to `[]` — the
  // shape Tiled itself writes.
  const emptied = /\[\s+\]/.exec(out.slice(Math.max(0, from - 200), from + 200));
  if (!emptied) return out;
  const at = Math.max(0, from - 200) + emptied.index;
  return out.slice(0, at) + '[]' + out.slice(at + emptied[0].length);
}

/**
 * Remove the object containing `inner` from within the object containing `outer`.
 *
 * The scoped form, and the one a map needs: `"name":"label"` occurs in every
 * placement in the file, so it identifies nothing on its own — but inside ONE
 * placement (anchored by its `"id":<n>`) it is unique. Refuses if it is not.
 */
export function removeObjectWithin(text: string, outer: string, inner: string): string {
  const span = enclosingObject(text, onlyIndexOf(text, outer));
  const block = text.slice(span.start, span.end);
  const edited = removeObjectContaining(block, inner);
  return text.slice(0, span.start) + edited + text.slice(span.end);
}

/**
 * Remove a top-level field from the object that uniquely contains `needle`.
 *
 * For the case where a placement loses its LAST property: an empty
 * `"properties":[]` is valid JSON but not something Tiled ever writes, so leaving one
 * behind means the next save in Tiled shows up as a diff nobody made.
 */
export function removeField(text: string, needle: string, key: string): string {
  const span = enclosingObject(text, onlyIndexOf(text, needle));
  const block = text.slice(span.start, span.end);
  const field = topLevelField(block, key);
  if (!field) return text;
  // Back up over the key and its quotes, forward over a trailing comma, and take the
  // whitespace of whichever side is being closed up.
  const keyAt = block.lastIndexOf(`"${key}"`, field.valueStart);
  let from = keyAt;
  let to = field.valueEnd;
  const commaAfter = /^\s*,/.exec(block.slice(to));
  if (commaAfter) to += commaAfter[0].length;
  else {
    const commaBefore = /,\s*$/.exec(block.slice(0, from));
    if (commaBefore) from -= commaBefore[0].length;
  }
  const leadingWs = /\s*$/.exec(block.slice(0, from));
  if (commaAfter && leadingWs) from -= leadingWs[0].length;
  const edited = block.slice(0, from) + block.slice(to);
  return text.slice(0, span.start) + edited + text.slice(span.end);
}
