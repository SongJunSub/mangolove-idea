/** Last non-empty path segment (the display name of a repo/dir); falls back to the whole path. */
export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}
