/**
 * Content Providers
 *
 * This module exports all content providers and handles their registration.
 */

export { BaseProvider } from "./base";
export { providerRegistry, registerProvider, initializeProviders } from "./registry";
export { MediathekViewProvider, mediathekViewProvider } from "./mediathekview";
export { SrfProvider, srfProvider } from "./srf";

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
import { srfProvider } from "./srf";

// Auto-register providers on module load
registerProvider(mediathekViewProvider);
registerProvider(srfProvider);

// Future providers will be registered here:
// import { orfProvider } from "./orf";
// registerProvider(orfProvider);
