import { createRouter, createWebHistory } from "vue-router";
import HomeView from "@/views/HomeView.vue";
import CountryGameView from "@/views/CountryGameView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: HomeView },
    {
      path: "/country-game/multiplayer/:roomCode?",
      name: "country-game-multiplayer",
      component: CountryGameView,
    },
    // Also matches /country-game/solo; the game view derives its internal
    // state (setup / solo / multiplayer) from the current route.
    { path: "/country-game/:mode?", name: "country-game", component: CountryGameView },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

export default router;
