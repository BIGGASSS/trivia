<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

type Position = number[];
type LinearRing = Position[];
type PolygonCoordinates = LinearRing[];
type MultiPolygonCoordinates = PolygonCoordinates[];
type AnswerState = "idle" | "correct" | "incorrect";
type GameMode = "solo" | "multiplayer";
type GamePhase = "setup" | "playing" | "results";
type MultiplayerSetupAction = "create" | "join";
type RoomConnectionState = "connected" | "reconnecting" | "offline";

interface MapPoint {
  x: number;
  y: number;
}

interface Player {
  id: string;
  name: string;
  score: number;
  attempts: number;
  streak: number;
}

interface MultiplayerPlayer extends Player {
  isHost: boolean;
  connected: boolean;
  hasAnswered: boolean;
}

interface PlayerFeedback {
  state: AnswerState;
  message: string;
  selectedCountryId: string | null;
}

interface MultiplayerRoomState {
  roomCode: string;
  status: "lobby" | "playing" | "results";
  hostId: string;
  playerId: string;
  maxPlayers: number;
  minPlayers: number;
  roundCount: number;
  currentRound: number;
  roundDurationSeconds: number;
  roundEndsAt: number | null;
  currentCountryName: string | null;
  revealCountryId: string | null;
  roundLocked: boolean;
  canStart: boolean;
  players: MultiplayerPlayer[];
  ownFeedback: PlayerFeedback | null;
}

interface MultiplayerApiResponse {
  playerId?: string;
  room: MultiplayerRoomState;
}

type CountryGeometry =
  | {
      type: "Polygon";
      coordinates: PolygonCoordinates;
    }
  | {
      type: "MultiPolygon";
      coordinates: MultiPolygonCoordinates;
    };

interface CountryFeature {
  type: "Feature";
  id?: string;
  properties?: {
    name?: string;
  };
  geometry: CountryGeometry | null;
}

interface CountryFeatureCollection {
  type: "FeatureCollection";
  features: CountryFeature[];
}

interface CountryPath {
  id: string;
  name: string;
  path: string;
}

interface LeaderboardPlayer extends Player {
  accuracyLabel: string;
  accuracyValue: number;
  connected?: boolean;
  hasAnswered?: boolean;
  isHost?: boolean;
  originalIndex: number;
}

interface StoredMultiplayerSession {
  playerId: string;
  playerName: string;
  roomCode: string;
  updatedAt: number;
}

type GameRoute =
  | { type: "setup" }
  | { type: "solo" }
  | { type: "multiplayer-setup" }
  | { type: "multiplayer-room"; roomCode: string; playerId: string | null };

const mapBounds = {
  x: -180,
  y: -90,
  width: 360,
  height: 180,
};
const minimumMapZoom = 1;
const maximumMapZoom = 8;
const zoomStep = 1.35;
const dragClickThreshold = 4;
const maximumPlayerCount = 5;
const minimumMultiplayerPlayerCount = 2;
const defaultRoundCount = 10;
const maximumRoundCount = 50;
const roundDurationSeconds = 10;
const roomConnectionStaleMilliseconds = 6500;
const roomSyncIntervalMilliseconds = 2000;
const roomReconnectCooldownMilliseconds = 4000;
const roundDeadlineSyncGraceMilliseconds = 250;
const countryGamePath = "/country-game";
const soloGamePath = `${countryGamePath}/solo`;
const multiplayerGamePath = `${countryGamePath}/multiplayer`;
const multiplayerSessionStorageKey = "world-trivia.multiplayer-sessions";

const countries = ref<CountryPath[]>([]);
const currentCountry = ref<CountryPath | null>(null);
const selectedMode = ref<GameMode>("multiplayer");
const gamePhase = ref<GamePhase>("setup");
const multiplayerSetupAction = ref<MultiplayerSetupAction>("create");
const multiplayerPlayerName = ref("Player 1");
const multiplayerRoomCodeInput = ref("");
const multiplayerErrorMessage = ref("");
const isMultiplayerBusy = ref(false);
const isSubmittingAnswer = ref(false);
const roomState = ref<MultiplayerRoomState | null>(null);
const roomEvents = ref<EventSource | null>(null);
const roomConnectionState = ref<RoomConnectionState>("connected");
const lastRoomEventAt = ref(0);
const lastRoomSyncAt = ref(0);
const lastRoomReconnectAttemptAt = ref(0);
const isRoomSyncInFlight = ref(false);
const roundCountSetting = ref(defaultRoundCount);
const totalRounds = ref(defaultRoundCount);
const soloCurrentRound = ref(0);
const soloPlayer = ref<Player>({
  id: "solo-player",
  name: "Solo Player",
  score: 0,
  attempts: 0,
  streak: 0,
});
const soloTimeLeft = ref(roundDurationSeconds);
const now = ref(Date.now());
const feedbackMessage = ref("Configure a game to begin.");
const answerState = ref<AnswerState>("idle");
const lastSelectedCountryId = ref<string | null>(null);
const isRoundLocked = ref(false);
const isLoading = ref(true);
const errorMessage = ref("");
const nextRoundTimeout = ref<number | null>(null);
const roundTimer = ref<number | null>(null);
const clockTimer = ref<number | null>(null);
const mapSvg = ref<SVGSVGElement | null>(null);
const zoomLevel = ref(1);
const mapCenter = ref<MapPoint>({ x: 0, y: 0 });
const isPanning = ref(false);
const panStartClient = ref<MapPoint | null>(null);
const panStartCenter = ref<MapPoint>({ x: 0, y: 0 });
const panStartScale = ref<MapPoint>({ x: 1, y: 1 });
const hasDraggedMap = ref(false);
const suppressNextCountryClick = ref(false);
let isSyncingRoute = false;
let roomSyncRequestId = 0;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

const normalizeRoomCode = (roomCode: string) =>
  roomCode
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

const buildRoomPath = (roomCode: string) =>
  `${multiplayerGamePath}/${encodeURIComponent(normalizeRoomCode(roomCode))}`;

const setGamePath = (path: string, replace = false) => {
  const currentPath = `${window.location.pathname}${window.location.search}`;

  if (currentPath === path) {
    return;
  }

  if (replace) {
    window.history.replaceState({}, "", path);
    return;
  }

  window.history.pushState({}, "", path);
};

const parseGameRoute = (): GameRoute => {
  const segments = window.location.pathname.split("/").filter(Boolean);

  if (segments[0] !== "country-game") {
    return { type: "setup" };
  }

  if (segments[1] === "solo") {
    return { type: "solo" };
  }

  if (segments[1] === "multiplayer") {
    const roomCode = normalizeRoomCode(segments[2] ?? "");

    if (roomCode) {
      const searchParameters = new URLSearchParams(window.location.search);
      const playerId =
        searchParameters.get("playerId") ?? searchParameters.get("player");

      return { type: "multiplayer-room", roomCode, playerId };
    }

    return { type: "multiplayer-setup" };
  }

  return { type: "setup" };
};

const getStoredMultiplayerSessions = () => {
  try {
    const storedValue = window.localStorage.getItem(
      multiplayerSessionStorageKey,
    );

    if (!storedValue) {
      return {} as Record<string, StoredMultiplayerSession>;
    }

    const parsedValue = JSON.parse(storedValue) as Record<
      string,
      StoredMultiplayerSession
    >;

    return parsedValue && typeof parsedValue === "object"
      ? parsedValue
      : ({} as Record<string, StoredMultiplayerSession>);
  } catch {
    return {} as Record<string, StoredMultiplayerSession>;
  }
};

const getStoredMultiplayerSession = (roomCode: string) =>
  getStoredMultiplayerSessions()[normalizeRoomCode(roomCode)] ?? null;

const saveMultiplayerSession = (room: MultiplayerRoomState) => {
  const self = room.players.find((player) => player.id === room.playerId);
  const sessions = getStoredMultiplayerSessions();

  sessions[room.roomCode] = {
    playerId: room.playerId,
    playerName: self?.name ?? multiplayerPlayerName.value,
    roomCode: room.roomCode,
    updatedAt: Date.now(),
  };

  window.localStorage.setItem(
    multiplayerSessionStorageKey,
    JSON.stringify(sessions),
  );
};

const removeMultiplayerSession = (roomCode: string) => {
  const sessions = getStoredMultiplayerSessions();

  delete sessions[normalizeRoomCode(roomCode)];
  window.localStorage.setItem(
    multiplayerSessionStorageKey,
    JSON.stringify(sessions),
  );
};

const normalizedJoinRoomCode = computed(() =>
  normalizeRoomCode(multiplayerRoomCodeInput.value),
);

