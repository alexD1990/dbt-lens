'use strict';

/**
 * Integrations dbt Lens tries to load, by folder name under src/integrations.
 * Each one is optional: if it is missing, broken or turned off, the canvas
 * works as before. See docs/ARCHITECTURE.md.
 */
module.exports = ['dagtracer'];
