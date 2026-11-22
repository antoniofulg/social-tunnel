// C0, DEL and C1 controls, line separators, and the invisible format characters (soft hyphen,
// Arabic letter mark, zero-width, bidi overrides and isolates, word joiner and invisible
// operators, BOM, tag characters) that can reorder or hide text on a terminal.
const CONTROL = new RegExp(
  "[\\x00-\\x1f\\x7f-\\x9f\\u00ad\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff\\u{e0000}-\\u{e007f}]",
  "gu",
);

// Server- and file-supplied text reaches terminals and agents; strip control characters first.
export function sanitize(text: string): string {
  return text.replace(CONTROL, "");
}

export type Log = (message: string, fields?: Record<string, string | number | null | undefined>) => void;

// Messages are fixed text; anything that came from the server or a request goes in `fields`, where
// strings are sanitised. With `json`, each line is one JSON object.
export function createLogger(write: (text: string) => void, json: boolean): Log {
  return (message, fields = {}) => {
    const clean: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== null && value !== undefined) clean[key] = typeof value === "string" ? sanitize(value) : value;
    }
    const time = new Date().toISOString();
    if (json) return write(JSON.stringify({ time, message, ...clean }) + "\n");
    // A value that could read as more than one field (space, `=`, quote, backslash, or empty) is
    // printed as a JSON string, so server text cannot forge a field.
    const text = (value: string | number) =>
      typeof value === "string" && (value === "" || /[\s="\\]/.test(value)) ? JSON.stringify(value) : value;
    const tail = Object.entries(clean).map(([key, value]) => ` ${key}=${text(value)}`);
    write(`${time} ${message}${tail.join("")}\n`);
  };
}