const isServerMultiplayerActive = computed(() => roomState.value !== null);
const isPlayingGame = computed(
  () =>
    roomState.value?.status === "playing" ||
    (!roomState.value && gamePhase.value === "playing"),
);
const multiplayerConnectionMessage = computed(() => {
  if (!roomState.value || roomConnectionState.value === "connected") {
    return "";
  }

  if (roomConnectionState.value === "offline") {
    return "You're offline. The room will resync automatically when the connection returns.";
  }

  return isRoomSyncInFlight.value
    ? "Connection hiccup detected. Resyncing room state…"
    : "Live room updates paused. Reconnecting automatically…";
});
const multiplayerSelf = computed(() => {
  const room = roomState.value;

  if (!room) {
    return null;
  }

  return room.players.find((player) => player.id === room.playerId) ?? null;
});
const isMultiplayerHost = computed(
  () => roomState.value?.hostId === roomState.value?.playerId,
);
const answeredPlayersCount = computed(
  () =>
    roomState.value?.players.filter((player) => player.hasAnswered).length ?? 0,
);
const displayPlayers = computed<Player[]>(() => {
  if (roomState.value) {
    return roomState.value.players;
  }

  return [soloPlayer.value];
});
const scoreboardPlayer = computed<Player>(() =>
  multiplayerSelf.value ? multiplayerSelf.value : soloPlayer.value,
);
const displayRoundCount = computed(
  () => roomState.value?.roundCount ?? totalRounds.value,
);
const displayRoundDurationSeconds = computed(
  () => roomState.value?.roundDurationSeconds ?? roundDurationSeconds,
);

const currentRoundNumber = computed(() => {
  if (roomState.value) {
    return Math.max(1, roomState.value.currentRound || 1);
  }

  return Math.max(1, soloCurrentRound.value || 1);
});

const targetCountryName = computed(() => {
  if (roomState.value) {
    return roomState.value.currentCountryName;
  }

  return currentCountry.value?.name ?? null;
});

const activeAccuracy = computed(() => {
  const player = scoreboardPlayer.value;

  if (player.attempts === 0) {
    return "0%";
  }

  return `${Math.round((player.score / player.attempts) * 100)}%`;
});

const roundSummary = computed(() => {
  if (roomState.value) {
    if (roomState.value.status === "lobby") {
      return `${roomState.value.players.length} of ${roomState.value.maxPlayers} players joined`;
    }

    if (roomState.value.status === "results") {
      return `${roomState.value.roundCount} rounds complete`;
    }

    return `Round ${roomState.value.currentRound} of ${roomState.value.roundCount} · ${answeredPlayersCount.value}/${roomState.value.players.length} answered`;
  }

  return `Round ${currentRoundNumber.value} of ${totalRounds.value}`;
});

const displayTimeLeft = computed(() => {
  const room = roomState.value;

  if (!room || room.status !== "playing") {
    return soloTimeLeft.value;
  }

  if (room.roundLocked || !room.roundEndsAt) {
    return 0;
  }

  return clamp(
    Math.ceil((room.roundEndsAt - now.value) / 1000),
    0,
    room.roundDurationSeconds,
  );
});

const timerPercent = computed(() => {
  const clampedTime = clamp(
    displayTimeLeft.value,
    0,
    displayRoundDurationSeconds.value,
  );

  return `${(clampedTime / displayRoundDurationSeconds.value) * 100}%`;
});

const timerIsLow = computed(
  () =>
    (roomState.value?.status === "playing" || gamePhase.value === "playing") &&
    !displayRoundLocked.value &&
    displayTimeLeft.value <= 3,
);

const displayAnswerState = computed<AnswerState>(() => {
  if (roomState.value) {
    return roomState.value.ownFeedback?.state ?? "idle";
  }

  return answerState.value;
});

const displayFeedbackMessage = computed(() => {
  const room = roomState.value;

  if (!room) {
    return feedbackMessage.value;
  }

  if (room.status === "lobby") {
    return isMultiplayerHost.value
      ? "Share the room code, then start when everyone has joined."
      : "Waiting for the host to start the match.";
  }

  if (room.status === "results") {
    return "Game over! Check the final leaderboard.";
  }

  if (displayTimeLeft.value <= 0 && !room.roundLocked) {
    return "Round ended. Syncing the reveal…";
  }

  if (room.ownFeedback) {
    return room.ownFeedback.message;
  }

  if (multiplayerSelf.value?.hasAnswered) {
    return "Answer submitted. Waiting for the round reveal.";
  }

  return `Find ${room.currentCountryName ?? "the prompted country"} before the timer expires.`;
});

const displaySelectedCountryId = computed(() => {
  if (roomState.value) {
    return roomState.value.ownFeedback?.selectedCountryId ?? null;
  }

  return lastSelectedCountryId.value;
});

const missedTargetCountryId = computed(() => {
  if (roomState.value) {
    return displayAnswerState.value === "incorrect"
      ? roomState.value.revealCountryId
      : null;
  }

  return displayAnswerState.value === "incorrect"
    ? (currentCountry.value?.id ?? null)
    : null;
});

const displayRoundLocked = computed(() => {
  if (roomState.value) {
    return (
      roomState.value.roundLocked ||
      (multiplayerSelf.value?.hasAnswered ?? false)
    );
  }

  return isRoundLocked.value;
});

const isMapGuessingDisabled = computed(() => {
  if (roomState.value) {
    return (
      roomState.value.status !== "playing" ||
      roomState.value.roundLocked ||
      displayTimeLeft.value <= 0 ||
      (multiplayerSelf.value?.hasAnswered ?? false) ||
      isSubmittingAnswer.value
    );
  }

  return (
    !currentCountry.value ||
    isRoundLocked.value ||
    gamePhase.value !== "playing"
  );
});

const leaderboard = computed<LeaderboardPlayer[]>(() =>
  displayPlayers.value
    .map((player, originalIndex) => {
      const multiplayerPlayer = player as Partial<MultiplayerPlayer>;
      const accuracyValue =
        player.attempts === 0 ? 0 : player.score / player.attempts;

      return {
        ...player,
        accuracyLabel: `${Math.round(accuracyValue * 100)}%`,
        accuracyValue,
        connected: multiplayerPlayer.connected,
        hasAnswered: multiplayerPlayer.hasAnswered,
        isHost: multiplayerPlayer.isHost,
        originalIndex,
      };
    })
    .sort((firstPlayer, secondPlayer) => {
      if (secondPlayer.score !== firstPlayer.score) {
        return secondPlayer.score - firstPlayer.score;
      }

      if (secondPlayer.accuracyValue !== firstPlayer.accuracyValue) {
        return secondPlayer.accuracyValue - firstPlayer.accuracyValue;
      }

      return firstPlayer.originalIndex - secondPlayer.originalIndex;
    }),
);

const mapViewBox = computed(() => {
  const width = mapBounds.width / zoomLevel.value;
  const height = mapBounds.height / zoomLevel.value;
  const x = mapCenter.value.x - width / 2;
  const y = mapCenter.value.y - height / 2;

  return `${x} ${y} ${width} ${height}`;
});

const zoomPercent = computed(() => `${Math.round(zoomLevel.value * 100)}%`);
const canZoomIn = computed(() => zoomLevel.value < maximumMapZoom);
const canZoomOut = computed(() => zoomLevel.value > minimumMapZoom);

const getViewBoxSize = (zoom: number) => ({
  width: mapBounds.width / zoom,
  height: mapBounds.height / zoom,
});

const getClampedCenter = (center: MapPoint, zoom: number) => {
  const { width, height } = getViewBoxSize(zoom);
  const minimumX = mapBounds.x + width / 2;
  const maximumX = mapBounds.x + mapBounds.width - width / 2;
  const minimumY = mapBounds.y + height / 2;
  const maximumY = mapBounds.y + mapBounds.height - height / 2;

  return {
    x: clamp(center.x, minimumX, maximumX),
    y: clamp(center.y, minimumY, maximumY),
  };
};

const setMapCenter = (center: MapPoint) => {
  mapCenter.value = getClampedCenter(center, zoomLevel.value);
};

const coordinateToPoint = (coordinate: Position) => {
  const longitude = coordinate[0] ?? 0;
  const latitude = coordinate[1] ?? 0;

  return `${longitude},${-latitude}`;
};

const ringToPath = (ring: LinearRing) => {
  const firstCoordinate = ring[0];

  if (!firstCoordinate) {
    return "";
  }

  const commands = [`M${coordinateToPoint(firstCoordinate)}`];

  for (let index = 1; index < ring.length; index += 1) {
    const coordinate = ring[index];

    if (coordinate) {
      commands.push(`L${coordinateToPoint(coordinate)}`);
    }
  }

  commands.push("Z");

  return commands.join(" ");
};

const geometryToPath = (geometry: CountryGeometry | null) => {
  if (!geometry) {
    return "";
  }

  if (geometry.type === "Polygon") {
    return geometry.coordinates.map(ringToPath).join(" ");
  }

  return geometry.coordinates
    .flatMap((polygon) => polygon.map(ringToPath))
    .join(" ");
};

function clearPendingRound() {
  if (nextRoundTimeout.value !== null) {
    window.clearTimeout(nextRoundTimeout.value);
    nextRoundTimeout.value = null;
  }
}

