/**
 * Loads the pre-built country path data served from `/countries.paths.json`.
 * `countries` is a shallowRef because entries are only ever replaced
 * wholesale, never mutated in place — this avoids deep-reactivity overhead
 * on ~200 large path strings.
 */
import { ref, shallowRef } from "vue";
import type { CountryPath } from "@/types/game";

interface CountryPathPayload {
  countries?: Array<{
    id?: unknown;
    name?: unknown;
    path?: unknown;
  }>;
}

export const useCountriesData = () => {
  const countries = shallowRef<CountryPath[]>([]);
  const isLoading = ref(true);
  const errorMessage = ref("");

  const loadCountries = async () => {
    try {
      const response = await fetch("/countries.paths.json");

      if (!response.ok) {
        throw new Error(`Could not load the map (${response.status})`);
      }

      const data = (await response.json()) as CountryPathPayload;
      const loadedCountries = (data.countries ?? []).map((country, index) => {
        const rawName = typeof country.name === "string" ? country.name.trim() : "";
        const name = rawName || `Country ${index + 1}`;
        const rawId = typeof country.id === "string" ? country.id.trim() : "";
        const id = rawId || `${index}-${name}`;
        const path = typeof country.path === "string" ? country.path : "";

        return { id, name, path };
      });
      const countriesWithoutGeometry = loadedCountries.filter(
        (country) => country.path.length === 0,
      );

      if (loadedCountries.length === 0) {
        throw new Error("No country data was found in the map data.");
      }

      if (countriesWithoutGeometry.length > 0) {
        throw new Error(
          `${countriesWithoutGeometry.length} countries are missing playable map geometry.`,
        );
      }

      countries.value = loadedCountries;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : "Could not load the map.";
    } finally {
      isLoading.value = false;
    }
  };

  return { countries, isLoading, errorMessage, loadCountries };
};
