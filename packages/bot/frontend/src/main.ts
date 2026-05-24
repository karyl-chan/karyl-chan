import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { i18n } from "./i18n";
import "@karyl-chan/ui/tokens.css";
import "@karyl-chan/ui/reset.css";
import "@karyl-chan/ui/use-drawer.css";
import "@karyl-chan/ui/use-popover.css";
import "./styles/global.css";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";

createApp(App).use(createPinia()).use(router).use(i18n).mount("#app");