function clearRoundTimer() {
  if (roundTimer.value !== null) {
    window.clearInterval(roundTimer.value);
    roundTimer.value = null;
  }
}

function clearClockTimer() {
  if (clockTimer.value !== null) {
    window.clearInterval(clockTimer.value);
    clockTimer.value = null;
  }
}

const getRandomCountry = (excludedCountryId?: string) => {
  const choices = excludedCountryId
    ? countries.value.filter((country) => country.id !== excludedCountryId)
    : countries.value;
  const availableChoices = choices.length > 0 ? choices : countries.value;
  const randomIndex = Math.floor(Math.random() * availableChoices.length);
  const country = availableChoices[randomIndex];

  return country ?? null;
};

const getConfiguredRoundCount = () => {
  const numericRoundCount =
    Number(roundCountSetting.value) || defaultRoundCount;
  const clampedRoundCount = clamp(
    Math.round(numericRoundCount),
    1,
    maximumRoundCount,
  );

  roundCountSetting.value = clampedRoundCount;

  return clampedRoundCount;
};

function resetSoloPlayer() {
  soloPlayer.value = {
    id: "solo-player",
    name: "Solo Player",
    score: 0,
    attempts: 0,
    streak: 0,
  };
}

function finishSoloGame() {
  clearPendingRound();
  clearRoundTimer();
  gamePhase.value = "results";
  currentCountry.value = null;
  isRoundLocked.value = true;
  answerState.value = "idle";
  feedbackMessage.value = "Game over! Check the leaderboard.";
}

function scheduleNextSoloRound(delay: number) {
  clearPendingRound();

  nextRoundTimeout.value = window.setTimeout(() => {
    if (soloCurrentRound.value >= totalRounds.value) {
      finishSoloGame();
      return;
    }

    startSoloRound();
  }, delay);
}

function resolveSoloRound(isCorrect: boolean, feedback: string, delay: number) {
  if (
    !currentCountry.value ||
    isRoundLocked.value ||
    gamePhase.value !== "playing"
  ) {
    return;
  }

  clearRoundTimer();
  isRoundLocked.value = true;
  answerState.value = isCorrect ? "correct" : "incorrect";
  feedbackMessage.value = feedback;
  soloPlayer.value.attempts += 1;

  if (isCorrect) {
    soloPlayer.value.score += 1;
    soloPlayer.value.streak += 1;
  } else {
    soloPlayer.value.streak = 0;
  }

  scheduleNextSoloRound(delay);
}

function handleSoloRoundTimeout() {
  if (
    !currentCountry.value ||
    isRoundLocked.value ||
    gamePhase.value !== "playing"
  ) {
    return;
  }

  lastSelectedCountryId.value = null;
  resolveSoloRound(
    false,
    `Time's up! The correct answer was ${currentCountry.value.name}.`,
    1400,
  );
}

function startSoloRoundTimer() {
  clearRoundTimer();
  soloTimeLeft.value = roundDurationSeconds;

  roundTimer.value = window.setInterval(() => {
    if (gamePhase.value !== "playing" || isRoundLocked.value) {
      return;
    }

    soloTimeLeft.value = Math.max(0, soloTimeLeft.value - 1);

    if (soloTimeLeft.value === 0) {
      handleSoloRoundTimeout();
    }
  }, 1000);
}

function startSoloRound() {
  clearPendingRound();
  clearRoundTimer();

  if (soloCurrentRound.value >= totalRounds.value) {
    finishSoloGame();
    return;
  }

  const country = getRandomCountry(currentCountry.value?.id);

  if (!country) {
    errorMessage.value = "No country data is available for this game.";
    gamePhase.value = "setup";
    return;
  }

  soloCurrentRound.value += 1;
  currentCountry.value = country;
  answerState.value = "idle";
  lastSelectedCountryId.value = null;
  isRoundLocked.value = false;
  soloTimeLeft.value = roundDurationSeconds;
  feedbackMessage.value = `Click ${country.name} before the timer runs out.`;
  startSoloRoundTimer();
}

function startSoloGame() {
  if (isLoading.value || errorMessage.value || countries.value.length === 0) {
    return;
  }

  setGamePath(soloGamePath);
  closeRoomEvents();
  resetRoomConnectionState();
  roomState.value = null;
  clearPendingRound();
  clearRoundTimer();
  resetSoloPlayer();
  totalRounds.value = getConfiguredRoundCount();
  soloCurrentRound.value = 0;
  currentCountry.value = null;
  answerState.value = "idle";
  lastSelectedCountryId.value = null;
  isRoundLocked.value = false;
  soloTimeLeft.value = roundDurationSeconds;
  feedbackMessage.value = "Click the prompted country on the map.";
  gamePhase.value = "playing";
  resetZoom();
  startSoloRound();
}

function resetSoloSetup() {
  setGamePath(countryGamePath);
  clearPendingRound();
  clearRoundTimer();
  gamePhase.value = "setup";
  soloCurrentRound.value = 0;
  currentCountry.value = null;
  answerState.value = "idle";
  lastSelectedCountryId.value = null;
  isRoundLocked.value = false;
  soloTimeLeft.value = roundDurationSeconds;
  feedbackMessage.value = "Configure a game to begin.";
}

const requestJson = async <T,>(url: string, body?: Record<string, unknown>) => {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? "Multiplayer request failed.");
  }

  return payload;
};

function markRoomConnectionAlive() {
  lastRoomEventAt.value = Date.now();
  lastRoomReconnectAttemptAt.value = 0;
  roomConnectionState.value = "connected";
}

function resetRoomConnectionState() {
  roomSyncRequestId += 1;
  roomConnectionState.value = "connected";
  lastRoomEventAt.value = 0;
  lastRoomSyncAt.value = 0;
  lastRoomReconnectAttemptAt.value = 0;
  isRoomSyncInFlight.value = false;
}

function applyRoomState(
  room: MultiplayerRoomState,
  options: { replacePath?: boolean; updatePath?: boolean } = {},
) {
  markRoomConnectionAlive();
  roomState.value = room;
  selectedMode.value = "multiplayer";
  totalRounds.value = room.roundCount;
  gamePhase.value =
    room.status === "playing"
      ? "playing"
      : room.status === "results"
        ? "results"
        : "setup";
  multiplayerErrorMessage.value = "";

  const self = room.players.find((player) => player.id === room.playerId);

  if (self) {
    multiplayerPlayerName.value = self.name;
  }

  saveMultiplayerSession(room);

  if (options.updatePath ?? true) {
    setGamePath(buildRoomPath(room.roomCode), options.replacePath ?? true);
  }
}

function closeRoomEvents() {
  if (roomEvents.value) {
    roomEvents.value.close();
    roomEvents.value = null;
  }
}

function connectRoomEvents(roomCode: string, playerId: string) {
  closeRoomEvents();

  const normalizedRoomCode = normalizeRoomCode(roomCode);
  const source = new EventSource(
    `/api/multiplayer/rooms/${encodeURIComponent(normalizedRoomCode)}/events?playerId=${encodeURIComponent(playerId)}`,
  );

  source.onopen = () => {
    markRoomConnectionAlive();
  };

  source.addEventListener("state", (event) => {
    const messageEvent = event as MessageEvent<string>;
    const nextRoomState = JSON.parse(messageEvent.data) as MultiplayerRoomState;

    now.value = Date.now();
    markRoomConnectionAlive();
    applyRoomState(nextRoomState);
  });

  source.addEventListener("heartbeat", () => {
    markRoomConnectionAlive();
  });

  source.onerror = () => {
    if (
      roomState.value?.roomCode === normalizedRoomCode &&
      roomState.value.playerId === playerId
    ) {
      roomConnectionState.value = navigator.onLine ? "reconnecting" : "offline";
    }
  };

  if (!lastRoomEventAt.value) {
    lastRoomEventAt.value = Date.now();
  }

  roomEvents.value = source;
}

async function syncCurrentRoomState() {
  const room = roomState.value;

  if (!room || isRoomSyncInFlight.value) {
    return;
  }

  const roomCode = room.roomCode;
  const playerId = room.playerId;
  const syncRequestId = (roomSyncRequestId += 1);

  isRoomSyncInFlight.value = true;
  lastRoomSyncAt.value = Date.now();

  try {
    const response = await requestJson<MultiplayerApiResponse>(
      `/api/multiplayer/rooms/${encodeURIComponent(roomCode)}?playerId=${encodeURIComponent(playerId)}`,
    );

    if (
      roomState.value?.roomCode !== roomCode ||
      roomState.value.playerId !== playerId
    ) {
      return;
    }

    applyRoomState(response.room);

    if (!roomEvents.value || roomEvents.value.readyState === EventSource.CLOSED) {
      connectRoomEvents(response.room.roomCode, response.room.playerId);
    }
  } catch {
    if (
      roomState.value?.roomCode === roomCode &&
      roomState.value.playerId === playerId
    ) {
      roomConnectionState.value = navigator.onLine ? "reconnecting" : "offline";
    }
  } finally {
    if (syncRequestId === roomSyncRequestId) {
      isRoomSyncInFlight.value = false;
    }
  }
}

