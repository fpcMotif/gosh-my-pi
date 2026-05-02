/**
 * Discogs URL handler for music releases and masters
 *
 * Uses the Discogs API to extract structured metadata about releases.
 * API docs: https://www.discogs.com/developers
 */

import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage } from "./types";

interface DiscogsArtist {
	name: string;
	anv?: string; // artist name variation
	role?: string;
	join?: string;
}

interface DiscogsTrack {
	position: string;
	title: string;
	duration?: string;
	artists?: DiscogsArtist[];
	extraartists?: DiscogsArtist[];
}

interface DiscogsLabel {
	name: string;
	catno?: string; // catalog number
}

interface DiscogsFormat {
	name: string;
	qty?: string;
	descriptions?: string[];
}

interface DiscogsRelease {
	id: number;
	title: string;
	artists?: DiscogsArtist[];
	year?: number;
	released?: string;
	country?: string;
	genres?: string[];
	styles?: string[];
	labels?: DiscogsLabel[];
	formats?: DiscogsFormat[];
	tracklist?: DiscogsTrack[];
	extraartists?: DiscogsArtist[];
	notes?: string;
	uri?: string;
	master_id?: number;
	master_url?: string;
}

interface DiscogsMaster {
	id: number;
	title: string;
	artists?: DiscogsArtist[];
	year?: number;
	genres?: string[];
	styles?: string[];
	tracklist?: DiscogsTrack[];
	notes?: string;
	uri?: string;
	main_release?: number;
	main_release_url?: string;
	versions_url?: string;
	num_for_sale?: number;
	lowest_price?: number;
}

/**
 * Format artist names, handling name variations
 */
function formatArtists(artists: DiscogsArtist[] | undefined): string {
	if (artists?.length === null || artists?.length === undefined || artists?.length === 0) return "Unknown Artist";
	return artists
		.map(a => {
			const name = a.anv ?? a.name;
			const join = a.join ?? ", ";
			return name + (a.join !== null && a.join !== undefined && a.join !== "" ? ` ${join} ` : "");
		})
		.join("")
		.replace(/[,&]\s*$/, "")
		.trim();
}

/**
 * Format a single track
 */
function formatTrack(track: DiscogsTrack): string {
	let line = track.position ? `${track.position}. ` : "- ";
	line += track.title;
	if (track.duration !== null && track.duration !== undefined && track.duration !== "") line += ` (${track.duration})`;
	if (track.artists?.length !== null && track.artists?.length !== undefined && track.artists?.length !== 0) {
		line += ` - ${formatArtists(track.artists)}`;
	}
	return line;
}

/**
 * Format credits/extraartists grouped by role
 */
function formatCredits(extraartists: DiscogsArtist[] | undefined): string {
	if (extraartists?.length === null || extraartists?.length === undefined || extraartists?.length === 0) return "";

	const byRole: Record<string, string[]> = {};
	for (const artist of extraartists) {
		const role = artist.role ?? "Other";
		if (byRole[role] === null || byRole[role] === undefined) byRole[role] = [];
		byRole[role].push(artist.anv ?? artist.name);
	}

	const lines: string[] = [];
	for (const [role, names] of Object.entries(byRole)) {
		lines.push(`- **${role}**: ${names.join(", ")}`);
	}
	return lines.join("\n");
}

/**
 * Format formats (e.g., "2×LP, Album, Reissue")
 */
function formatFormats(formats: DiscogsFormat[] | undefined): string {
	if (formats?.length === null || formats?.length === undefined || formats?.length === 0) return "";

	return formats
		.map(f => {
			const parts: string[] = [];
			if (f.qty !== null && f.qty !== undefined && f.qty !== "" && parseInt(f.qty, 10) > 1) parts.push(`${f.qty}×`);
			parts.push(f.name);
			if (f.descriptions?.length !== null && f.descriptions?.length !== undefined && f.descriptions?.length !== 0)
				parts.push(f.descriptions.join(", "));
			return parts.join(" ");
		})
		.join(" + ");
}

/**
 * Format labels with catalog numbers
 */
function formatLabels(labels: DiscogsLabel[] | undefined): string {
	if (labels?.length === null || labels?.length === undefined || labels?.length === 0) return "";
	return labels
		.map(l => {
			if (l.catno !== null && l.catno !== undefined && l.catno !== "" && l.catno !== "none")
				return `${l.name} (${l.catno})`;
			return l.name;
		})
		.join(", ");
}

/**
 * Build markdown for a release
 */
