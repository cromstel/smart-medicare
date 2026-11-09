/**
 * Feature flags — centralized configuration for optional features.
 *
 * Feature flags are read from environment variables with the `FEATURE_` prefix.
 * In the browser bundle, Vite exposes `import.meta.env.FEATURE_*` variables.
 * In Node.js (Vite config, Playwright, scripts), they are read from `process.env`.
 *
 * All feature flags are boolean and default to `false` if not explicitly set.
 * To enable a feature, set the corresponding `FEATURE_*` environment variable to `true`.
 */

type FeatureFlagKey =
  | 'AI_ASSISTANT'
  | 'TELEMEDICINE'
  | 'PATIENT_PORTAL'
  | 'EMERGENCY_BOARD'
  | 'PHARMACY'
  | 'INVENTORY'
  | 'FINANCIAL'
  | 'AUDIT_LOGS'
  | 'BACKUP';

type FeatureFlags = Record<FeatureFlagKey, boolean>;

/**
 * Reads a feature flag from the environment.
 * Vite exposes `FEATURE_*` variables on `import.meta.env` (browser bundle).
 * Node.js scripts read from `process.env`.
 */
const readFlag = (key: FeatureFlagKey): boolean => {
  // Browser bundle (and Vitest): Vite resolves `import.meta.env` for us.
  const viteValue = import.meta.env?.[`FEATURE_${key}`];
  if (typeof viteValue === 'string') {
    return viteValue === 'true';
  }

  // Node.js: the Vite config bundle, the Playwright suite, scripts.
  if (typeof process !== 'undefined' && process.env) {
    const envValue = process.env[`FEATURE_${key}`];
    if (typeof envValue === 'string') {
      return envValue === 'true';
    }
  }

  return false;
};

/** All feature flags, resolved at module evaluation time. */
export const FEATURES: FeatureFlags = {
  AI_ASSISTANT: readFlag('AI_ASSISTANT'),
  TELEMEDICINE: readFlag('TELEMEDICINE'),
  PATIENT_PORTAL: readFlag('PATIENT_PORTAL'),
  EMERGENCY_BOARD: readFlag('EMERGENCY_BOARD'),
  PHARMACY: readFlag('PHARMACY'),
  INVENTORY: readFlag('INVENTORY'),
  FINANCIAL: readFlag('FINANCIAL'),
  AUDIT_LOGS: readFlag('AUDIT_LOGS'),
  BACKUP: readFlag('BACKUP'),
} as const;

/** Type for a single feature flag value. */
export type FeatureFlagValue = boolean;

/** Checks if a feature is enabled. */
export const isFeatureEnabled = (key: FeatureFlagKey): boolean =>
  FEATURES[key];