function checkRoomConnectionHealth() {
  const room = roomState.value;

  if (!room) {
    return;
  }

  const currentTime = Date.now();

  if (!navigator.onLine) {
    roomConnectionState.value = "offline";
    return;
  }

  if (!lastRoomEventAt.value) {
    lastRoomEventAt.value = currentTime;
  }

  const isConnectionStale =
    currentTime - lastRoomEventAt.value > roomConnectionStaleMilliseconds;
  const shouldSyncExpiredRound =
    room.status === "playing" &&
    !room.roundLocked &&
    room.roundEndsAt !== null &&
    currentTime >= room.roundEndsAt + roundDeadlineSyncGraceMilliseconds;

  if (isConnectionStale) {
    roomConnectionState.value = "reconnecting";

    if (
      currentTime - lastRoomReconnectAttemptAt.value >
      roomReconnectCooldownMilliseconds
    ) {
      lastRoomReconnectAttemptAt.value = currentTime;
      connectRoomEvents(room.roomCode, room.playerId);
    }
  }

  if (
    (isConnectionStale || shouldSyncExpiredRound) &&
    currentTime - lastRoomSyncAt.value > roomSyncIntervalMilliseconds
  ) {
    void syncCurrentRoomState();
  }
}

function showJoinRoomFromPath(roomCode: string, message?: string) {
  closeRoomEvents();
  resetRoomConnectionState();
  roomState.value = null;
  selectedMode.value = "multiplayer";
  multiplayerSetupAction.value = "join";
  multiplayerRoomCodeInput.value = normalizeRoomCode(roomCode);
  gamePhase.value = "setup";
  multiplayerErrorMessage.value =
    message ??
    `Room ${normalizeRoomCode(roomCode)} is ready. Enter your name to join.`;
}

async function restoreServerRoomFromRoute(
  roomCode: string,
  explicitPlayerId: string | null,
) {
  const normalizedRoomCode = normalizeRoomCode(roomCode);
  const storedSession = getStoredMultiplayerSession(normalizedRoomCode);
  const playerId = explicitPlayerId ?? storedSession?.playerId ?? null;

  if (!playerId) {
    showJoinRoomFromPath(normalizedRoomCode);
    return;
  }

  if (
    roomState.value?.roomCode === normalizedRoomCode &&
    roomState.value.playerId === playerId
  ) {
    if (!roomEvents.value) {
      connectRoomEvents(normalizedRoomCode, playerId);
    }

    return;
  }

  isMultiplayerBusy.value = true;
  selectedMode.value = "multiplayer";
  multiplayerSetupAction.value = "join";
  multiplayerRoomCodeInput.value = normalizedRoomCode;
  multiplayerErrorMessage.value = "Rejoining multiplayer room…";

  try {
    const response = await requestJson<MultiplayerApiResponse>(
      `/api/multiplayer/rooms/${encodeURIComponent(normalizedRoomCode)}?playerId=${encodeURIComponent(playerId)}`,
    );

    applyRoomState(response.room, { replacePath: true });
    connectRoomEvents(response.room.roomCode, response.room.playerId);
  } catch (error) {
    removeMultiplayerSession(normalizedRoomCode);
    showJoinRoomFromPath(
      normalizedRoomCode,
      error instanceof Error
        ? `${error.message} Enter your name to join this room.`
        : "Could not rejoin that room. Enter your name to join.",
    );
  } finally {
    isMultiplayerBusy.value = false;
  }
}

async function syncRouteToState() {
  isSyncingRoute = true;

  try {
    const route = parseGameRoute();

    if (route.type === "solo") {
      closeRoomEvents();
      resetRoomConnectionState();
      roomState.value = null;
      selectedMode.value = "solo";
      gamePhase.value = "setup";
      multiplayerErrorMessage.value = "";
      return;
    }

    if (route.type === "multiplayer-room") {
      await restoreServerRoomFromRoute(route.roomCode, route.playerId);
      return;
    }

    if (route.type === "multiplayer-setup") {
      closeRoomEvents();
      resetRoomConnectionState();
      roomState.value = null;
      selectedMode.value = "multiplayer";
      multiplayerSetupAction.value = "create";
      gamePhase.value = "setup";
      multiplayerErrorMessage.value = "";
      return;
    }

    closeRoomEvents();
    resetRoomConnectionState();
    roomState.value = null;
    gamePhase.value = "setup";
  } finally {
    isSyncingRoute = false;
  }
}

const handleBrowserPopState = () => {
  void syncRouteToState();
};

const handleBrowserOffline = () => {
  if (roomState.value) {
    roomConnectionState.value = "offline";
  }
};

const handleBrowserOnline = () => {
  const room = roomState.value;

  if (!room) {
    return;
  }

  roomConnectionState.value = "reconnecting";
  connectRoomEvents(room.roomCode, room.playerId);
  void syncCurrentRoomState();
};

async function createServerRoom() {
  if (isMultiplayerBusy.value) {
    return;
  }

  isMultiplayerBusy.value = true;
  multiplayerErrorMessage.value = "";

  try {
    const response = await requestJson<MultiplayerApiResponse>(
      "/api/multiplayer/rooms",
      {
        playerName: multiplayerPlayerName.value,
        rounds: getConfiguredRoundCount(),
      },
    );

    applyRoomState(response.room, { replacePath: false });
    connectRoomEvents(
      response.room.roomCode,
      response.playerId ?? response.room.playerId,
    );
  } catch (error) {
    multiplayerErrorMessage.value =
      error instanceof Error ? error.message : "Could not create a room.";
  } finally {
    isMultiplayerBusy.value = false;
  }
}

async function joinServerRoom() {
  if (isMultiplayerBusy.value) {
    return;
  }

  const roomCode = normalizedJoinRoomCode.value;

  if (!roomCode) {
    multiplayerErrorMessage.value = "Enter a room code to join.";
    return;
  }

  isMultiplayerBusy.value = true;
  multiplayerErrorMessage.value = "";

  try {
    const response = await requestJson<MultiplayerApiResponse>(
      `/api/multiplayer/rooms/${encodeURIComponent(roomCode)}/join`,
      {
        playerName: multiplayerPlayerName.value,
      },
    );

    applyRoomState(response.room, { replacePath: false });
    connectRoomEvents(
      response.room.roomCode,
      response.playerId ?? response.room.playerId,
    );
  } catch (error) {
    multiplayerErrorMessage.value =
      error instanceof Error ? error.message : "Could not join the room.";
  } finally {
    isMultiplayerBusy.value = false;
  }
}

async function startServerRoom() {
  const room = roomState.value;

  if (!room || isMultiplayerBusy.value) {
    return;
  }

  isMultiplayerBusy.value = true;
  multiplayerErrorMessage.value = "";

  try {
    const response = await requestJson<MultiplayerApiResponse>(
      `/api/multiplayer/rooms/${encodeURIComponent(room.roomCode)}/start`,
      {
        playerId: room.playerId,
      },
    );

    applyRoomState(response.room);
    resetZoom();
  } catch (error) {
    multiplayerErrorMessage.value =
      error instanceof Error ? error.message : "Could not start the room.";
  } finally {
    isMultiplayerBusy.value = false;
  }
}

async function submitServerAnswer(countryId: string | null) {
  const room = roomState.value;

  if (!room || isMapGuessingDisabled.value || isSubmittingAnswer.value) {
    return;
  }

  isSubmittingAnswer.value = true;
  multiplayerErrorMessage.value = "";

  try {
    const action = countryId ? "guess" : "skip";
    const response = await requestJson<MultiplayerApiResponse>(
      `/api/multiplayer/rooms/${encodeURIComponent(room.roomCode)}/${action}`,
      {
        playerId: room.playerId,
        countryId,
      },
    );

    applyRoomState(response.room);
  } catch (error) {
    multiplayerErrorMessage.value =
      error instanceof Error ? error.message : "Could not submit your answer.";
  } finally {
    isSubmittingAnswer.value = false;
  }
}

async function leaveServerRoom() {
  const room = roomState.value;

  closeRoomEvents();
  resetRoomConnectionState();
  roomState.value = null;
  multiplayerErrorMessage.value = "";
  gamePhase.value = "setup";
  setGamePath(multiplayerGamePath);

  if (!room) {
    return;
  }

  removeMultiplayerSession(room.roomCode);

  try {
    await requestJson(
      `/api/multiplayer/rooms/${encodeURIComponent(room.roomCode)}/leave`,
      {
        playerId: room.playerId,
      },
    );
  } catch {
    // The room may already be gone; leaving is best-effort from the client.
  }
}

