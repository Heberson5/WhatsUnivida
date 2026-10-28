import { config } from "dotenv";
import path from "node:path";

// Loaded before any test module (including src/config/env.ts) reads process.env.
config({ path: path.resolve(__dirname, "../.env.test") });
