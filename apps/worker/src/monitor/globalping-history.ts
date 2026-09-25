import type { GlobalpingRegionResult } from './globalping';

export const GLOBALPING_HISTORY_INTERVAL_SECONDS = 15 * 60;

type PreviousRegion = Pick<GlobalpingRegionResult, 'location' | 'status' | 'error'>;

function parsePreviousRegions(value: string | null): PreviousRegion[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        location: typeof item.location === 'string' ? item.location : '',
        status:
          item.status === 'up' || item.status === 'down' || item.status === 'unknown'
            ? item.status
            : 'unknown',
        error: typeof item.error === 'string' && item.error.length > 0 ? item.error : null,
      }));
  } catch {
    return null;
  }
}

function transitionSignature(regions: readonly PreviousRegion[]): string {
  return [...regions]
    .map((region) => ({
      location: region.location,
      status: region.status,
      hasError: region.error !== null,
    }))
    .sort((a, b) => a.location.localeCompare(b.location))
    .map((region) => `${region.location}\u0000${region.status}\u0000${region.hasError ? 1 : 0}`)
    .join('\u0001');
}

export function shouldPersistGlobalpingHistory(input: {
  checkedAt: number;
  lastHistoryWrittenAt: number | null;
  previousResultsJson: string | null;
  currentResults: readonly GlobalpingRegionResult[];
}): boolean {
  if (input.lastHistoryWrittenAt === null) return true;
  if (input.checkedAt - input.lastHistoryWrittenAt >= GLOBALPING_HISTORY_INTERVAL_SECONDS) {
    return true;
  }

  const previous = parsePreviousRegions(input.previousResultsJson);
  if (previous === null) return true;

  return transitionSignature(previous) !== transitionSignature(input.currentResults);
}
