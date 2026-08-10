export const calculateVideoRatingAverage = (ratingSum: number, ratingCount: number): number =>
  ratingCount === 0 ? 0 : Math.round((ratingSum / ratingCount) * 10) / 10;
