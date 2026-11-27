// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect()
// and delegates to the SfBayApp (src/app.js). Read-only: nothing is ever
// commanded, the 511 SF Bay Open Data API is only read.
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { SfBayApp } from './src/app.js';
import { ACTIONS } from './src/constants.js';

const gladys = new GladysIntegration();
const app = new SfBayApp({ gladys, logger });

// --- Discovery: the stops of the configuration, never a read -------------------
gladys.onScanRequest(() => app.scan());

// --- Configuration screen button ------------------------------------------------
// What the last reads gave and the quota used; it never reads (the quota).
gladys.onAction(ACTIONS.TEST, () => app.testConnection());

// --- Configuration saved by the user ---------------------------------------------
// A saved token is tried once even if one was refused before a restart.
gladys.onConfigUpdated((config) => {
  logger.info('Configuration updated');
  return app.start(config, { saved: true });
});

// --- Connection lifecycle --------------------------------------------------------
// Every connection reads the configuration (retried forever when Gladys fails
// to give it) and restarts; a reconnection never reads 511 sooner than the
// interval nor beyond the quota (both kept in /data).
gladys.on('connected', () => {
  app.connected().catch((err) => logger.error(`Start failed (${err?.name ?? 'Error'})`));
});
gladys.on('disconnected', () => {
  app.disconnected().catch((err) => logger.error(`Stop failed (${err?.name ?? 'Error'})`));
});
gladys.handleShutdown(() => app.stop());

logger.info('Starting the SF Bay Area transit integration...');
gladys.connect().catch((err) => {
  logger.error(`Initial connection failed (${err?.name ?? 'Error'})`);
  process.exit(1);
});
