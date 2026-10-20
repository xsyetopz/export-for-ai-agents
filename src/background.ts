/** Service worker: wires the capture gate (gate.ts) to the real chrome APIs. */

import { createGate } from "./gate.ts";

createGate(chrome as never).install();
