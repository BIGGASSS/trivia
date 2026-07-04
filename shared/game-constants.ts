/**
 * Game constants shared between the browser client and the multiplayer
 * server middleware. Keep this module isomorphic: no Node or DOM APIs.
 */
export const maximumPlayerCount = 5;
export const minimumMultiplayerPlayerCount = 2;
export const defaultRoundCount = 10;
export const roundDurationSeconds = 10;
export const roomCodeCharacters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const roomCodeLength = 6;

export const countryGamePath = "/country-game";
export const soloGamePath = `${countryGamePath}/solo`;
export const multiplayerGamePath = `${countryGamePath}/multiplayer`;
