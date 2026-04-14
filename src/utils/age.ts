/**
 * Formats an ISO timestamp as a human-readable age string.
 * Examples: "now", "4m", "2h", "3d", "5mo", "1y"
 */
export function formatAge(iso: string, now?: Date): string {
  let ts: number;
  try {
    ts = new Date(iso).getTime();
    if (Number.isNaN(ts)) return "?";
  } catch {
    return "?";
  }

  const ref = (now ?? new Date()).getTime();
  const diff = (ref - ts) / 1000;

  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 30 * 86400) return `${Math.floor(diff / 86400)}d`;
  if (diff < 365 * 86400) return `${Math.floor(diff / (30 * 86400))}mo`;
  return `${Math.floor(diff / (365 * 86400))}y`;
}
