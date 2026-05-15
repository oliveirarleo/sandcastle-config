#!/usr/bin/env tsx
/**
 * Cleanup script: strips all sandcastle:* labels from every issue.
 *
 * Usage: tsx .sandcastle/src/scripts/cleanup-labels.mts
 *        pnpm sandcastle:cleanup
 */

import { cleanupAllSandcastleLabels } from "../helpers/labels.mts";

await cleanupAllSandcastleLabels();