const loadCountries = async () => {
  try {
    const response = await fetch("/countries.geo.json");

    if (!response.ok) {
      throw new Error(`Could not load the map (${response.status})`);
    }

    const data = (await response.json()) as CountryFeatureCollection;

    countries.value = data.features
      .map((feature, index) => {
        const name = feature.properties?.name ?? `Country ${index + 1}`;
        const id = feature.id ?? name;
        const path = geometryToPath(feature.geometry);

        return { id, name, path };
      })
      .filter((country) => country.path.length > 0);

    if (countries.value.length === 0) {
      throw new Error("No playable countries were found in the map data.");
    }
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : "Could not load the map.";
  } finally {
    isLoading.value = false;
  }
};

const getSvgPoint = (event: PointerEvent | WheelEvent) => {
  const svg = mapSvg.value;

  if (!svg) {
    return null;
  }

  const transformMatrix = svg.getScreenCTM();

  if (!transformMatrix) {
    return null;
  }

  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;

  const transformedPoint = point.matrixTransform(transformMatrix.inverse());

  return {
    x: transformedPoint.x,
    y: transformedPoint.y,
  };
};

const setZoom = (nextZoom: number, focalPoint?: MapPoint) => {
  const previousZoom = zoomLevel.value;
  const clampedZoom = clamp(nextZoom, minimumMapZoom, maximumMapZoom);

  if (clampedZoom === previousZoom) {
    return;
  }

  const previousSize = getViewBoxSize(previousZoom);
  const nextSize = getViewBoxSize(clampedZoom);
  let nextCenter = mapCenter.value;

  if (focalPoint) {
    const previousX = mapCenter.value.x - previousSize.width / 2;
    const previousY = mapCenter.value.y - previousSize.height / 2;
    const focalRatioX = (focalPoint.x - previousX) / previousSize.width;
    const focalRatioY = (focalPoint.y - previousY) / previousSize.height;

    nextCenter = {
      x: focalPoint.x + (0.5 - focalRatioX) * nextSize.width,
      y: focalPoint.y + (0.5 - focalRatioY) * nextSize.height,
    };
  }

  zoomLevel.value = clampedZoom;
  mapCenter.value = getClampedCenter(nextCenter, clampedZoom);
};

const zoomIn = () => {
  setZoom(zoomLevel.value * zoomStep);
};

const zoomOut = () => {
  setZoom(zoomLevel.value / zoomStep);
};

const resetZoom = () => {
  zoomLevel.value = minimumMapZoom;
  mapCenter.value = { x: 0, y: 0 };
};

const handleMapWheel = (event: WheelEvent) => {
  const focalPoint = getSvgPoint(event);
  const zoomFactor = event.deltaY < 0 ? zoomStep : 1 / zoomStep;

  setZoom(zoomLevel.value * zoomFactor, focalPoint ?? undefined);
};

const handleMapPointerDown = (event: PointerEvent) => {
  if (event.button !== 0) {
    return;
  }

  const svg = mapSvg.value;

  if (!svg) {
    return;
  }

  const bounds = svg.getBoundingClientRect();
  const { width, height } = getViewBoxSize(zoomLevel.value);

  isPanning.value = true;
  hasDraggedMap.value = false;
  panStartClient.value = { x: event.clientX, y: event.clientY };
  panStartCenter.value = { ...mapCenter.value };
  panStartScale.value = {
    x: width / bounds.width,
    y: height / bounds.height,
  };
};

const handleMapPointerMove = (event: PointerEvent) => {
  if (!isPanning.value || !panStartClient.value) {
    return;
  }

  const deltaX = event.clientX - panStartClient.value.x;
  const deltaY = event.clientY - panStartClient.value.y;

  if (Math.hypot(deltaX, deltaY) > dragClickThreshold) {
    hasDraggedMap.value = true;
  }

  setMapCenter({
    x: panStartCenter.value.x - deltaX * panStartScale.value.x,
    y: panStartCenter.value.y - deltaY * panStartScale.value.y,
  });
};

const stopPanning = () => {
  if (!isPanning.value) {
    return;
  }

  if (hasDraggedMap.value) {
    suppressNextCountryClick.value = true;
    window.setTimeout(() => {
      suppressNextCountryClick.value = false;
    }, 0);
  }

  isPanning.value = false;
  panStartClient.value = null;
};

const handleCountryGuess = (country: CountryPath) => {
  if (suppressNextCountryClick.value) {
    suppressNextCountryClick.value = false;
    return;
  }

  if (roomState.value) {
    void submitServerAnswer(country.id);
    return;
  }

  if (
    !currentCountry.value ||
    isRoundLocked.value ||
    gamePhase.value !== "playing"
  ) {
    return;
  }

  lastSelectedCountryId.value = country.id;

  if (country.id === currentCountry.value.id) {
    resolveSoloRound(true, `Correct! That was ${country.name}.`, 900);
    return;
  }

  resolveSoloRound(
    false,
    `Not quite — that was ${country.name}. The correct answer was ${currentCountry.value.name}.`,
    1400,
  );
};

const skipCountry = () => {
  if (roomState.value) {
    void submitServerAnswer(null);
    return;
  }

  if (
    !currentCountry.value ||
    isRoundLocked.value ||
    gamePhase.value !== "playing"
  ) {
    return;
  }

  lastSelectedCountryId.value = null;
  resolveSoloRound(
    false,
    `Skipped. The correct answer was ${currentCountry.value.name}.`,
    1200,
  );
};

const resetGame = () => {
  if (roomState.value) {
    void startServerRoom();
    return;
  }

  startSoloGame();
};

const returnToSetup = () => {
  if (roomState.value) {
    void leaveServerRoom();
    return;
  }

  resetSoloSetup();
};

watch(selectedMode, (mode) => {
  if (isSyncingRoute || roomState.value || gamePhase.value !== "setup") {
    return;
  }

  setGamePath(mode === "solo" ? soloGamePath : multiplayerGamePath);
});

onMounted(() => {
  void loadCountries();
  void syncRouteToState();
  window.addEventListener("popstate", handleBrowserPopState);
  window.addEventListener("offline", handleBrowserOffline);
  window.addEventListener("online", handleBrowserOnline);
  clockTimer.value = window.setInterval(() => {
    now.value = Date.now();
    checkRoomConnectionHealth();
  }, 250);
});

onUnmounted(() => {
  clearPendingRound();
  clearRoundTimer();
  clearClockTimer();
  closeRoomEvents();
  resetRoomConnectionState();
  window.removeEventListener("popstate", handleBrowserPopState);
  window.removeEventListener("offline", handleBrowserOffline);
  window.removeEventListener("online", handleBrowserOnline);
});
</script>

