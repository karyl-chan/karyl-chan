import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { i18n } from "./i18n";
// CSS load order is the cascade. Earlier imports lose to later ones,
// so third-party + shared styles come first; bot-local global.css
// has the last say.
import "@karyl-chan/ui/tokens.css";
import "@karyl-chan/ui/reset.css";
import "@karyl-chan/ui/use-drawer.css";
import "@karyl-chan/ui/use-popover.css";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import "./styles/global.css";

createApp(App).use(createPinia()).use(router).use(i18n).mount("#app");
