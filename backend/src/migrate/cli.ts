/*
 * Migration CLI runnable shim.
 *
 * `index.ts` keeps `main` side-effect free so tests can import it; this file
 * is the entry the `migrate` script points at: it invokes `main` and exits
 * with the returned code (1 on an unexpected rejection).
 */
import { main } from "./index";

main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(1));