<template>
  <section
    class="map-panel"
    :class="{ 'map-panel--playing': isPlayingGame }"
    aria-label="Country guessing minigame"
  >
    <div v-if="isLoading" class="map-message">Loading map…</div>
    <div v-else-if="errorMessage" class="map-message" role="alert">
      {{ errorMessage }}
    </div>

    <template v-else>
      <section
        v-if="!roomState && gamePhase === 'setup'"
        class="setup-panel"
        aria-labelledby="setup-heading"
      >
        <header class="setup-header">
          <p class="eyebrow">Country guessing game</p>
          <h2 id="setup-heading">Choose how to play</h2>
          <p class="setup-copy">
            Play solo in this browser, or create a multiplayer room for up to
            {{ maximumPlayerCount }} players. Multiplayer rounds use a shared
            {{ roundDurationSeconds }} second timer.
          </p>
        </header>

        <div class="mode-grid" role="radiogroup" aria-label="Game mode">
          <label
            class="mode-card"
            :class="{ 'mode-card--active': selectedMode === 'solo' }"
          >
            <input v-model="selectedMode" type="radio" value="solo" />
            <span class="mode-title">Solo</span>
            <span class="mode-description">
              A focused {{ defaultRoundCount }} round challenge against the
              timer.
            </span>
          </label>

          <label
            class="mode-card"
            :class="{ 'mode-card--active': selectedMode === 'multiplayer' }"
          >
            <input v-model="selectedMode" type="radio" value="multiplayer" />
            <span class="mode-title">Multiplayer</span>
            <span class="mode-description">
              Create or join a live room. Everyone guesses the same country at
              the same time.
            </span>
          </label>
        </div>

        <div class="settings-grid">
          <label class="setting-field">
            <span>Rounds</span>
            <input
              v-model.number="roundCountSetting"
              type="number"
              min="1"
              :max="maximumRoundCount"
              inputmode="numeric"
            />
            <small>Default is {{ defaultRoundCount }} rounds.</small>
          </label>

          <div class="setting-field setting-field--static">
            <span>Time per round</span>
            <strong>{{ roundDurationSeconds }}s</strong>
            <small>The countdown is fixed for every round.</small>
          </div>

          <div
            v-if="selectedMode === 'multiplayer'"
            class="setting-field setting-field--static"
          >
            <span>Players</span>
            <strong
              >{{ minimumMultiplayerPlayerCount }}–{{
                maximumPlayerCount
              }}</strong
            >
            <small
              >Rooms start after at least
              {{ minimumMultiplayerPlayerCount }} players join.</small
            >
          </div>
        </div>

        <div v-if="selectedMode === 'solo'" class="setup-actions">
          <button class="start-button" type="button" @click="startSoloGame">
            Start solo game
          </button>
        </div>

        <section
          v-else
          class="server-setup"
          aria-labelledby="server-multiplayer-heading"
        >
          <div class="server-setup-header">
            <div>
              <p class="eyebrow">Multiplayer</p>
              <h3 id="server-multiplayer-heading">Play together online</h3>
            </div>
            <div class="segmented-control" aria-label="Multiplayer action">
              <button
                type="button"
                :class="{
                  'segmented-control__button--active':
                    multiplayerSetupAction === 'create',
                }"
                @click="multiplayerSetupAction = 'create'"
              >
                Create
              </button>
              <button
                type="button"
                :class="{
                  'segmented-control__button--active':
                    multiplayerSetupAction === 'join',
                }"
                @click="multiplayerSetupAction = 'join'"
              >
                Join
              </button>
            </div>
          </div>

          <div class="server-form-grid">
            <label class="player-name-field">
              <span>Your name</span>
              <input
                v-model="multiplayerPlayerName"
                type="text"
                placeholder="Player name"
                maxlength="24"
              />
            </label>

            <label
              v-if="multiplayerSetupAction === 'join'"
              class="player-name-field"
            >
              <span>Room code</span>
              <input
                v-model="multiplayerRoomCodeInput"
                type="text"
                placeholder="ABC123"
                maxlength="8"
                autocomplete="off"
              />
            </label>
          </div>

          <p v-if="multiplayerErrorMessage" class="server-error" role="alert">
            {{ multiplayerErrorMessage }}
          </p>

          <div class="setup-actions">
            <button
              v-if="multiplayerSetupAction === 'create'"
              class="start-button"
              type="button"
              :disabled="isMultiplayerBusy"
              @click="createServerRoom"
            >
              {{ isMultiplayerBusy ? "Creating…" : "Create room" }}
            </button>
            <button
              v-else
              class="start-button"
              type="button"
              :disabled="isMultiplayerBusy"
              @click="joinServerRoom"
            >
              {{ isMultiplayerBusy ? "Joining…" : "Join room" }}
            </button>
          </div>
        </section>
      </section>

      <section
        v-else-if="roomState?.status === 'lobby'"
        class="lobby-panel"
        aria-labelledby="lobby-heading"
      >
        <header class="lobby-header">
          <div>
            <p class="eyebrow">Multiplayer lobby</p>
            <h2 id="lobby-heading">Room {{ roomState.roomCode }}</h2>
            <p class="setup-copy">
              {{ displayFeedbackMessage }} The match will run
              {{ roomState.roundCount }} rounds with
              {{ roomState.roundDurationSeconds }} seconds each.
            </p>
          </div>
          <div class="room-code-card" aria-label="Room code">
            <span>Room code</span>
            <strong>{{ roomState.roomCode }}</strong>
            <small>Share this with friends</small>
          </div>
        </header>

        <div class="lobby-grid">
          <article
            v-for="player in roomState.players"
            :key="player.id"
            class="player-score-card"
            :class="{
              'player-score-card--active': player.id === roomState.playerId,
            }"
          >
            <span class="player-turn-label">
              {{ player.isHost ? "Host" : "Player" }}
            </span>
            <strong>{{ player.name }}</strong>
            <span>{{ player.connected ? "Connected" : "Disconnected" }}</span>
          </article>
        </div>

        <p v-if="multiplayerErrorMessage" class="server-error" role="alert">
          {{ multiplayerErrorMessage }}
        </p>
        <p
          v-if="multiplayerConnectionMessage"
          class="server-warning"
          role="status"
        >
          {{ multiplayerConnectionMessage }}
        </p>

        <div class="setup-actions">
          <button
            v-if="isMultiplayerHost"
            class="start-button"
            type="button"
            :disabled="!roomState.canStart || isMultiplayerBusy"
            @click="startServerRoom"
          >
            {{ roomState.canStart ? "Start match" : "Waiting for players" }}
          </button>
          <span v-else class="waiting-pill">Waiting for host</span>
          <button
            class="secondary-button"
            type="button"
            @click="leaveServerRoom"
          >
            Leave room
          </button>
        </div>
      </section>

      <template
        v-else-if="isPlayingGame"
      >
        <header class="game-header">
          <div class="prompt-card" aria-live="polite">
            <p class="eyebrow">
              {{
                isServerMultiplayerActive
                  ? "Multiplayer challenge"
                  : "World map challenge"
              }}
            </p>
            <h2>
              <span
                v-if="isServerMultiplayerActive && multiplayerSelf"
                class="active-player-name"
              >
                {{ multiplayerSelf.name }}:
              </span>
              Click
              <span class="target-country">
                {{ targetCountryName ?? "the highlighted country" }}
              </span>
            </h2>
            <p class="round-meta">{{ roundSummary }}</p>

            <div class="timer" aria-label="Round timer">
              <div class="timer-header">
                <span>Time left</span>
                <strong :class="{ 'timer-value--low': timerIsLow }">
                  {{ displayTimeLeft }}s
                </strong>
              </div>
              <div class="timer-track" aria-hidden="true">
                <span :style="{ width: timerPercent }"></span>
              </div>
            </div>

            <p
              class="feedback"
              :class="{
                'feedback--correct': displayAnswerState === 'correct',
                'feedback--incorrect': displayAnswerState === 'incorrect',
              }"
            >
              {{ displayFeedbackMessage }}
            </p>
            <p v-if="multiplayerErrorMessage" class="server-error" role="alert">
              {{ multiplayerErrorMessage }}
            </p>
            <p
              v-if="multiplayerConnectionMessage"
              class="server-warning"
              role="status"
            >
              {{ multiplayerConnectionMessage }}
            </p>
          </div>

          <dl class="scoreboard" aria-label="Your score">
            <div>
              <dt>Score</dt>
              <dd>{{ scoreboardPlayer.score }}</dd>
            </div>
            <div>
              <dt>Attempts</dt>
              <dd>{{ scoreboardPlayer.attempts }}</dd>
            </div>
            <div>
              <dt>Accuracy</dt>
              <dd>{{ activeAccuracy }}</dd>
            </div>
            <div>
              <dt>Streak</dt>
              <dd>{{ scoreboardPlayer.streak }}</dd>
            </div>
          </dl>

          <div class="game-actions">
            <button
              type="button"
              :disabled="isMapGuessingDisabled"
              @click="skipCountry"
            >
              {{ isServerMultiplayerActive ? "Skip round" : "Skip" }}
            </button>
            <button
              v-if="!isServerMultiplayerActive"
              type="button"
              @click="resetGame"
            >
              Reset
            </button>
            <button
              v-if="isServerMultiplayerActive"
              class="secondary-button"
              type="button"
              :disabled="isRoomSyncInFlight"
              @click="syncCurrentRoomState"
            >
              {{ isRoomSyncInFlight ? "Syncing…" : "Resync" }}
            </button>
            <button
              class="secondary-button"
              type="button"
              @click="returnToSetup"
            >
              {{ isServerMultiplayerActive ? "Leave room" : "Setup" }}
            </button>
          </div>
        </header>

        <aside
          v-if="isServerMultiplayerActive && roomState"
          class="player-strip"
          aria-label="Player scores"
        >
          <article
            v-for="player in roomState.players"
            :key="player.id"
            class="player-score-card"
            :class="{
              'player-score-card--active': player.id === roomState.playerId,
              'player-score-card--answered': player.hasAnswered,
            }"
          >
            <span class="player-turn-label">
              {{
                player.id === roomState.playerId
                  ? "You"
                  : player.hasAnswered
                    ? "Answered"
                    : "Guessing"
              }}
            </span>
            <strong>{{ player.name }}</strong>
            <span>{{ player.score }} pts</span>
          </article>
        </aside>

        <div class="map-stage">
          <div class="zoom-controls" aria-label="Map zoom controls">
            <button
              class="zoom-button"
              type="button"
              aria-label="Zoom out"
              :disabled="!canZoomOut"
              @click="zoomOut"
            >
              −
            </button>
            <span class="zoom-level" aria-live="polite">{{ zoomPercent }}</span>
            <button
              class="zoom-button"
              type="button"
              aria-label="Zoom in"
              :disabled="!canZoomIn"
              @click="zoomIn"
            >
              +
            </button>
            <button class="zoom-reset" type="button" @click="resetZoom">
              Reset zoom
            </button>
          </div>

          <svg
            ref="mapSvg"
            class="world-map"
            :class="{ 'world-map--panning': isPanning }"
            :viewBox="mapViewBox"
            role="img"
            aria-label="World map. Click the country named in the prompt. Use the zoom controls, mouse wheel, or drag to move around the map."
            @wheel.prevent="handleMapWheel"
            @pointerdown="handleMapPointerDown"
            @pointermove.prevent="handleMapPointerMove"
            @pointerup="stopPanning"
            @pointercancel="stopPanning"
          >
            <rect class="ocean" x="-180" y="-90" width="360" height="180" />

            <path
              v-for="country in countries"
              :key="country.id"
              class="country"
              :class="{
                'country--correct':
                  displaySelectedCountryId === country.id &&
                  displayAnswerState === 'correct',
                'country--incorrect':
                  displaySelectedCountryId === country.id &&
                  displayAnswerState === 'incorrect',
                'country--missed-target': missedTargetCountryId === country.id,
              }"
              :d="country.path"
              fill-rule="evenodd"
              vector-effect="non-scaling-stroke"
              role="button"
              tabindex="0"
              :aria-label="`Guess ${country.name}`"
              :aria-disabled="isMapGuessingDisabled"
              @click="handleCountryGuess(country)"
              @keydown.enter.prevent="handleCountryGuess(country)"
              @keydown.space.prevent="handleCountryGuess(country)"
            />
          </svg>
        </div>
      </template>

      <section
        v-else
        class="results-panel"
        aria-labelledby="leaderboard-heading"
      >
        <div class="results-copy">
          <p class="eyebrow">Final leaderboard</p>
          <h2 id="leaderboard-heading">Game over</h2>
          <p>
            {{ displayPlayers.length }}
            {{ displayPlayers.length === 1 ? "player" : "players" }} completed
            {{ displayRoundCount }} timed rounds with
            {{ displayRoundDurationSeconds }} seconds on the clock.
          </p>
        </div>

        <ol class="leaderboard" aria-label="Final player scores">
          <li
            v-for="(player, index) in leaderboard"
            :key="player.id"
            class="leaderboard-row"
            :class="{ 'leaderboard-row--winner': index === 0 }"
          >
            <span class="leaderboard-rank">#{{ index + 1 }}</span>
            <span class="leaderboard-player">
              <strong>{{ player.name }}</strong>
              <small>
                {{ player.attempts }} turns ·
                {{ player.accuracyLabel }} accuracy
                <template v-if="player.isHost"> · Host</template>
              </small>
            </span>
            <span class="leaderboard-score">
              {{ player.score }}
              <small>points</small>
            </span>
          </li>
        </ol>

        <p v-if="multiplayerErrorMessage" class="server-error" role="alert">
          {{ multiplayerErrorMessage }}
        </p>
        <p
          v-if="multiplayerConnectionMessage"
          class="server-warning"
          role="status"
        >
          {{ multiplayerConnectionMessage }}
        </p>

        <div class="results-actions">
          <button
            v-if="!roomState || isMultiplayerHost"
            type="button"
            :disabled="isMultiplayerBusy"
            @click="resetGame"
          >
            {{ roomState ? "Restart room" : "Play again" }}
          </button>
          <span v-else class="waiting-pill">Waiting for host to restart</span>
          <button class="secondary-button" type="button" @click="returnToSetup">
            {{ roomState ? "Leave room" : "Change setup" }}
          </button>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.map-panel {
  width: min(100%, 1400px);
  padding: clamp(0.75rem, 2vw, 2rem);
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 24px;
  background:
    radial-gradient(
      circle at 15% 20%,
      rgba(125, 211, 252, 0.35),
      transparent 30%
    ),
    linear-gradient(
      135deg,
      rgba(248, 250, 252, 0.92),
      rgba(226, 232, 240, 0.86)
    );
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.18);
}

