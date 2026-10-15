// Forwards keyboard and mouse events to Beekeeper Studio, so app shortcuts
// keep working while the plugin has focus.
import "@beekeeperstudio/plugin/dist/eventForwarder";
import { createApp } from "vue";
import App from "./App.vue";
import { host } from "./host/host";
import { applyTheme } from "./host/theme";
import "./styles/app.css";

void host.appInfo().then((info) => applyTheme(info?.theme));
host.onThemeChange(applyTheme);

createApp(App).mount("#app");
