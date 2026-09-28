import { config } from "zod";

// Run before importing protocol schemas: the dashboard CSP forbids dynamic code.
config({ jitless: true });
