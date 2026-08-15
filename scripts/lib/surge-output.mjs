export function redactSurgeOutputLine(line) {
  const text = String(line);
  if (!text.includes("Running as ")) return text;
  return text.replace(/(Running as\s+)([^\s]+@[^\s]+)(\s+\([^\r\n)]*\))?/u, "$1[redacted-email]$3");
}
