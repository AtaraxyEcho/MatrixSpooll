const IMAGE_TIER_SHORT_EDGE: Readonly<Record<string, number>> = {
  "512px": 512,
  "1k": 1024,
  "2k": 1440,
  "4k": 2160,
};

const DEFAULT_IMAGE_SHORT_EDGE = 720;
const DIMENSION_PATTERN = /^\s*(\d+)\s*[xX*×]\s*(\d+)\s*$/;
const MINIMUM_IMAGE_AREA = 1024 * 1024;
const DIMENSION_ROUND_TO = 16;

export interface ImageDimensions {
  width: number;
  height: number;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function imageShortEdgeForResolution(resolution: string): number {
  const normalized = resolution.trim().toLocaleLowerCase();
  const tier = IMAGE_TIER_SHORT_EDGE[normalized];
  if (tier) return tier;

  const dimensions = DIMENSION_PATTERN.exec(normalized);
  if (dimensions) return Math.min(Number(dimensions[1]), Number(dimensions[2]));

  if (/^\d+$/.test(normalized)) return Number(normalized);
  const pixelTier = /^(\d+)p$/.exec(normalized);
  if (pixelTier) return Number(pixelTier[1]);
  const genericTier = /^(\d+(?:\.\d+)?)k$/.exec(normalized);
  if (genericTier) return Math.round(Number(genericTier[1]) * 1024);
  return DEFAULT_IMAGE_SHORT_EDGE;
}

export function selectableImageResolutionOptions(resolutions: readonly string[]): string[] {
  const seen = new Set<string>();
  return resolutions.filter((resolution) => {
    const normalized = resolution.trim().toLocaleLowerCase();
    if (!normalized || normalized === "auto" || seen.has(normalized)) return false;
    seen.add(normalized);
    return imageShortEdgeForResolution(resolution) > 512;
  });
}

export function imageDimensionsForPreset(
  resolution: string,
  aspectRatio: string,
): ImageDimensions {
  const [rawWidth, rawHeight] = aspectRatio.split(":").map(Number);
  if (
    !Number.isInteger(rawWidth)
    || !Number.isInteger(rawHeight)
    || rawWidth <= 0
    || rawHeight <= 0
  ) {
    const edge = imageShortEdgeForResolution(resolution);
    return { width: edge, height: edge };
  }

  const divisor = greatestCommonDivisor(rawWidth, rawHeight);
  const ratioWidth = rawWidth / divisor;
  const ratioHeight = rawHeight / divisor;
  const shortUnit = Math.min(ratioWidth, ratioHeight) * DIMENSION_ROUND_TO;
  const multiplier = Math.max(1, Math.round(imageShortEdgeForResolution(resolution) / shortUnit));
  return {
    width: ratioWidth * DIMENSION_ROUND_TO * multiplier,
    height: ratioHeight * DIMENSION_ROUND_TO * multiplier,
  };
}

export function imageDimensionRangeForPreset(
  resolution: string,
  aspectRatio: string,
): { minimum: ImageDimensions; maximum: ImageDimensions } {
  const maximum = imageDimensionsForPreset(resolution, aspectRatio);
  const [rawWidth, rawHeight] = aspectRatio.split(":").map(Number);
  if (
    !Number.isInteger(rawWidth)
    || !Number.isInteger(rawHeight)
    || rawWidth <= 0
    || rawHeight <= 0
  ) {
    return { minimum: maximum, maximum };
  }

  const divisor = greatestCommonDivisor(rawWidth, rawHeight);
  const ratioWidth = rawWidth / divisor;
  const ratioHeight = rawHeight / divisor;
  const unitWidth = ratioWidth * DIMENSION_ROUND_TO;
  const unitHeight = ratioHeight * DIMENSION_ROUND_TO;
  const maximumMultiplier = Math.max(
    1,
    Math.floor(Math.min(maximum.width / unitWidth, maximum.height / unitHeight)),
  );
  const minimumMultiplier = Math.min(
    maximumMultiplier,
    Math.max(1, Math.ceil(Math.sqrt(MINIMUM_IMAGE_AREA / (unitWidth * unitHeight)))),
  );
  return {
    minimum: {
      width: unitWidth * minimumMultiplier,
      height: unitHeight * minimumMultiplier,
    },
    maximum,
  };
}

export function imageDimensionsForManualInput(
  value: number,
  axis: "width" | "height",
  resolution: string,
  aspectRatio: string,
): ImageDimensions {
  const range = imageDimensionRangeForPreset(resolution, aspectRatio);
  const [rawWidth, rawHeight] = aspectRatio.split(":").map(Number);
  if (
    !Number.isFinite(value)
    || !Number.isInteger(rawWidth)
    || !Number.isInteger(rawHeight)
    || rawWidth <= 0
    || rawHeight <= 0
  ) {
    return range.maximum;
  }

  const divisor = greatestCommonDivisor(rawWidth, rawHeight);
  const ratioWidth = rawWidth / divisor;
  const ratioHeight = rawHeight / divisor;
  const unitWidth = ratioWidth * DIMENSION_ROUND_TO;
  const unitHeight = ratioHeight * DIMENSION_ROUND_TO;
  const axisUnit = axis === "width" ? unitWidth : unitHeight;
  const requestedMultiplier = Math.max(1, Math.round(value / axisUnit));
  const minimumMultiplier = Math.ceil(range.minimum.width / unitWidth);
  const maximumMultiplier = Math.floor(range.maximum.width / unitWidth);
  const multiplier = Math.min(maximumMultiplier, Math.max(minimumMultiplier, requestedMultiplier));
  return {
    width: unitWidth * multiplier,
    height: unitHeight * multiplier,
  };
}
