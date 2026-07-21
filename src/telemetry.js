// Spec B F10 (Auto-Update and Telemetry) - F10-R8/R9/R11.
// PII rule (F10-R9, "MUST NOT include PII") is load-bearing: every call site
// in this file is restricted to the exact allowed field set
// { session_id, decision, platform, duration_s, app_version, tenant_id } -
// never pass through raw meeting titles/URLs/participant names here.
const { PostHog } = require('posthog-node');
const { app } = require('electron');

let client = null;

function initTelemetry(apiKey, enabled) {
  if (!enabled || !apiKey) {
    client = null;
    return;
  }
  client = new PostHog(apiKey, { host: 'https://us.i.posthog.com' });
}

function captureEvent(event, tenantId, props = {}) {
  if (!client) {
    return;
  }
  client.capture({
    distinctId: tenantId || 'unknown-tenant',
    event,
    properties: {
      app_version: app.getVersion(),
      tenant_id: tenantId,
      ...props,
    },
  });
}

async function shutdownTelemetry() {
  if (client) {
    await client.shutdown();
  }
}

module.exports = { initTelemetry, captureEvent, shutdownTelemetry };
