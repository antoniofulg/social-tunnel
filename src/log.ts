const CONTROL = new RegExp("[\\x00-\\x1f\\x7f-\\x9f" + String.fromCharCode(0x2028, 0x2029) + "]", "g");

// Server- and file-supplied text reaches terminals and agents; strip control characters first.
export function sanitize(text: string): string {
  return text.replace(CONTROL, "");
}