function buildReleaseMarkdown(release: DiscogsRelease): string {
	const sections: string[] = [];

	// Title with artist
	const artist = formatArtists(release.artists);
	sections.push(`# ${artist} - ${release.title}\n`);

	// Metadata
	const meta: string[] = [];
	if (release.year !== null && release.year !== undefined && release.year !== 0)
		meta.push(`**Year**: ${release.year}`);
	if (release.country !== null && release.country !== undefined && release.country !== "")
		meta.push(`**Country**: ${release.country}`);

	const format = formatFormats(release.formats);
	if (format) meta.push(`**Format**: ${format}`);

	const labels = formatLabels(release.labels);
	if (labels) meta.push(`**Label**: ${labels}`);

	if (release.genres?.length !== null && release.genres?.length !== undefined && release.genres?.length !== 0)
		meta.push(`**Genre**: ${release.genres.join(", ")}`);
	if (release.styles?.length !== null && release.styles?.length !== undefined && release.styles?.length !== 0)
		meta.push(`**Style**: ${release.styles.join(", ")}`);

	if (release.master_id !== null && release.master_id !== undefined && release.master_id !== 0) {
		meta.push(`**Master Release**: [${release.master_id}](https://www.discogs.com/master/${release.master_id})`);
	}

	if (meta.length) sections.push(`${meta.join("\n")}\n`);

	// Tracklist
	if (
		release.tracklist?.length !== null &&
		release.tracklist?.length !== undefined &&
		release.tracklist?.length !== 0
	) {
		sections.push("## Tracklist\n");
		const tracks = release.tracklist.map(formatTrack);
		sections.push(`${tracks.join("\n")}\n`);
	}

	// Credits
	const credits = formatCredits(release.extraartists);
	if (credits) {
		sections.push("## Credits\n");
		sections.push(`${credits}\n`);
	}

	// Notes
	if (release.notes !== null && release.notes !== undefined && release.notes !== "") {
		sections.push("## Notes\n");
		sections.push(`${release.notes}\n`);
	}

	return sections.join("\n");
}

/**
 * Build markdown for a master release
 */
function buildMasterMarkdown(master: DiscogsMaster): string {
	const sections: string[] = [];

	// Title with artist
	const artist = formatArtists(master.artists);
	sections.push(`# ${artist} - ${master.title}\n`);
	sections.push("*Master Release*\n");

	// Metadata
	const meta: string[] = [];
	if (master.year !== null && master.year !== undefined && master.year !== 0) meta.push(`**Year**: ${master.year}`);
	if (master.genres?.length !== null && master.genres?.length !== undefined && master.genres?.length !== 0)
		meta.push(`**Genre**: ${master.genres.join(", ")}`);
	if (master.styles?.length !== null && master.styles?.length !== undefined && master.styles?.length !== 0)
		meta.push(`**Style**: ${master.styles.join(", ")}`);

	if (master.main_release !== null && master.main_release !== undefined && master.main_release !== 0) {
		meta.push(`**Main Release**: [${master.main_release}](https://www.discogs.com/release/${master.main_release})`);
	}

	if (master.num_for_sale !== undefined && master.num_for_sale > 0) {
		meta.push(`**For Sale**: ${master.num_for_sale} copies`);
		if (master.lowest_price !== undefined) {
			meta.push(`**Lowest Price**: $${master.lowest_price.toFixed(2)}`);
		}
	}

	if (meta.length) sections.push(`${meta.join("\n")}\n`);

	// Tracklist
	if (master.tracklist?.length !== null && master.tracklist?.length !== undefined && master.tracklist?.length !== 0) {
		sections.push("## Tracklist\n");
		const tracks = master.tracklist.map(formatTrack);
		sections.push(`${tracks.join("\n")}\n`);
	}

	// Notes
	if (master.notes !== null && master.notes !== undefined && master.notes !== "") {
		sections.push("## Notes\n");
		sections.push(`${master.notes}\n`);
	}

	return sections.join("\n");
}

export const handleDiscogs: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.includes("discogs.com")) return null;

		// Match release or master URLs
		// Patterns: /release/{id}, /master/{id}
		// Also handles: /release/{id}-Artist-Title, /master/{id}-Artist-Title
		const releaseMatch = parsed.pathname.match(/\/release\/(\d+)/);
		const masterMatch = parsed.pathname.match(/\/master\/(\d+)/);

		if (!releaseMatch && !masterMatch) return null;

		const fetchedAt = new Date().toISOString();
		const isRelease = !!releaseMatch;
		const id = isRelease ? releaseMatch[1] : masterMatch![1];

		const apiUrl = isRelease ? `https://api.discogs.com/releases/${id}` : `https://api.discogs.com/masters/${id}`;

		const result = await loadPage(apiUrl, {
			timeout,
			signal,
			headers: {
				Accept: "application/json",
				"User-Agent": "CodingAgent/1.0 +https://github.com/can1357/oh-my-pi",
			},
		});

		if (!result.ok) return null;

		let md: string;
		if (isRelease) {
			const release = tryParseJson<DiscogsRelease>(result.content);
			if (!release) return null;
			md = buildReleaseMarkdown(release);
		} else {
			const master = tryParseJson<DiscogsMaster>(result.content);
			if (!master) return null;
			md = buildMasterMarkdown(master);
		}

		return buildResult(md, {
			url,
			method: "discogs",
			fetchedAt,
			notes: [`Fetched via Discogs API (${isRelease ? "release" : "master"})`],
		});
	} catch {}

	return null;
};
