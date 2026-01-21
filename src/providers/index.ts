/**
 * Content Providers
 *
 * This module exports all content providers and handles their registration.
 */

export { BaseProvider } from "./base";
export { providerRegistry, registerProvider, initializeProviders } from "./registry";
export { MediathekViewProvider, mediathekViewProvider } from "./mediathekview";

// Re-export types
export type {
  ContentProvider,
  ProviderCapabilities,
  ProviderContentItem,
  ProviderCountry,
  ProviderDownloadInfo,
  ProviderSearchQuery,
  ProviderStatus,
  ProviderConfig,
  AggregatedSearchResult,
  ProviderVideoUrls,
} from "@/types/provider";

// Register all providers
import { registerProvider } from "./registry";
import { mediathekViewProvider } from "./mediathekview";

// Auto-register providers on module load
registerProvider(mediathekViewProvider);

// Future providers will be registered here:
// import { srfProvider } from "./srf";
// import { orfProvider } from "./orf";
// registerProvider(srfProvider);
// registerProvider(orfProvider);