.map-panel--playing {
  display: grid;
  width: min(100%, 1680px);
  grid-template-columns: minmax(17rem, 23rem) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  gap: clamp(0.6rem, 1.2vw, 1rem);
  height: calc(100dvh - 5.25rem);
  max-height: 52rem;
  min-height: 30rem;
  padding: clamp(0.6rem, 1.2vw, 1rem);
  overflow: hidden;
}

.map-panel--playing .game-header {
  display: flex;
  grid-row: 1 / -1;
  flex-direction: column;
  gap: 0.7rem;
  min-height: 0;
  margin-bottom: 0;
  overflow: auto;
  padding-right: 0.15rem;
}

.map-panel--playing .prompt-card,
.map-panel--playing .scoreboard,
.map-panel--playing .game-actions {
  flex-shrink: 0;
  padding: clamp(0.75rem, 1.2vw, 1rem);
}

.map-panel--playing .prompt-card {
  flex: 1 1 auto;
}

.map-panel--playing h2 {
  font-size: clamp(1.45rem, 2.2vw, 2.35rem);
}

.map-panel--playing .round-meta {
  margin-top: 0.4rem;
}

.map-panel--playing .timer {
  margin-top: 0.55rem;
}

.map-panel--playing .feedback {
  min-height: 0;
  margin-top: 0.45rem;
}

.map-panel--playing .scoreboard {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.65rem;
  min-width: 0;
}

.map-panel--playing .scoreboard dd {
  font-size: 1.35rem;
}

.map-panel--playing .game-actions {
  flex-flow: row wrap;
  justify-content: flex-start;
}

.map-panel--playing .player-strip {
  grid-column: 2;
  grid-row: 2;
  grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
  gap: 0.5rem;
  margin-bottom: 0;
}

.map-panel--playing .map-stage {
  display: grid;
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-radius: 18px;
  background: #c7e8ff;
}

.map-panel--playing .world-map {
  width: 100%;
  height: 100%;
  aspect-ratio: auto;
}

.setup-panel,
.lobby-panel,
.results-panel,
.server-setup {
  display: grid;
  gap: clamp(1rem, 2vw, 1.35rem);
}

.setup-header,
.lobby-header,
.results-copy,
.prompt-card,
.scoreboard,
.game-actions,
.setting-field,
.player-name-field,
.mode-card,
.leaderboard-row,
.player-score-card,
.room-code-card,
.server-setup {
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
}

.setup-header,
.lobby-header,
.results-copy,
.prompt-card,
.server-setup {
  padding: clamp(1rem, 2vw, 1.5rem);
}

.lobby-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1rem;
  align-items: center;
}

.setup-copy,
.results-copy p:not(.eyebrow) {
  max-width: 58rem;
  margin-top: 0.75rem;
  color: #475569;
  font-size: 1.05rem;
  font-weight: 700;
}

.mode-grid,
.settings-grid,
.server-form-grid,
.lobby-grid {
  display: grid;
  gap: 0.85rem;
}

.mode-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.mode-card {
  position: relative;
  display: grid;
  gap: 0.45rem;
  padding: 1rem;
  cursor: pointer;
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease,
    transform 160ms ease;
}

.mode-card:hover,
.mode-card:focus-within {
  transform: translateY(-1px);
}

.mode-card--active {
  border-color: rgba(37, 99, 235, 0.85);
  box-shadow: 0 18px 42px rgba(37, 99, 235, 0.16);
}

.mode-card input {
  position: absolute;
  inset: 1rem auto auto 1rem;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.mode-title {
  color: #0f172a;
  font-size: 1.2rem;
  font-weight: 950;
}

.mode-description {
  color: #475569;
  font-weight: 700;
}

.settings-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.server-setup-header {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
}

.server-setup h3 {
  color: #0f172a;
  font-size: clamp(1.35rem, 2.5vw, 2.2rem);
  font-weight: 950;
  line-height: 1;
}

.segmented-control {
  display: inline-flex;
  gap: 0.35rem;
  padding: 0.35rem;
  border-radius: 999px;
  background: #e2e8f0;
}

.segmented-control button {
  color: #334155;
  background: transparent;
  box-shadow: none;
}

.segmented-control__button--active,
.segmented-control__button--active:hover,
.segmented-control__button--active:focus-visible {
  color: #ffffff !important;
  background: #2563eb !important;
}

.server-form-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.setting-field,
.player-name-field {
  display: grid;
  gap: 0.45rem;
  padding: 1rem;
}

.setting-field span,
.player-name-field span,
.room-code-card span {
  color: #64748b;
  font-size: 0.75rem;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.setting-field input,
.setting-field select,
.player-name-field input {
  width: 100%;
  border: 1px solid rgba(71, 85, 105, 0.24);
  border-radius: 12px;
  padding: 0.7rem 0.8rem;
  color: #0f172a;
  background: #ffffff;
  font: inherit;
  font-weight: 800;
}

.setting-field strong,
.room-code-card strong {
  color: #0f172a;
  font-size: 2rem;
  font-weight: 950;
  line-height: 1;
}

.setting-field small,
.room-code-card small {
  color: #64748b;
  font-weight: 700;
}

.room-code-card {
  display: grid;
  gap: 0.4rem;
  min-width: 13rem;
  padding: 1rem;
  text-align: center;
}

.room-code-card strong {
  color: #ea580c;
  font-size: 2.4rem;
  letter-spacing: 0.08em;
}

.setup-actions,
.results-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
}

.server-error,
.server-warning {
  margin: 0;
  font-weight: 800;
}

.server-error {
  color: #b91c1c;
}

.server-warning {
  color: #b45309;
}

.waiting-pill {
  display: inline-flex;
  align-items: center;
  min-height: 2.65rem;
  border-radius: 999px;
  padding: 0 1rem;
  color: #475569;
  background: rgba(226, 232, 240, 0.85);
  font-weight: 900;
}

.lobby-grid {
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
}

.game-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: clamp(0.75rem, 2vw, 1.25rem);
  align-items: stretch;
  margin-bottom: clamp(0.75rem, 2vw, 1.5rem);
}

