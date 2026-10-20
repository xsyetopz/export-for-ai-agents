/** Content script, injected with scripting.executeScript({ files }). */

import { installContentScript } from "./content-script.ts";

installContentScript({
  runtime: chrome.runtime as never,
  document,
  url: () => location.href,
});
