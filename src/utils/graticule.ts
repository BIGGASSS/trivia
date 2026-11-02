/**
 * Graticule lines (meridians and parallels) for the equirectangular
 * `-180 -90 360 180` map space. Drawn under the countries to give the
 * chart its survey-sheet structure; purely decorative and non-interactive.
 */
export const buildGraticulePath = (step = 30) => {
  const segments: string[] = [];

  for (let longitude = -180 + step; longitude < 180; longitude += step) {
    segments.push(`M${longitude},-90V90`);
  }

  for (let latitude = -90 + step; latitude < 90; latitude += step) {
    segments.push(`M-180,${latitude}H180`);
  }

  return segments.join("");
};

/** The equator and prime meridian, drawn slightly stronger than the grid. */
export const primeLinesPath = "M-180,0H180M0,-90V90";