.eyebrow {
  margin-bottom: 0.25rem;
  color: #2563eb;
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h2 {
  color: #0f172a;
  font-size: clamp(1.75rem, 4vw, 3.25rem);
  font-weight: 900;
  line-height: 1;
}

.active-player-name,
.target-country {
  color: #ea580c;
  font-weight: inherit;
}

.round-meta {
  margin-top: 0.55rem;
  color: #334155;
  font-weight: 900;
}

.timer {
  display: grid;
  gap: 0.4rem;
  margin-top: 0.85rem;
}

.timer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  color: #475569;
  font-size: 0.85rem;
  font-weight: 900;
  text-transform: uppercase;
}

.timer-header strong {
  color: #0f172a;
  font-size: 1rem;
}

.timer-value--low {
  color: #b91c1c !important;
}

.timer-track {
  overflow: hidden;
  height: 0.7rem;
  border-radius: 999px;
  background: #e2e8f0;
}

.timer-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #22c55e, #f97316);
  transition: width 200ms linear;
}

.feedback {
  min-height: 1.6em;
  margin-top: 0.75rem;
  color: #475569;
  font-weight: 700;
}

.feedback--correct {
  color: #15803d;
}

.feedback--incorrect {
  color: #b91c1c;
}

.scoreboard {
  display: grid;
  grid-template-columns: repeat(2, minmax(5.5rem, 1fr));
  gap: 0.75rem;
  min-width: 18rem;
  padding: 1rem;
}

.scoreboard div {
  display: grid;
  gap: 0.15rem;
}

.scoreboard dt {
  color: #64748b;
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.scoreboard dd {
  color: #0f172a;
  font-size: 1.6rem;
  font-weight: 900;
  line-height: 1;
}

.game-actions {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  justify-content: center;
  padding: 1rem;
}

button {
  cursor: pointer;
  border: 0;
  border-radius: 999px;
  padding: 0.7rem 1.1rem;
  color: #ffffff;
  background: #2563eb;
  font-weight: 900;
  transition:
    background-color 160ms ease,
    opacity 160ms ease,
    transform 160ms ease;
}

button:hover,
button:focus-visible {
  background: #1d4ed8;
  transform: translateY(-1px);
}

button:disabled,
button:disabled:hover,
button:disabled:focus-visible {
  cursor: not-allowed;
  opacity: 0.45;
  transform: none;
}

.secondary-button {
  color: #1e293b;
  background: #e2e8f0;
  box-shadow: none;
}

.secondary-button:hover,
.secondary-button:focus-visible {
  background: #cbd5e1;
}

.start-button {
  padding: 0.9rem 1.35rem;
}

.player-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.75rem;
  margin-bottom: clamp(0.75rem, 2vw, 1.5rem);
}

.player-score-card {
  display: grid;
  gap: 0.2rem;
  padding: 0.85rem 1rem;
}

.player-score-card--active {
  border-color: rgba(37, 99, 235, 0.85);
  background: rgba(219, 234, 254, 0.92);
}

.player-score-card--answered {
  border-color: rgba(34, 197, 94, 0.6);
}

.player-turn-label {
  color: #2563eb;
  font-size: 0.68rem;
  font-weight: 900;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.player-score-card strong {
  color: #0f172a;
  font-size: 1.05rem;
}

.player-score-card span:last-child {
  color: #475569;
  font-weight: 900;
}

.map-stage {
  position: relative;
}

.zoom-controls {
  position: absolute;
  z-index: 2;
  top: clamp(0.6rem, 1.6vw, 1rem);
  left: clamp(0.6rem, 1.6vw, 1rem);
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.45rem;
  border: 1px solid rgba(71, 85, 105, 0.22);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 14px 35px rgba(15, 23, 42, 0.16);
  backdrop-filter: blur(16px);
}

.zoom-button {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  padding: 0;
  font-size: 1.25rem;
  line-height: 1;
}

.zoom-level {
  min-width: 3.5rem;
  color: #0f172a;
  font-size: 0.85rem;
  font-weight: 900;
  text-align: center;
}

.zoom-reset {
  padding: 0.58rem 0.85rem;
  color: #1e293b;
  background: #e2e8f0;
  box-shadow: none;
}

.zoom-reset:hover,
.zoom-reset:focus-visible {
  background: #cbd5e1;
}

.world-map {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 2 / 1;
  overflow: hidden;
  border-radius: 18px;
  background: #c7e8ff;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.world-map--panning {
  cursor: grabbing;
}

.ocean {
  fill: #c7e8ff;
}

.country {
  cursor: pointer;
  fill: #f8fafc;
  stroke: #475569;
  stroke-linejoin: round;
  stroke-width: 0.35;
  transition:
    fill 160ms ease,
    filter 160ms ease,
    stroke 160ms ease;
  outline: none;
}

.world-map--panning .country {
  cursor: grabbing;
}

.country:hover,
.country:focus-visible {
  fill: #fde68a;
  filter: drop-shadow(0 0 1.5px rgba(15, 23, 42, 0.45));
  stroke: #1e293b;
}

.country--correct,
.country--correct:hover,
.country--correct:focus-visible {
  fill: #22c55e;
  stroke: #14532d;
}

.country--incorrect,
.country--incorrect:hover,
.country--incorrect:focus-visible {
  fill: #ef4444;
  stroke: #7f1d1d;
}

.country--missed-target,
.country--missed-target:hover,
.country--missed-target:focus-visible {
  fill: #22c55e;
  stroke: #14532d;
}

.leaderboard {
  display: grid;
  gap: 0.75rem;
  padding: 0;
  list-style: none;
}

.leaderboard-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 1rem;
  align-items: center;
  padding: 1rem;
}

.leaderboard-row--winner {
  border-color: rgba(234, 88, 12, 0.55);
  background:
    linear-gradient(
      135deg,
      rgba(255, 247, 237, 0.92),
      rgba(255, 255, 255, 0.88)
    ),
    rgba(255, 255, 255, 0.82);
}

.leaderboard-rank {
  display: grid;
  min-width: 3rem;
  height: 3rem;
  place-items: center;
  border-radius: 50%;
  color: #ffffff;
  background: #2563eb;
  font-weight: 950;
}

.leaderboard-row--winner .leaderboard-rank {
  background: #ea580c;
}

.leaderboard-player {
  display: grid;
  gap: 0.2rem;
}

.leaderboard-player strong {
  color: #0f172a;
  font-size: 1.2rem;
  font-weight: 950;
}

.leaderboard-player small,
.leaderboard-score small {
  color: #64748b;
  font-weight: 800;
}

.leaderboard-score {
  display: grid;
  justify-items: end;
  color: #0f172a;
  font-size: 2rem;
  font-weight: 950;
  line-height: 1;
}

.map-message {
  display: grid;
  min-height: min(70vh, 720px);
  place-items: center;
  color: #334155;
  font-size: clamp(1rem, 2vw, 1.25rem);
}

@media (max-width: 820px) {
  .map-panel--playing {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(16rem, 1fr) auto;
    height: auto;
    max-height: none;
    min-height: 0;
    overflow: visible;
  }

  .map-panel--playing .game-header,
  .map-panel--playing .map-stage,
  .map-panel--playing .player-strip {
    grid-column: 1;
  }

  .map-panel--playing .game-header {
    grid-row: 1;
    overflow: visible;
  }

  .map-panel--playing .map-stage {
    grid-row: 2;
    min-height: min(52vw, 22rem);
  }

  .map-panel--playing .player-strip {
    grid-row: 3;
  }

  .map-panel--playing .world-map {
    height: auto;
    aspect-ratio: 2 / 1;
  }
}

@media (max-width: 980px) {
  .game-header,
  .settings-grid,
  .lobby-header {
    grid-template-columns: 1fr;
  }

  .scoreboard {
    min-width: 0;
  }

  .game-actions {
    flex-direction: row;
  }

  .room-code-card {
    justify-items: start;
    text-align: left;
  }
}

@media (max-width: 700px) {
  .mode-grid,
  .server-form-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .zoom-controls {
    right: 0.55rem;
    left: 0.55rem;
    justify-content: center;
    border-radius: 18px;
  }

  .zoom-reset {
    padding-right: 0.7rem;
    padding-left: 0.7rem;
  }

  .leaderboard-row {
    grid-template-columns: auto 1fr;
  }

  .leaderboard-score {
    grid-column: 2;
    justify-items: start;
  }
}
</style>
