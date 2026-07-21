// Spec B F10-R10: "Sentry crash reporter MUST be initialized with the
// SENTRY_DSN baked at build time." Main-process only for now (the renderer
// process isn't separately instrumented - a real follow-up, not silently
// assumed covered by this).
//
// Must be called as early as possible in main.js's execution (before other
// requires that could throw) so startup crashes are captured too - Sentry's
// own docs are explicit about this for Electron apps.
const Sentry = require('@sentry/electron/main');

function initCrashReporter() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // [UNVERIFIED - real gap, not faked] no SENTRY_DSN has been provisioned
    // anywhere in this build - same pattern as every other unbuilt-external-
    // credential gap this session. No-ops rather than initializing with a
    // fake/empty DSN.
    return;
  }
  Sentry.init({ dsn });
}

module.exports = { initCrashReporter };
