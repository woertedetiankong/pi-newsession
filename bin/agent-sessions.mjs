#!/usr/bin/env node
import { register } from "tsx/esm/api";
register();
try {
  const { run } = await import("../src/cli.ts");
  await run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
