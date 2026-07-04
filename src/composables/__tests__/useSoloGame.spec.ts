import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ref, shallowRef } from "vue";
import type { CountryPath, GamePhase } from "@/types/game";
import { useSoloGame } from "../useSoloGame";

const testCountries: CountryPath[] = [
  { id: "0-France", name: "France", path: "M0,0 1,0 1,1Z" },
  { id: "1-Japan", name: "Japan", path: "M2,0 3,0 3,1Z" },
  { id: "2-Brazil", name: "Brazil", path: "M4,0 5,0 5,1Z" },
];

const setup = () => {
  const countries = shallowRef<CountryPath[]>([...testCountries]);
  const gamePhase = ref<GamePhase>("setup");
  const errorMessage = ref("");
  const solo = useSoloGame(countries, gamePhase, errorMessage);

  return { countries, gamePhase, errorMessage, solo };
};

const wrongCountryFor = (current: CountryPath | null) =>
  testCountries.find((country) => country.id !== current?.id) as CountryPath;

describe("useSoloGame", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a game with round one and a prompted country", () => {
    const { solo, gamePhase } = setup();

    solo.roundCountSetting.value = 2;
    solo.startGame();

    expect(gamePhase.value).toBe("playing");
    expect(solo.totalRounds.value).toBe(2);
    expect(solo.soloCurrentRound.value).toBe(1);
    expect(solo.currentCountry.value).not.toBeNull();
    expect(solo.isRoundLocked.value).toBe(false);
    expect(solo.soloTimeLeft.value).toBe(10);
    expect(solo.soloRoundCountries.value).toHaveLength(1);
  });

  it("clamps the configured round count to the loaded country count", () => {
    const { solo } = setup();

    solo.roundCountSetting.value = 99;
    expect(solo.getConfiguredRoundCount()).toBe(testCountries.length);
    expect(solo.roundCountSetting.value).toBe(testCountries.length);

    solo.roundCountSetting.value = -3;
    expect(solo.getConfiguredRoundCount()).toBe(1);
  });

  it("scores a correct guess and advances after a short delay", () => {
    const { solo } = setup();

    solo.roundCountSetting.value = 2;
    solo.startGame();

    const country = solo.currentCountry.value as CountryPath;

    solo.handleGuess(country);

    expect(solo.soloPlayer.value.score).toBe(1);
    expect(solo.soloPlayer.value.streak).toBe(1);
    expect(solo.soloPlayer.value.attempts).toBe(1);
    expect(solo.answerState.value).toBe("correct");
    expect(solo.isRoundLocked.value).toBe(true);
    expect(solo.soloPlayer.value.roundPerformance).toEqual([{ round: 1, outcome: "correct" }]);

    vi.advanceTimersByTime(900);
    expect(solo.soloCurrentRound.value).toBe(2);
    expect(solo.isRoundLocked.value).toBe(false);
  });

  it("resets the streak on a wrong guess", () => {
    const { solo } = setup();

    solo.roundCountSetting.value = 2;
    solo.startGame();
    solo.handleGuess(solo.currentCountry.value as CountryPath);
    vi.advanceTimersByTime(900);

    solo.handleGuess(wrongCountryFor(solo.currentCountry.value));

    expect(solo.soloPlayer.value.score).toBe(1);
    expect(solo.soloPlayer.value.streak).toBe(0);
    expect(solo.answerState.value).toBe("incorrect");
    expect(solo.soloPlayer.value.roundPerformance).toEqual([
      { round: 1, outcome: "correct" },
      { round: 2, outcome: "incorrect" },
    ]);
  });

  it("records a skip and keeps the selection empty", () => {
    const { solo } = setup();

    solo.roundCountSetting.value = 1;
    solo.startGame();
    solo.skip();

    expect(solo.lastSelectedCountryId.value).toBeNull();
    expect(solo.answerState.value).toBe("incorrect");
    expect(solo.soloPlayer.value.roundPerformance).toEqual([{ round: 1, outcome: "skipped" }]);
  });

  it("times out after ten seconds and records a timeout", () => {
    const { solo } = setup();

    solo.roundCountSetting.value = 1;
    solo.startGame();

    vi.advanceTimersByTime(10_000);

    expect(solo.soloTimeLeft.value).toBe(0);
    expect(solo.isRoundLocked.value).toBe(true);
    expect(solo.soloPlayer.value.roundPerformance).toEqual([{ round: 1, outcome: "timeout" }]);
    expect(solo.feedbackMessage.value).toContain("Time's up!");
  });

  it("finishes the game after the last round", () => {
    const { solo, gamePhase } = setup();

    solo.roundCountSetting.value = 1;
    solo.startGame();
    solo.handleGuess(solo.currentCountry.value as CountryPath);
    vi.advanceTimersByTime(900);

    expect(gamePhase.value).toBe("results");
    expect(solo.currentCountry.value).toBeNull();
    expect(solo.feedbackMessage.value).toContain("Game over");
  });

  it("prompts a different country every round until the pool is exhausted", () => {
    const { solo } = setup();

    solo.roundCountSetting.value = 3;
    solo.startGame();

    const seenCountries: string[] = [];

    for (let round = 1; round <= 3; round += 1) {
      seenCountries.push(solo.currentCountry.value?.id ?? "");
      solo.handleGuess(solo.currentCountry.value as CountryPath);
      vi.advanceTimersByTime(900);
    }

    expect(new Set(seenCountries).size).toBe(3);
  });

  it("resets back to setup", () => {
    const { solo, gamePhase } = setup();

    solo.roundCountSetting.value = 2;
    solo.startGame();
    solo.resetToSetup();

    expect(gamePhase.value).toBe("setup");
    expect(solo.soloCurrentRound.value).toBe(0);
    expect(solo.currentCountry.value).toBeNull();
    expect(solo.feedbackMessage.value).toBe("Configure a game to begin.");
  });

  it("ignores guesses while the round is locked", () => {
    const { solo } = setup();

    solo.roundCountSetting.value = 2;
    solo.startGame();
    solo.handleGuess(solo.currentCountry.value as CountryPath);
    solo.handleGuess(solo.currentCountry.value as CountryPath);

    expect(solo.soloPlayer.value.attempts).toBe(1);
  });
});
