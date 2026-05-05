/**
 * Web Fetch Special Handlers Index
 *
 * Exports all special handlers for site-specific content extraction.
 */
import { handleChooseALicense } from "./choosealicense";
import { handleCisaKev } from "./cisa-kev";
import { handleClojars } from "./clojars";
import { handleCrossref } from "./crossref";
import { handleDiscourse } from "./discourse";
import { handleDocsRs } from "./docs-rs";
import { handleFdroid } from "./fdroid";
import { handleFirefoxAddons } from "./firefox-addons";
import { handleFlathub } from "./flathub";
import { handleHuggingFace } from "./huggingface";
import { handleJetBrainsMarketplace } from "./jetbrains-marketplace";
import { handleLemmy } from "./lemmy";
import { handleMusicBrainz } from "./musicbrainz";
import { handleOllama } from "./ollama";
import { handleOpenVsx } from "./open-vsx";
import { handleOrcid } from "./orcid";
import { handleRawg } from "./rawg";
import { handleSearchcode } from "./searchcode";
import { handleSnapcraft } from "./snapcraft";
import { handleSourcegraph } from "./sourcegraph";
import { handleSpdx } from "./spdx";
import { handleSpotify } from "./spotify";
import type { SpecialHandler } from "./types";
import { handleVimeo } from "./vimeo";
import { handleVscodeMarketplace } from "./vscode-marketplace";
import { handleW3c } from "./w3c";

export type { RenderResult, SpecialHandler } from "./types";

export {
	handleChooseALicense,
	handleCisaKev,
	handleClojars,
	handleCrossref,
	handleDiscourse,
	handleDocsRs,
	handleFdroid,
	handleFirefoxAddons,
	handleFlathub,
	handleHuggingFace,
	handleJetBrainsMarketplace,
	handleLemmy,
	handleMusicBrainz,
	handleOllama,
	handleOpenVsx,
	handleOrcid,
	handleRawg,
	handleSearchcode,
	handleSnapcraft,
	handleSourcegraph,
	handleSpdx,
	handleSpotify,
	handleVimeo,
	handleVscodeMarketplace,
	handleW3c,
};

export const specialHandlers: SpecialHandler[] = [
	// Video/Media
	handleVimeo,
	handleSpotify,
	handleMusicBrainz,
	// Games
	handleRawg,
	// Social/News
	handleLemmy,
	handleDiscourse,
	// Developer content
	handleDocsRs,
	handleSearchcode,
	handleSourcegraph,
	// Package registries
	handleFirefoxAddons,
	handleVscodeMarketplace,
	handleClojars,
	handleFdroid,
	handleFlathub,
	handleJetBrainsMarketplace,
	handleOpenVsx,
	handleSnapcraft,
	// ML/AI
	handleHuggingFace,
	handleOllama,
	// Academic
	handleCrossref,
	handleOrcid,
	// Security
	handleCisaKev,
	// Reference
	handleChooseALicense,
	handleW3c,
	handleSpdx,
];
