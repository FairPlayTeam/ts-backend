const VIDEO_RATING_RETRY_BASE_DELAY_MS = 5;
const VIDEO_RATING_RETRY_MAX_DELAY_MS = 250;

export const calculateVideoRatingAverage = (ratingSum: number, ratingCount: number): number =>
  ratingCount === 0 ? 0 : Math.round((ratingSum / ratingCount) * 10) / 10;

export const getVideoRatingRetryDelayMs = (
  attempt: number,
  random: () => number = Math.random,
): number => {
  const exponent = Math.max(0, attempt - 1);
  const delayCeiling = Math.min(
    VIDEO_RATING_RETRY_MAX_DELAY_MS,
    VIDEO_RATING_RETRY_BASE_DELAY_MS * 2 ** exponent,
  );

  return Math.floor(random() * (delayCeiling + 1));
};
